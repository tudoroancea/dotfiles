import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type, type TSchema } from "typebox";
import type { AgentNodeSpec, ChildExecutionResult, UsageSnapshot } from "../types.ts";
import { RunStore } from "../state/run-store.ts";
import { finishToolCallSnapshot, startToolCallSnapshot } from "./tool-call-snapshots.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are a delegated child agent. Complete only the assigned task. Return a precise result. Never start subagents/workflows or ask the user questions.";
const USER_INTERACTION_TOOLS = new Set(["ask_user", "question", "questionnaire"]);
export const isDeniedChildTool = (name: string): boolean =>
  name.startsWith("agentflow_") || USER_INTERACTION_TOOLS.has(name);
const MAX_OUTPUT = 100_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const textOf = (messages: AgentMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (text) return text.slice(-MAX_OUTPUT);
    }
  }
  return "";
};
const abortError = () => new DOMException("Subagent aborted", "AbortError");
const execFileAsync = promisify(execFile);
const gitInspectTool = (cwd: string) =>
  defineTool({
    name: "git_inspect",
    label: "Git Inspect",
    description: "Run bounded read-only git status, diff, log, or show inspection.",
    parameters: Type.Object(
      {
        action: StringEnum(["status", "diff", "log", "show"] as const),
        base: Type.Optional(Type.String()),
        paths: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      if (
        params.base &&
        (params.base.startsWith("-") || !/^[A-Za-z0-9._~^/@{}:+-]+$/.test(params.base))
      )
        throw new Error("Invalid git revision");
      const args =
        params.action === "status"
          ? ["status", "--short"]
          : params.action === "log"
            ? ["log", "--oneline", "--decorate", "-n", "30"]
            : params.action === "show"
              ? ["show", "--no-ext-diff", "--stat", "--oneline", params.base || "HEAD"]
              : [
                  "diff",
                  "--no-ext-diff",
                  ...(params.base ? [params.base] : []),
                  "--",
                  ...(params.paths ?? []),
                ];
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        signal,
        timeout: 30_000,
        maxBuffer: 1_000_000,
      });
      return {
        content: [{ type: "text" as const, text: `${stdout}${stderr}`.slice(0, 100_000) }],
        details: { action: params.action },
      };
    },
  });

