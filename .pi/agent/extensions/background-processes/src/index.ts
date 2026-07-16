import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatMonitorEvent, type MonitorEvent } from "./runtime/monitor.ts";
import { ProcessRuntime } from "./runtime/process-runtime.ts";
import { serializeJobs, type SerializedJobs } from "./runtime/results.ts";
import type { JobRecord } from "./runtime/types.ts";
import { formatDuration, showBackgroundTasks } from "./ui/dashboard.ts";

const WIDGET_KEY = "background-processes";
const COMPLETION_TYPE = "background-process-completion";
const MONITOR_EVENT_TYPE = "background-monitor-event";
const MAX_IDS = 50;
const MONITOR_DEFAULT_TIMEOUT_SECONDS = 300;
const MONITOR_MAX_TIMEOUT_SECONDS = 3_600;
const MAX_TIMEOUT_SECONDS = 2_147_483.647;

export const backgroundBashSchema = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 16_384 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS })),
  },
  { additionalProperties: false },
);

export const monitorSchema = Type.Object(
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

export type BackgroundBashInput = Static<typeof backgroundBashSchema>;
export type MonitorInput = Static<typeof monitorSchema>;
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

function toolResult(payload: SerializedJobs) {
  return {
    content: [{ type: "text" as const, text: payload.text }],
    details: payload,
  };
}

function sanitizeRenderedValue(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isEscape = code === 0x1b;
    const isCsi = code === 0x9b;
    const isOsc = code === 0x9d;
    if (isEscape || isCsi || isOsc) {
      const introducer = isEscape ? value[index + 1] : isCsi ? "[" : "]";
      if (isEscape && (introducer === "[" || introducer === "]")) index += 1;
      if (introducer === "[") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(index + 1);
          index += 1;
          if (next >= 0x40 && next <= 0x7e) break;
        }
      } else if (introducer === "]") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(index + 1);
          index += 1;
          if (next === 0x07 || next === 0x9c) break;
          if (next === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
        }
      }
      safe += " ";
      continue;
    }
    safe +=
      code === 0x0a ? "\n" : code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : value[index];
  }
  return safe;
}

function sanitizeLabel(value: string): string {
  return sanitizeRenderedValue(value).replace(/\s+/g, " ").trim().slice(0, 40);
}

function jobLabel(job: JobRecord): string {
  return sanitizeLabel(job.description || job.command) || sanitizeLabel(job.id);
}

function runningDuration(job: JobRecord): string {
  const createdAt = Date.parse(job.createdAt);
  return formatDuration(Number.isFinite(createdAt) ? Date.now() - createdAt : 0);
}

function renderToolResult(
  result: { details?: unknown; content?: Array<{ type: string; text?: string }> },
  options: { expanded: boolean },
  theme: {
    fg: (color: "success" | "warning" | "error" | "dim" | "muted", text: string) => string;
  },
) {
  const details = result.details as SerializedJobs | undefined;
  const jobs = details?.jobs ?? [];
  const status = (job: (typeof jobs)[number]) => {
    const monitor = job.monitor;
    const monitorSummary = monitor
      ? ` #${monitor.deliveries}${monitor.droppedLines ? ` drop:${monitor.droppedLines}` : ""}${monitor.captureOnly ? " capture-only" : ""}${monitor.deliveryError ? " send-error" : ""}${job.monitorDeliveryPersistenceError ? " checkpoint-error" : ""}`
      : "";
    const summary = `${sanitizeRenderedValue(job.jobId)} ${job.status}${monitorSummary}`;
    if (job.status === "completed") return theme.fg("success", `✓ ${summary}`);
    if (job.status === "running" || job.status === "timed_out" || job.status === "cancelled")
      return theme.fg("warning", `◆ ${summary}`);
    return theme.fg("error", `✗ ${summary}`);
  };
  const compact = jobs.map(status).join(theme.fg("muted", " · ")) || "No jobs";
  const text = options.expanded
    ? theme.fg(
        "dim",
        sanitizeRenderedValue(
          result.content?.find((part) => part.type === "text")?.text ?? compact,
        ),
      )
    : compact;
  return new Text(text, 0, 0);
}

