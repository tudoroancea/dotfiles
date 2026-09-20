import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { stopLiveRedraw } from "../../lib/tools/live.ts";
import { formatMonitorEvent, type MonitorEvent } from "./runtime/monitor.ts";
import { ProcessRuntime } from "./runtime/process-runtime.ts";
import { compactSnapshot, serializeJobs, type SerializedJobs } from "./runtime/results.ts";
import type { JobRecord } from "./runtime/types.ts";
import { showBackgroundTasks } from "./ui/dashboard.ts";
import {
  backgroundRenderer,
  renderCompletionMessage,
  renderMonitorEventMessage,
} from "./ui/tool-renderers.ts";
import { registerBackgroundWebProvider } from "./web-provider.ts";

const STATUS_KEY = "background-processes";
const COMPLETION_TYPE = "background-process-completion";
const MONITOR_EVENT_TYPE = "background-monitor-event";
const MAX_IDS = 50;
const MONITOR_DEFAULT_TIMEOUT_SECONDS = 300;
const MONITOR_MAX_TIMEOUT_SECONDS = 3_600;
const MAX_TIMEOUT_SECONDS = 2_147_483.647;

export const backgroundRunSchema = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 16_384 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS })),
  },
  { additionalProperties: false },
);

export const backgroundEventStreamSchema = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 16_384 }),
    description: Type.String({ minLength: 1, maxLength: 500 }),
    timeout: Type.Optional(
      Type.Number({ exclusiveMinimum: 0, maximum: MONITOR_MAX_TIMEOUT_SECONDS }),
    ),
    persistent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const backgroundStatusSchema = Type.Object(
  {
    jobId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    tailLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
  },
  { additionalProperties: false },
);

const jobIdsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
  minItems: 1,
  maxItems: MAX_IDS,
  uniqueItems: true,
});

export const backgroundWaitSchema = Type.Object(
  {
    jobIds: jobIdsSchema,
    timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS })),
  },
  { additionalProperties: false },
);

export const backgroundStopSchema = Type.Object(
  { jobIds: jobIdsSchema },
  { additionalProperties: false },
);

export type BackgroundRunInput = Static<typeof backgroundRunSchema>;
export type BackgroundEventStreamInput = Static<typeof backgroundEventStreamSchema>;
export type BackgroundStatusInput = Static<typeof backgroundStatusSchema>;
export type BackgroundWaitInput = Static<typeof backgroundWaitSchema>;
export type BackgroundStopInput = Static<typeof backgroundStopSchema>;

function requireSupportedMode(ctx: ExtensionContext): void {
  if (ctx.mode === "print" || ctx.mode === "json") {
    throw new Error(
      `Background processes require a long-lived TUI or RPC host; ${ctx.mode} mode is unsupported.`,
    );
  }
}

function requireRuntime(runtime: ProcessRuntime | undefined): ProcessRuntime {
  if (!runtime) throw new Error("Background process runtime is not initialized");
  return runtime;
}

function requireNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Tool call aborted", "AbortError");
}

/** The renderer slots for one tool, defined in `ui/tool-renderers.ts`. */
function slots(name: string) {
  const renderer = backgroundRenderer(name);
  return { renderCall: renderer.renderCall, renderResult: renderer.renderResult };
}

function toolResult(payload: SerializedJobs) {
  return {
    content: [{ type: "text" as const, text: payload.text }],
    details: payload,
  };
}

