import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type, type TSchema } from "typebox";
import type { AgentNodeSpec, ChildExecutionResult, UsageSnapshot } from "../types.ts";
import { RunStore } from "../state/run-store.ts";
import { ChildModelRuntime } from "./child-model-runtime.ts";
import { finishToolCallSnapshot, startToolCallSnapshot } from "./tool-call-snapshots.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are a delegated child agent. Complete only the assigned task. Return a precise result. Never start subagents/workflows or ask the user questions.";
const USER_INTERACTION_TOOLS = new Set(["ask_user", "question", "questionnaire"]);
export const isDeniedChildTool = (name: string): boolean =>
  name.startsWith("agentflow_") || USER_INTERACTION_TOOLS.has(name);
export const resolveRequestedModel = (
  configuredModel: string | undefined,
  inheritProvider: boolean | undefined,
  parentProvider: string | undefined,
): string | undefined => {
  if (!configuredModel || !inheritProvider) return configuredModel;
  if (!parentProvider) throw new Error("Cannot inherit model provider without a parent model");
  return `${parentProvider}/${configuredModel}`;
};
const canonicalExtensionPath = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};
export const filterEnabledExtensionPaths = (
  requested: Array<{ path: string; enabled: boolean }>,
  ...allowlists: Array<Array<{ path: string; enabled: boolean }>>
): string[] => {
  const enabled = allowlists.map(
    (entries) =>
      new Set(
        entries.filter((entry) => entry.enabled).map((entry) => canonicalExtensionPath(entry.path)),
      ),
  );
  return requested
    .filter(
      (entry) =>
        entry.enabled &&
        enabled.every((allowlist) => allowlist.has(canonicalExtensionPath(entry.path))),
    )
    .map((entry) => entry.path);
};
const MAX_OUTPUT = 100_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const ABORT_SETTLE_TIMEOUT_MS = 500;

export async function awaitWithChildDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  abort: () => Promise<unknown>,
): Promise<T> {
  if (!timeoutMs) return operation;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void abort().catch(() => undefined);
          reject(new Error(`Child deadline exceeded after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function settleChildAbort(
  abortPromise: Promise<unknown> | undefined,
  timeoutMs = ABORT_SETTLE_TIMEOUT_MS,
): Promise<void> {
  if (!abortPromise) return;
  await Promise.race([
    abortPromise.catch(() => undefined),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);
}

export async function disposeChildSession(
  session: Pick<AgentSession, "dispose" | "extensionRunner">,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  try {
    const runner = session.extensionRunner;
    if (runner)
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, shutdownTimeoutMs)),
      ]);
  } catch {
    // Extension shutdown is best effort and bounded.
  }
  try {
    session.dispose();
  } catch {
    // Disposal is best effort after bounded extension shutdown.
  }
}

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
  private readonly childModelRuntime = new ChildModelRuntime();

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
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    let extensionPaths: string[] | undefined;
    if (Array.isArray(config.extensions) && config.extensions.length > 0) {
      const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
      const globalSettingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted: false,
      });
      const globalPackageManager = new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager: globalSettingsManager,
      });
      const [configured, globallyConfigured, requested] = await Promise.all([
        packageManager.resolve(),
        globalPackageManager.resolve(),
        packageManager.resolveExtensionSources(config.extensions, { temporary: true }),
      ]);
      extensionPaths = filterEnabledExtensionPaths(
        requested.extensions,
        configured.extensions,
        globallyConfigured.extensions,
      );
    }
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: extensionPaths,
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
    const modelRuntime = await this.childModelRuntime.get(ctx.modelRegistry);
    let model = ctx.model
      ? (modelRuntime.getModel(ctx.model.provider, ctx.model.id) ?? ctx.model)
      : undefined;
    let thinking = (config.thinking ?? this.getInheritedThinking()) as ThinkingLevel | undefined;
    const requestedModel = resolveRequestedModel(
      config.model,
      config.inheritModelProvider,
      ctx.model?.provider,
    );
    if (requestedModel) {
      const resolved = resolveCliModel({
        cliModel: requestedModel,
        cliThinking: thinking,
        modelRuntime,
      });
      if (resolved.error || !resolved.model)
        throw new Error(resolved.error ?? `Model not found: ${requestedModel}`);
      model = resolved.model;
      thinking = resolved.thinkingLevel ?? thinking;
    }
    await this.childModelRuntime.ensureAuth(modelRuntime, ctx.modelRegistry, model);
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
      modelRuntime,
      thinkingLevel: thinking,
      tools,
      noTools: config.tools === false ? "all" : undefined,
      excludeTools: deniedTools,
      customTools,
    });
    let abortPromise: Promise<unknown> | undefined;
    const abortSession = (): Promise<unknown> =>
      (abortPromise ??= session.abort().catch(() => undefined));
    if (parentSignal.aborted) {
      await disposeChildSession(session);
      throw abortError();
    }
    try {
      if (extensionsResult.extensions.length)
        await session.bindExtensions({
          mode: config.extensionMode ?? "print",
          abortHandler: () => void abortSession(),
        });
    } catch (error) {
      await settleChildAbort(abortPromise);
      await disposeChildSession(session);
      throw error;
    }
    if (
      !this.store.attachControl(runId, node.id, {
        abort: () => session.abort(),
        steer: (message) => session.steer(message),
        get isStreaming() {
          return session.isStreaming;
        },
      })
    ) {
      await disposeChildSession(session);
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
              void abortSession();
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
    const onAbort = () => void abortSession();
    parentSignal.addEventListener("abort", onAbort, { once: true });
    try {
      if (parentSignal.aborted) throw abortError();
      const prompt = session.prompt(
        config.outputSchema
          ? `Task: ${node.prompt}\n\nCall structured_output as your final action.`
          : `Task: ${node.prompt}`,
        { expandPromptTemplates: false, source: "extension" },
      );
      await awaitWithChildDeadline(prompt, config.timeoutMs, abortSession);
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
      for (const t of toolTimers.values()) clearTimeout(t);
      parentSignal.removeEventListener("abort", onAbort);
      unsubscribe();
      this.store.detachControl(runId, node.id);
      await settleChildAbort(abortPromise);
      await disposeChildSession(session);
    }
  }
}
