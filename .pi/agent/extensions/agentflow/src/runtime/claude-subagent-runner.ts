import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMarkdownImports } from "../../../../lib/markdown-imports.ts";
import {
  buildClaudeUserPrompt,
  loadProjectAgentsContext,
  stageClaudeSkills,
  type ClaudeSkill,
} from "../claude/resources.ts";
import type { AgentNodeSpec, ChildExecutionResult, UsageSnapshot } from "../types.ts";
import { RunStore } from "../state/run-store.ts";
import { finishToolCallSnapshot, startToolCallSnapshot } from "./tool-call-snapshots.ts";

const CLAUDE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "Skill",
];
const AUTO_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Skill"];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 500;
const MAX_TURNS = 50;
const MAX_OUTPUT = 100_000;
const promptPath = fileURLToPath(new URL("../claude/prompts/system.md", import.meta.url));
const agentDir = resolve(dirname(promptPath), "../../../../..");

export type ClaudeQueryFactory = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => ClaudeQuery;

const emptyUsage = (): UsageSnapshot => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
});
const abortError = () => new DOMException("Claude child aborted", "AbortError");
const bounded = (value: string, max = MAX_OUTPUT): string => value.slice(-max);

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function usageSnapshot(usage: SDKResultMessage["usage"], cost: number): UsageSnapshot {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost,
  };
}

function assistantUsage(message: Extract<SDKMessage, { type: "assistant" }>): UsageSnapshot {
  const usage = message.message.usage;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost: 0,
  };
}

function addUsage(target: UsageSnapshot, addition: UsageSnapshot): void {
  target.input += addition.input;
  target.output += addition.output;
  target.cacheRead += addition.cacheRead;
  target.cacheWrite += addition.cacheWrite;
  target.total += addition.total;
}

function buildClaudeEnvironment(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const names = [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "CLAUDE_CONFIG_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ];
  const env = Object.fromEntries(
    names.flatMap((name) => (source[name] ? [[name, source[name]]] : [])),
  );
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "pi-agentflow";
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = "false";
  return env;
}

async function closeQueryBounded(query: ClaudeQuery, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => query.close()),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, timeoutMs);
      }),
    ]).catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resultError(result: Exclude<SDKResultMessage, { subtype: "success" }>): Error {
  const details = result.errors.filter(Boolean).join("; ");
  const reason = result.terminal_reason ? ` (${result.terminal_reason})` : "";
  return new Error(
    bounded(
      `Claude query failed: ${result.subtype}${reason}${details ? `: ${details}` : ""}`,
      4_000,
    ),
  );
}

export class ClaudeSubagentRunner {
  private promptPromise: Promise<string> | undefined;