export class SubagentRunner {
  constructor(
    private readonly store: RunStore,
    private readonly getInheritedTools: () => string[],
    private readonly getInheritedThinking: () => ThinkingLevel | undefined,
  ) {}
  async run(
    runId: string,
    node: AgentNodeSpec,
    ctx: ExtensionContext,
    parentSignal: AbortSignal,
  ): Promise<ChildExecutionResult> {
    const config = node.config ?? {};
    const cwd = config.cwd ?? ctx.cwd;
    const sameCwd = resolve(cwd) === resolve(ctx.cwd);
    const projectTrusted = sameCwd ? ctx.isProjectTrusted() : config.trustProject === true;
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: config.extensions !== undefined,
      additionalExtensionPaths: Array.isArray(config.extensions) ? config.extensions : undefined,
      noSkills: config.skills !== undefined,
      additionalSkillPaths: Array.isArray(config.skills) ? config.skills : undefined,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: config.session?.inheritParentContext === false,
      systemPromptOverride: config.usePiSystemPrompt
        ? undefined
        : () => config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
      appendSystemPromptOverride: config.appendSystemPrompt
        ? () => [config.appendSystemPrompt!.trim()]
        : config.usePiSystemPrompt
          ? undefined
          : () => [],
    });
    await loader.reload({ resolveProjectTrust: async () => projectTrusted });
    if (parentSignal.aborted) throw abortError();
    const mode = config.session?.mode ?? "memory";
    const sessionManager =
      mode === "existing"
        ? config.session?.file
          ? SessionManager.open(config.session.file)
          : (() => {
              throw new Error("session.file is required for existing mode");
            })()
        : mode === "file"
          ? SessionManager.create(cwd)
          : SessionManager.inMemory(cwd);
    if (config.session?.name) sessionManager.appendSessionInfo(config.session.name);
    const requestedToolNames = Array.isArray(config.tools) ? config.tools : [];
    let structuredValue: unknown;
    const customTools = [
      ...(requestedToolNames.includes("git_inspect") ? [gitInspectTool(cwd)] : []),
      ...(config.outputSchema
        ? [
            defineTool({
              name: "structured_output",
              label: "Structured Output",
              description: "Submit the final schema-conformant result.",
              parameters: config.outputSchema as TSchema,
              async execute(_id, params) {
                structuredValue = structuredClone(params);
                return {
                  content: [{ type: "text" as const, text: "Captured." }],
                  details: structuredValue,
                  terminate: true,
                };
              },
            }),
          ]
        : []),
    ];
    let model = ctx.model;
    let thinking = (config.thinking ?? this.getInheritedThinking()) as ThinkingLevel | undefined;
    if (config.model) {
      const resolved = resolveCliModel({
        cliModel: config.model,
        cliThinking: thinking,
        modelRegistry: ctx.modelRegistry,
      });
      if (resolved.error || !resolved.model)
        throw new Error(resolved.error ?? `Model not found: ${config.model}`);
      model = resolved.model;
      thinking = resolved.thinkingLevel ?? thinking;
    }
    const inheritedTools = this.getInheritedTools();
    const inherited = inheritedTools.filter((name) => !isDeniedChildTool(name));
    const requested = requestedToolNames;
    const tools =
      config.tools === false
        ? config.outputSchema
          ? ["structured_output"]
          : []
        : Array.isArray(config.tools)
          ? [
              ...requested.filter((name) => !isDeniedChildTool(name)),
              ...(config.outputSchema ? ["structured_output"] : []),
            ]
          : [...inherited, ...(config.outputSchema ? ["structured_output"] : [])];
    const deniedTools = [...new Set([...inheritedTools, ...requested])].filter(isDeniedChildTool);
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      model,
      modelRegistry: ctx.modelRegistry,
      thinkingLevel: thinking,
      tools,
      noTools: config.tools === false ? "all" : undefined,
      excludeTools: deniedTools,
      customTools,
    });
    if (parentSignal.aborted) {
      session.dispose();
      throw abortError();
    }
    if (extensionsResult.extensions.length)
      await session.bindExtensions({ mode: "print", abortHandler: () => void session.abort() });
    if (!this.store.attachSession(runId, node.id, session)) {
      session.dispose();
      throw abortError();
    }
    this.store.updateNode(runId, node.id, (n) => {
      n.sessionFile = session.sessionFile;
    });
    const messages: AgentMessage[] = [];
    const usage: UsageSnapshot = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
    };
    const toolTimers = new Map<string, NodeJS.Timeout>();
    let toolTimeoutError: Error | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end") {
        messages.push(event.message);
        if (event.message.role === "assistant") {
          const u = event.message.usage;
          usage.input += u.input ?? 0;
          usage.output += u.output ?? 0;
          usage.cacheRead += u.cacheRead ?? 0;
          usage.cacheWrite += u.cacheWrite ?? 0;
          usage.total += u.totalTokens ?? 0;
          usage.cost += u.cost?.total ?? 0;
          this.store.updateNode(runId, node.id, (n) => {
            n.usage = { ...usage };
            n.resultPreview = textOf(messages).slice(-500);
          });
        }
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const delta = event.assistantMessageEvent.delta;
        this.store.updateNode(runId, node.id, (n) => {
          n.resultPreview = `${n.resultPreview ?? ""}${delta}`.slice(-500);
        });
      } else if (event.type === "tool_execution_start") {
        this.store.updateNode(runId, node.id, (n) => {
          startToolCallSnapshot(n, {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
          });
        });
        {
          const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
          toolTimers.set(
            event.toolCallId,
            setTimeout(() => {
              toolTimeoutError = new Error(
                `Child tool ${event.toolName} timed out after ${toolTimeoutMs}ms`,
              );
              void session.abort().catch(() => undefined);
            }, toolTimeoutMs),
          );
        }
      } else if (event.type === "tool_execution_end") {
        const timer = toolTimers.get(event.toolCallId);
        if (timer) clearTimeout(timer);
        toolTimers.delete(event.toolCallId);
        this.store.updateNode(runId, node.id, (n) => {
          finishToolCallSnapshot(n, {
            id: event.toolCallId,
            result: event.result,
            isError: event.isError,
          });
        });
      }
    });
    const onAbort = () => void session.abort().catch(() => undefined);
    parentSignal.addEventListener("abort", onAbort, { once: true });
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      if (parentSignal.aborted) throw abortError();
      const prompt = session.prompt(
        config.outputSchema
          ? `Task: ${node.prompt}\n\nCall structured_output as your final action.`
          : `Task: ${node.prompt}`,
        { expandPromptTemplates: false, source: "extension" },
      );
      await (config.timeoutMs
        ? Promise.race([
            prompt,
            new Promise<never>((_, reject) => {
              deadlineTimer = setTimeout(() => {
                void session.abort().catch(() => undefined);
                reject(new Error(`Child deadline exceeded after ${config.timeoutMs}ms`));
              }, config.timeoutMs);
            }),
          ])
        : prompt);
      if (toolTimeoutError) throw toolTimeoutError;
      if (parentSignal.aborted) throw abortError();
      const assistants = messages.filter((m) => m.role === "assistant");
      const last = assistants.at(-1);
      if (
        last?.role === "assistant" &&
        (last.stopReason === "error" || last.stopReason === "aborted")
      )
        throw new Error(last.errorMessage || `Child stopped: ${last.stopReason}`);
      if (config.outputSchema && structuredValue === undefined)
        throw new Error("Subagent did not call structured_output");
      const text = textOf(messages);
      return {
        text,
        structured: structuredValue,
        sessionFile: session.sessionFile,
        usage: { ...usage },
      };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      for (const t of toolTimers.values()) clearTimeout(t);
      parentSignal.removeEventListener("abort", onAbort);
      unsubscribe();
      this.store.detachSession(runId, node.id);
      try {
        const runner = (
          session as unknown as { _extensionRunner?: { emit(event: unknown): Promise<unknown> } }
        )._extensionRunner;
        if (runner)
          await Promise.race([
            runner.emit({ type: "session_shutdown", reason: "quit" }),
            new Promise((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS)),
          ]);
      } catch {
        /* extension shutdown is best effort and bounded */
      }
      try {
        session.dispose();
      } catch {
        /* best effort */
      }
    }
  }
}