export default function backgroundProcessesExtension(pi: ExtensionAPI): void {
  let runtime: ProcessRuntime | undefined;
  let sessionContext: ExtensionContext | undefined;
  let terminalTimer: NodeJS.Timeout | undefined;

  const updateWidget = () => {
    if (sessionContext?.mode !== "tui") return;
    const current = runtime;
    const active = current?.list().filter((job) => job.status === "running") ?? [];
    if (!current || active.length === 0) {
      sessionContext.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    sessionContext.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      const timer = setInterval(() => tui.requestRender(), 1_000);
      timer.unref();
      return {
        render(width: number) {
          const jobs = current.list().filter((job) => job.status === "running");
          if (jobs.length === 0) return [];
          const header =
            theme.fg("accent", theme.bold("◆ BACKGROUND TASKS")) +
            theme.fg("muted", `  ${jobs.length} running · /background-tasks`);
          const lines = jobs.slice(0, 2).map((job) => {
            const monitor = job.monitor;
            const monitorError = monitor?.deliveryError
              ? " · send-error"
              : job.monitorDeliveryPersistenceError
                ? " · checkpoint-error"
                : "";
            const activity = monitor
              ? ` · #${monitor.deliveries}${monitor.captureOnly ? " capture-only" : ""}${monitor.droppedLines ? ` · ${monitor.droppedLines} dropped` : ""}${monitorError}`
              : "";
            return `${theme.fg("accent", "│")} ${theme.fg("text", jobLabel(job))} ${theme.fg("dim", `· ${job.id} · ${runningDuration(job)}${activity}`)}`;
          });
          if (jobs.length > 2)
            lines.push(
              theme.fg(
                "dim",
                `└ ${jobs.length - 2} more running task${jobs.length === 3 ? "" : "s"}`,
              ),
            );
          return [header, ...lines].map((line) => truncateToWidth(line, width));
        },
        invalidate() {},
        dispose() {
          clearInterval(timer);
        },
      };
    });
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
    name: "background_bash",
    label: "Background Bash",
    description:
      "Launch a finite shell command in the background. Returns immediately with its job ID and artifact paths; completion is delivered later. Unsupported in print/json mode.",
    promptSnippet: "Launch a finite shell command without blocking the agent loop",
    promptGuidelines: [
      "Use background_bash for long finite commands that can run while other work continues; do not immediately call background_wait unless later work truly depends on completion.",
      "Use background_status for nonblocking inspection and background_stop when the user asks to stop a job or continued execution would waste resources.",
    ],
    parameters: backgroundBashSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSupportedMode(ctx);
      if (
        params.timeout !== undefined &&
        (!Number.isFinite(params.timeout) ||
          params.timeout <= 0 ||
          params.timeout > MAX_TIMEOUT_SECONDS)
      ) {
        throw new RangeError(
          `timeout must be positive and no greater than ${MAX_TIMEOUT_SECONDS} seconds`,
        );
      }
      requireNotAborted(signal);
      const current = requireRuntime(runtime);
      let job: JobRecord;
      try {
        job = await current.launch({
          kind: "background_bash",
          command: params.command,
          description: params.description,
          timeout: params.timeout,
          cwd: ctx.cwd,
        });
      } catch (error) {
        updateWidget();
        throw error;
      }
      current.markLaunchTransferred(job.id);
      const payload = serializeJobs([current.get(job.id) ?? job]);
      return toolResult(payload);
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("background_bash"))} ${theme.fg("muted", sanitizeRenderedValue(args.description ?? args.command))}`,
        0,
        0,
      );
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Launch a meaningful line-buffered event stream in the background. Complete lines are delivered live in bounded batches; raw output remains in output.log. Timeout defaults to 300 seconds (maximum 3600); persistent monitors have no timeout. Unsupported in print/json mode.",
    promptSnippet: "Monitor meaningful filtered or reasonably polled line-buffered events",
    promptGuidelines: [
      "Use monitor only for meaningful event lines. Filter noisy commands with tools such as grep --line-buffered, and poll at a reasonable interval so each complete line is actionable.",
      "Use persistent only for a session-long source, and stop a monitor when it is no longer needed.",
    ],
    parameters: monitorSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSupportedMode(ctx);
      if (
        params.timeout !== undefined &&
        (!Number.isFinite(params.timeout) ||
          params.timeout <= 0 ||
          params.timeout > MONITOR_MAX_TIMEOUT_SECONDS)
      ) {
        throw new RangeError(
          `monitor timeout must be positive and no greater than ${MONITOR_MAX_TIMEOUT_SECONDS} seconds`,
        );
      }
      requireNotAborted(signal);
      const current = requireRuntime(runtime);
      let job: JobRecord;
      try {
        job = await current.launch({
          kind: "monitor",
          command: params.command,
          description: params.description,
          timeout: params.persistent
            ? undefined
            : (params.timeout ?? MONITOR_DEFAULT_TIMEOUT_SECONDS),
          cwd: ctx.cwd,
        });
      } catch (error) {
        updateWidget();
        throw error;
      }
      current.markLaunchTransferred(job.id);
      sendMonitorEvents(ctx);
      return toolResult(serializeJobs([current.get(job.id) ?? job]));
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("monitor"))} ${theme.fg("muted", sanitizeRenderedValue(args.description))}`,
        0,
        0,
      );
    },
    renderResult: renderToolResult,
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
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("background_status"))}${args.jobId ? ` ${theme.fg("muted", sanitizeRenderedValue(args.jobId))}` : ""}`,
        0,
        0,
      );
    },
    renderResult: renderToolResult,
  });

  pi.registerTool({
    name: "background_wait",
    label: "Background Wait",
    description:
      "Concurrently wait for all job IDs. Its optional timeout only bounds this wait; timeout or caller cancellation never stops jobs. Returned terminal jobs consume their pending automatic completion.",
    promptSnippet: "Wait for background jobs only when subsequent work depends on them",
    promptGuidelines: [
      "Use background_wait only when subsequent work truly depends on completion; its timeout is separate from each command timeout and never stops a job.",
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
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("background_wait"))} ${theme.fg("muted", args.jobIds.map(sanitizeRenderedValue).join(", "))}`,
        0,
        0,
      );
    },
    renderResult: renderToolResult,
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
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("background_stop"))} ${theme.fg("muted", args.jobIds.map(sanitizeRenderedValue).join(", "))}`,
        0,
        0,
      );
    },
    renderResult: renderToolResult,
  });

  pi.registerMessageRenderer(MONITOR_EVENT_TYPE, (message, { expanded }, theme) => {
    const details = message.details as MonitorEvent | undefined;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (expanded) return new Text(sanitizeRenderedValue(content), 0, 0);
    const range = details?.firstSequence
      ? `${details.firstSequence}-${details.lastSequence}`
      : "event";
    const suffix = details?.captureOnly ? " · capture-only" : "";
    const drops = details?.droppedLines ? ` · drop ${details.droppedLines}` : "";
    return new Text(
      theme.fg(
        details?.captureOnly ? "warning" : "success",
        `◆ ${sanitizeRenderedValue(details?.jobId ?? "monitor")} #${details?.delivery ?? "?"} ${range}${drops}${suffix}`,
      ),
      0,
      0,
    );
  });

  pi.registerMessageRenderer(COMPLETION_TYPE, (message, { expanded }, theme) => {
    const details = message.details as SerializedJobs | undefined;
    const jobs = details?.jobs ?? [];
    const summary =
      jobs
        .map((job) => {
          const monitor = job.monitor;
          const monitorSummary = monitor
            ? ` #${monitor.deliveries}${monitor.droppedLines ? ` drop:${monitor.droppedLines}` : ""}${monitor.captureOnly ? " capture-only" : ""}${monitor.deliveryError ? " send-error" : ""}${job.monitorDeliveryPersistenceError ? " checkpoint-error" : ""}`
            : "";
          return `${sanitizeRenderedValue(job.jobId)} ${job.status}${monitorSummary}`;
        })
        .join(" · ") || "Background completion";
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (expanded) return new Text(sanitizeRenderedValue(content), 0, 0);
    const hasError = jobs.some((job) => job.status === "failed" || job.status === "cleanup_failed");
    const hasWarning = jobs.some((job) => job.status === "timed_out" || job.status === "cancelled");
    const color = hasError ? "error" : hasWarning ? "warning" : "success";
    const icon = hasError ? "✗" : hasWarning ? "◆" : "✓";
    return new Text(theme.fg(color, `${icon} ${summary}`), 0, 0);
  });

  pi.registerCommand("background-tasks", {
    description: "Open the background task dashboard: /background-tasks [jobId]",
    handler: async (args, ctx) => {
      await showBackgroundTasks(ctx, requireRuntime(runtime), args.trim() || undefined);
    },
  });

  pi.registerCommand("background-stop", {
    description: "Stop one background job: /background-stop <jobId>",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        ctx.ui.notify(sanitizeRenderedValue("Usage: /background-stop <jobId>"), "warning");
        return;
      }
      const payload = await requireRuntime(runtime).stopManyResult([jobId]);
      ctx.ui.notify(sanitizeRenderedValue(payload.text), "info");
    },
  });

  pi.registerCommand("background-tail", {
    description: "Show the recent output tail: /background-tail <jobId>",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        ctx.ui.notify(sanitizeRenderedValue("Usage: /background-tail <jobId>"), "warning");
        return;
      }
      const current = requireRuntime(runtime);
      const record = current.resolve([jobId])[0]!;
      const tail = current.tail(jobId);
      const payload = serializeJobs([{ ...record, ...(tail ? { terminalTail: tail } : {}) }], {
        includeTails: true,
        tailLines: 200,
      });
      ctx.ui.notify(sanitizeRenderedValue(payload.text), "info");
    },
  });

  pi.on("session_start", async (_event, context) => {
    if (runtime) await runtime.shutdown();
    sessionContext = context;
    const next = new ProcessRuntime(context.sessionManager.getSessionId(), {
      onChange: updateWidget,
      onTerminal: scheduleTerminalDelivery,
      onMonitorEvent: () => {
        if (sessionContext === context) sendMonitorEvents(context);
      },
    });
    runtime = next;
    try {
      await next.initialize();
      updateWidget();
    } catch (error) {
      if (runtime === next) runtime = undefined;
      updateWidget();
      throw error;
    }
  });

  pi.on("agent_settled", async (_event, context) => {
    runtime?.settleMonitorDeliveries();
    sendMonitorEvents(context);
    await sendCompletions(context);
  });

  pi.on("session_shutdown", async (_event, context) => {
    if (terminalTimer) clearTimeout(terminalTimer);
    terminalTimer = undefined;
    if (context.mode === "tui") context.ui.setWidget(WIDGET_KEY, undefined);
    const current = runtime;
    if (!current) return;
    await current.shutdown();
    if (runtime === current) runtime = undefined;
    if (sessionContext === context) sessionContext = undefined;
  });
}