  constructor(
    private readonly store: RunStore,
    private readonly getSkills: () => readonly ClaudeSkill[],
    private readonly queryFactory: ClaudeQueryFactory = claudeQuery,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  private compileSystemPrompt(activeSkillsIndex: string): Promise<string> {
    this.promptPromise ??= compileMarkdownImports({
      rootPath: promptPath,
      allowedRoots: [agentDir],
    })
      .then(({ text }) => text)
      .catch((error) => {
        this.promptPromise = undefined;
        throw error;
      });
    return this.promptPromise.then((text) => {
      const placeholder = "${activeSkillsIndex}";
      if (text.split(placeholder).length !== 2)
        throw new Error("Controlled Claude prompt must contain activeSkillsIndex exactly once");
      return text.replace(placeholder, () => activeSkillsIndex);
    });
  }

  async run(
    runId: string,
    node: AgentNodeSpec,
    ctx: ExtensionContext,
    parentSignal: AbortSignal,
  ): Promise<ChildExecutionResult> {
    const skills = await stageClaudeSkills(this.getSkills());
    let query: ClaudeQuery | undefined;
    let closePromise: Promise<void> | undefined;
    let acceptEvents = true;
    const controller = new AbortController();
    const close = (): Promise<void> =>
      (closePromise ??= (async () => {
        controller.abort();
        if (query) await closeQueryBounded(query);
      })());
    const onAbort = () => void close();
    parentSignal.addEventListener("abort", onAbort, { once: true });

    try {
      if (parentSignal.aborted) throw abortError();
      const [systemPrompt, projectContext] = await Promise.all([
        this.compileSystemPrompt(skills.index),
        loadProjectAgentsContext(ctx.cwd),
      ]);
      if (parentSignal.aborted) throw abortError();

      const options: ClaudeQueryOptions = {
        cwd: ctx.cwd,
        model: node.config?.model ?? "opus",
        systemPrompt,
        tools: CLAUDE_TOOLS,
        allowedTools: AUTO_ALLOWED_TOOLS,
        disallowedTools: ["Agent", "AskUserQuestion"],
        permissionMode: "auto",
        settingSources: [],
        settings: {
          disableAllHooks: true,
          autoMemoryEnabled: false,
          disableClaudeAiConnectors: true,
          disableBundledSkills: true,
          disableSkillShellExecution: true,
          enabledPlugins: {},
        },
        hooks: {},
        plugins: [],
        mcpServers: {},
        strictMcpConfig: true,
        additionalDirectories: [skills.root],
        skills: skills.names,
        persistSession: false,
        includePartialMessages: true,
        maxTurns: MAX_TURNS,
        abortController: controller,
        env: buildClaudeEnvironment(this.environment),
      };
      query = this.queryFactory({
        prompt: buildClaudeUserPrompt(node.prompt, projectContext),
        options,
      });
      if (!this.store.attachControl(runId, node.id, { abort: close })) throw abortError();

      const usage = emptyUsage();
      const updateNode = (mutate: Parameters<RunStore["updateNode"]>[2]): void => {
        if (acceptEvents) this.store.updateNode(runId, node.id, mutate);
      };
      const seenUsage = new Set<string>();
      const startedTools = new Set<string>();
      const assistantTexts: string[] = [];
      let terminal: SDKResultMessage | undefined;

      const consume = async (): Promise<void> => {
        for await (const message of query!) {
          if (parentSignal.aborted) throw abortError();
          if (message.type === "stream_event") {
            const event = message.event as unknown as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta")
              updateNode((snapshot) => {
                snapshot.resultPreview = bounded(
                  `${snapshot.resultPreview ?? ""}${event.delta!.text ?? ""}`,
                  500,
                );
              });
            continue;
          }
          if (message.type === "assistant") {
            const text = textBlocks(message.message.content);
            if (text) assistantTexts.push(text);
            if (!seenUsage.has(message.message.id)) {
              seenUsage.add(message.message.id);
              addUsage(usage, assistantUsage(message));
            }
            for (const block of message.message.content) {
              if (block.type !== "tool_use" || startedTools.has(block.id)) continue;
              startedTools.add(block.id);
              updateNode((snapshot) =>
                startToolCallSnapshot(snapshot, {
                  id: block.id,
                  name: block.name,
                  args: block.input,
                }),
              );
            }
            updateNode((snapshot) => {
              snapshot.usage = { ...usage };
              if (text) snapshot.resultPreview = bounded(text, 500);
            });
            continue;
          }
          if (message.type === "user") {
            const content = message.message.content;
            if (Array.isArray(content))
              for (const block of content) {
                if (block.type !== "tool_result") continue;
                updateNode((snapshot) =>
                  finishToolCallSnapshot(snapshot, {
                    id: block.tool_use_id,
                    result: Array.isArray(block.content)
                      ? { content: block.content }
                      : block.content,
                    isError: block.is_error === true,
                  }),
                );
              }
            continue;
          }
          if (message.type === "result") {
            terminal = message;
            const finalUsage = usageSnapshot(message.usage, message.total_cost_usd);
            updateNode((snapshot) => {
              snapshot.usage = finalUsage;
              if (message.subtype === "success")
                snapshot.resultPreview = bounded(message.result, 500);
            });
          }
        }
      };

      const timeoutMs = node.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          consume(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Claude child deadline exceeded after ${timeoutMs}ms`));
              void close();
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (parentSignal.aborted) throw abortError();
      if (!terminal) throw new Error("Claude query ended without a result message");
      if (terminal.subtype !== "success") throw resultError(terminal);
      return {
        text: bounded(terminal.result || assistantTexts.join("\n")),
        usage: usageSnapshot(terminal.usage, terminal.total_cost_usd),
      };
    } finally {
      acceptEvents = false;
      parentSignal.removeEventListener("abort", onAbort);
      this.store.detachControl(runId, node.id);
      await close();
      await skills.cleanup();
    }
  }
}