export default function backgroundProcessesExtension(pi: ExtensionAPI): void {
  let runtime: ProcessRuntime | undefined;
  let sessionContext: ExtensionContext | undefined;
  let terminalTimer: NodeJS.Timeout | undefined;
  const announceWebProvider = registerBackgroundWebProvider(pi, () => runtime);

  const updateStatus = () => {
    if (!sessionContext) return;
    const jobs = runtime?.list() ?? [];
    const activeCount = jobs.filter((job) => job.status === "running").length;
    const warningCount = jobs.filter(
      (job) =>
        job.deliveryError ||
        job.deliveryPersistenceError ||
        job.monitor?.deliveryError ||
        job.monitorDeliveryPersistenceError,
    ).length;
    const warnings = warningCount ? ` · warnings ${warningCount}` : "";
    sessionContext.ui.setStatus?.(
      STATUS_KEY,
      activeCount || warningCount ? `■ /background-tasks ${activeCount}${warnings}` : undefined,
    );
  };

  const sendCompletions = async (ctx: ExtensionContext) => {
    const current = runtime;
    if (!current || !ctx.isIdle()) return;
    await current.flushCompletionDeliveries((payload) => {
      pi.sendMessage(
        {
          customType: COMPLETION_TYPE,
          content: payload.text,
          display: true,
          details: payload,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  };

  const sendMonitorEvents = (ctx: ExtensionContext) => {
    const current = runtime;
    if (!current) return;
    current.flushMonitorDeliveries((event) => {
      const idle = ctx.isIdle();
      pi.sendMessage(
        {
          customType: MONITOR_EVENT_TYPE,
          content: formatMonitorEvent(event),
          display: true,
          details: event,
        },
        idle
          ? { deliverAs: "followUp", triggerTurn: true }
          : { deliverAs: "steer", triggerTurn: true },
      );
    });
  };

  const scheduleTerminalDelivery = () => {
    if (terminalTimer || !sessionContext?.isIdle()) return;
    const expected = sessionContext;
    terminalTimer = setTimeout(() => {
      terminalTimer = undefined;
      if (sessionContext === expected) void sendCompletions(expected).catch(() => undefined);
    }, 30);
  };

  pi.registerTool({
    name: "background_run",
    label: "Background Run",
    description:
      "Launch a command in the background and return immediately with its job ID and artifact paths; one completion notification is delivered later. Inspired by Claude Code Background Bash/Monitor. Unsupported in print/json mode.",
    promptSnippet: "Launch a background command with one completion notification",
    promptGuidelines: [
      "Following the Claude Code Background Bash/Monitor model, choose background_run when one completion notification is enough; choose background_event_stream when actionable intermediate event notifications are needed.",
      "background_run launches the command itself and may mutate state; choose it by its completion-oriented notification model, not by mutability or duration.",
      "After launching with background_run, normally finish the turn with a brief note that work is still in progress; its completion notification will automatically trigger a follow-up turn while leaving the session available for user input.",
      "Use background_wait only when same-turn continuation is specifically important and the expected wait is short and bounded; later work depending on the result alone is not a reason to wait. Use background_status for nonblocking inspection and background_stop when the user asks to stop a job or continued execution would waste resources.",
    ],
    parameters: backgroundRunSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSupportedMode(ctx);
      requireNotAborted(signal);
      const current = requireRuntime(runtime);
      let job: JobRecord;
      try {
        job = await current.launch({
          kind: "background_run",
          command: params.command,
          description: params.description,
          timeout: params.timeout,
          cwd: ctx.cwd,
        });
      } catch (error) {
        updateStatus();
        throw error;
      }
      current.markLaunchTransferred(job.id);
      const payload = serializeJobs([current.get(job.id) ?? job]);
      return toolResult(payload);
    },
    ...slots("background_run"),
  });

  pi.registerTool({
    name: "background_event_stream",
    label: "Background Event Stream",
    description:
      "Launch a command in the background and deliver meaningful complete stdout lines live in bounded event batches; raw output remains in output.log. Inspired by Claude Code Background Bash/Monitor. Timeout defaults to 300 seconds (maximum 3600); persistent event streams have no timeout. Unsupported in print/json mode.",
    promptSnippet: "Launch a background command with actionable intermediate event notifications",
    promptGuidelines: [
      "Following the Claude Code Background Bash/Monitor model, choose background_event_stream when actionable intermediate event notifications are needed; choose background_run when one completion notification is enough.",
      "background_event_stream launches the command itself and may mutate state; it is not a read-only observer, and its event-oriented notification model—not mutability or duration—distinguishes it from background_run.",
      "Use background_event_stream only for meaningful event lines: filter noisy commands with tools such as grep --line-buffered, and poll at a reasonable interval so each complete line is actionable.",
      "Set persistent on background_event_stream only for a session-long source, and stop the stream when it is no longer needed.",
    ],
    parameters: backgroundEventStreamSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSupportedMode(ctx);
      requireNotAborted(signal);
      const current = requireRuntime(runtime);
      let job: JobRecord;
      try {
        job = await current.launch({
          kind: "background_event_stream",
          command: params.command,
          description: params.description,
          timeout: params.persistent
            ? undefined
            : (params.timeout ?? MONITOR_DEFAULT_TIMEOUT_SECONDS),
          cwd: ctx.cwd,
        });
      } catch (error) {
        updateStatus();
        throw error;
      }
      current.markLaunchTransferred(job.id);
      sendMonitorEvents(ctx);
      return toolResult(serializeJobs([current.get(job.id) ?? job]));
    },
    ...slots("background_event_stream"),
  });

  pi.registerTool({
    name: "background_status",
    label: "Background Status",
    description:
      "Inspect one background job or list recent jobs without waiting, stopping, or consuming automatic completion delivery.",
    promptSnippet: "Nonblocking inspection of background jobs",
    parameters: backgroundStatusSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSupportedMode(ctx);
      requireNotAborted(signal);
      const current = requireRuntime(runtime);
      if (!params.jobId && params.tailLines !== undefined)
        throw new Error("tailLines requires jobId");
      const records = params.jobId
        ? current.resolve([params.jobId])
        : current
            .list()
            .sort((left, right) =>
              left.status === "running" && right.status !== "running"
                ? -1
                : right.status === "running" && left.status !== "running"
                  ? 1
                  : right.createdAt.localeCompare(left.createdAt),
            );
      if (params.jobId && params.tailLines !== undefined) {
        const tail = current.tail(params.jobId);
        if (tail) records[0] = { ...records[0]!, terminalTail: tail };
      }
      return toolResult(
        serializeJobs(records, {
          includeTails: params.tailLines !== undefined,
          tailLines: params.tailLines,
        }),
      );
    },
    ...slots("background_status"),
  });

  pi.registerTool({
    name: "background_wait",
    label: "Background Wait",
    description:
      "Concurrently wait for all job IDs when same-turn continuation is specifically important. Its optional timeout only bounds this wait; timeout or caller cancellation never stops jobs. Returned terminal jobs consume their pending automatic completion.",
    promptSnippet: "Wait only for short, bounded same-turn synchronization",
    promptGuidelines: [
      "Prefer ending the turn and letting background_run's completion notification trigger a follow-up, which leaves the session available for user input. Use background_wait only when same-turn continuation is specifically important and the expected wait is short and bounded; later work depending on the result alone is not sufficient. Its timeout is separate from each command timeout and never stops a job.",
    ],
    parameters: backgroundWaitSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSupportedMode(ctx);
      requireNotAborted(signal);
      const payload = await requireRuntime(runtime).waitResult(params.jobIds, {
        timeout: params.timeout,
        signal,
      });
      return toolResult(payload);
    },
    ...slots("background_wait"),
  });

  pi.registerTool({
    name: "background_stop",
    label: "Background Stop",
    description:
      "Stop all requested background jobs through runtime-owned process-tree cancellation. All IDs are resolved before mutation; terminal jobs are idempotent no-ops. Returned terminal deliveries are consumed.",
    promptSnippet: "Stop background jobs and their process descendants",
    promptGuidelines: [
      "Use background_stop when the user asks, when a background task is no longer needed, or continuing it would waste resources; never kill its PID manually.",
    ],
    parameters: backgroundStopSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSupportedMode(ctx);
      requireNotAborted(signal);
      return toolResult(await requireRuntime(runtime).stopManyResult(params.jobIds));
    },
    ...slots("background_stop"),
  });

  pi.registerMessageRenderer(MONITOR_EVENT_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = message.details as MonitorEvent | undefined;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    // The event carries no job context of its own, so the expanded view borrows the live job.
    const job = expanded && details?.jobId ? runtime?.get(details.jobId) : undefined;
    return renderMonitorEventMessage(
      details,
      content,
      { expanded, outputPad },
      theme,
      job ? compactSnapshot(job) : undefined,
    );
  });

  pi.registerMessageRenderer(COMPLETION_TYPE, (message, { expanded, outputPad }, theme) =>
    renderCompletionMessage(message.details, { expanded, outputPad }, theme),
  );

  pi.registerCommand("background-tasks", {
    description: "Open the background task dashboard: /background-tasks [jobId]",
    handler: async (args, ctx) => {
      await showBackgroundTasks(ctx, requireRuntime(runtime), args.trim() || undefined);
    },
  });

  pi.on("session_start", async (_event, context) => {
    const previous = runtime;
    if (previous) {
      sessionContext?.ui.setStatus?.(STATUS_KEY, undefined);
      runtime = undefined;
      sessionContext = undefined;
      await previous.shutdown();
    }
    sessionContext = context;
    const next = new ProcessRuntime(context.sessionManager.getSessionId(), {
      onChange: updateStatus,
      onTerminal: scheduleTerminalDelivery,
      onMonitorEvent: () => {
        if (sessionContext === context) sendMonitorEvents(context);
      },
    });
    runtime = next;
    try {
      await next.initialize();
      updateStatus();
      announceWebProvider();
    } catch (error) {
      if (runtime === next) runtime = undefined;
      if (sessionContext === context) {
        context.ui.setStatus?.(STATUS_KEY, undefined);
        sessionContext = undefined;
      }
      await next.shutdown().catch(() => undefined);
      throw error;
    }
  });

  pi.on("agent_settled", async (_event, context) => {
    runtime?.settleMonitorDeliveries();
    sendMonitorEvents(context);
    await sendCompletions(context);
  });

  pi.on("session_shutdown", async (_event, context) => {
    // A job card that is still redrawing itself has a timer of its own; a renderer cannot own a
    // lifecycle, so the session's end is where they are dropped.
    stopLiveRedraw();
    if (terminalTimer) clearTimeout(terminalTimer);
    terminalTimer = undefined;
    context.ui.setStatus?.(STATUS_KEY, undefined);
    const current = runtime;
    if (runtime === current) runtime = undefined;
    if (sessionContext === context) sessionContext = undefined;
    if (current) await current.shutdown();
  });
}
