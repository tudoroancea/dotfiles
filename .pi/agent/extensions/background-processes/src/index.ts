import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatMonitorEvent, type MonitorEvent } from "./runtime/monitor.ts";
import { ProcessRuntime } from "./runtime/process-runtime.ts";
import { compactSnapshot, serializeJobs, type SerializedJobs } from "./runtime/results.ts";
import type { JobRecord } from "./runtime/types.ts";
import { showBackgroundTasks } from "./ui/dashboard.ts";
import { formatCommand, formatCwd, formatStatus, sanitizeRenderedValue } from "./ui/formatters.ts";
import { formatCompactJob, formatJobDetails, formatJobDetailsList } from "./ui/job-formatters.ts";

const STATUS_KEY = "background-processes";
const COMPLETION_TYPE = "background-process-completion";
const MONITOR_EVENT_TYPE = "background-monitor-event";
const MAX_IDS = 50;
const MONITOR_DEFAULT_TIMEOUT_SECONDS = 300;
const MONITOR_MAX_TIMEOUT_SECONDS = 3_600;
const MAX_TIMEOUT_SECONDS = 2_147_483.647;

function expandHint(): string | undefined {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return undefined;
  }
}

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

function toolResult(payload: SerializedJobs) {
  return {
    content: [{ type: "text" as const, text: payload.text }],
    details: payload,
  };
}

function formatJobIds(jobIds: string[]): string {
  const shown = jobIds
    .slice(0, 3)
    .map((id) => formatCommand(id, { maximum: 40, singleLine: true }))
    .join(", ");
  return jobIds.length > 3 ? `${shown}, +${jobIds.length - 3} more` : shown;
}

function resultNotices(details: SerializedJobs | undefined): string[] {
  if (!details) return [];
  const notices: string[] = [];
  if (details.omittedCount > 0) {
    const range = details.omittedJobs
      ? ` (${details.omittedJobs.firstJobId}…${details.omittedJobs.lastJobId})`
      : "";
    notices.push(`${details.omittedCount} jobs omitted${range}`);
    if (details.omittedJobs?.guidance) notices.push(details.omittedJobs.guidance);
  }
  if (details.truncated) notices.push("Result payload truncated; inspect the artifact paths above");
  return notices.map(sanitizeRenderedValue);
}

function renderToolResult(
  result: { details?: unknown; content?: Array<{ type: string; text?: string }> },
  options: { expanded: boolean },
  theme: {
    fg: (color: "success" | "warning" | "error" | "dim" | "muted", text: string) => string;
  },
): Component {
  const details = result.details as SerializedJobs | undefined;
  const jobs = details?.jobs ?? [];
  const notices = resultNotices(details);
  if (options.expanded) {
    const text = [formatJobDetailsList(jobs), ...notices.map((notice) => `\n${notice}`)].join("\n");
    return new Text(theme.fg("dim", text), 0, 0);
  }

  return {
    render(width) {
      if (width <= 0) return [];
      const lines = jobs.length
        ? jobs.slice(0, 3).map((job) => {
            const status = formatStatus(job.status);
            return theme.fg(status.tone, formatCompactJob(job));
          })
        : [theme.fg("muted", "No jobs")];
      if (jobs.length > 3) lines.push(theme.fg("dim", `… ${jobs.length - 3} more jobs`));
      lines.push(...notices.map((notice) => theme.fg("warning", notice)));
      const hint = expandHint();
      if (hint) lines.push(theme.fg("dim", hint));
      return lines.map((line) => truncateToWidth(line, width, "…"));
    },
    invalidate() {},
  };
}

export default function backgroundProcessesExtension(pi: ExtensionAPI): void {
  let runtime: ProcessRuntime | undefined;
  let sessionContext: ExtensionContext | undefined;
  let terminalTimer: NodeJS.Timeout | undefined;

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
      "After launching with background_run, do not immediately call background_wait unless later work truly depends on completion; use background_status for nonblocking inspection and background_stop when the user asks to stop a job or continued execution would waste resources.",
    ],
    parameters: backgroundRunSchema,
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
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("background_run"));
      if (context?.expanded) {
        return new Text(
          `${title}\n${theme.fg("dim", formatCwd(context.cwd))}\n${theme.fg("muted", `$ ${formatCommand(args.command)}`)}`,
          0,
          0,
        );
      }
      const label = formatCommand(args.description ?? args.command, {
        maximum: 100,
        singleLine: true,
      });
      return new Text(`${title} ${theme.fg("muted", label)}`, 0, 0);
    },
    renderResult: renderToolResult,
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
      if (
        params.timeout !== undefined &&
        (!Number.isFinite(params.timeout) ||
          params.timeout <= 0 ||
          params.timeout > MONITOR_MAX_TIMEOUT_SECONDS)
      ) {
        throw new RangeError(
          `event stream timeout must be positive and no greater than ${MONITOR_MAX_TIMEOUT_SECONDS} seconds`,
        );
      }
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
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("background_event_stream"));
      if (context?.expanded) {
        return new Text(
          `${title}\n${theme.fg("dim", formatCwd(context.cwd))}\n${theme.fg("muted", `$ ${formatCommand(args.command)}`)}`,
          0,
          0,
        );
      }
      return new Text(
        `${title} ${theme.fg("muted", formatCommand(args.description, { maximum: 100, singleLine: true }))}`,
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
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("background_status"));
      const target = args.jobId ? sanitizeRenderedValue(args.jobId) : "recent jobs";
      const tail = args.tailLines === undefined ? "" : ` · tail ${args.tailLines} lines`;
      return new Text(
        context?.expanded
          ? `${title}\n${theme.fg("dim", `Target: ${target}${tail}`)}`
          : `${title}${args.jobId ? ` ${theme.fg("muted", target)}` : ""}`,
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
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("background_wait"));
      if (context?.expanded) {
        const timeout = args.timeout === undefined ? "none" : `${args.timeout}s`;
        return new Text(
          `${title}\n${theme.fg("dim", `Jobs: ${formatJobIds(args.jobIds)}\nWait timeout: ${timeout}`)}`,
          0,
          0,
        );
      }
      return new Text(`${title} ${theme.fg("muted", formatJobIds(args.jobIds))}`, 0, 0);
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
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("background_stop"));
      return new Text(
        context?.expanded
          ? `${title}\n${theme.fg("dim", args.jobIds.map((id) => sanitizeRenderedValue(id)).join("\n"))}`
          : `${title} ${theme.fg("muted", formatJobIds(args.jobIds))}`,
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
    if (expanded) {
      const job = details?.jobId ? runtime?.get(details.jobId) : undefined;
      if (job) {
        return new Text(
          theme.fg(
            "dim",
            formatJobDetails({
              ...compactSnapshot(job),
              tail: sanitizeRenderedValue(content),
            }),
          ),
          0,
          0,
        );
      }
      return new Text(sanitizeRenderedValue(content), 0, 0);
    }
    const range = details?.firstSequence
      ? `${details.firstSequence}-${details.lastSequence}`
      : "event";
    const suffix = details?.captureOnly ? " · capture-only" : "";
    const drops = details?.droppedLines ? ` · drop ${details.droppedLines}` : "";
    const hint = expandHint();
    return new Text(
      theme.fg(
        details?.captureOnly ? "warning" : "success",
        `■ ${sanitizeRenderedValue(details?.jobId ?? "event stream")} #${details?.delivery ?? "?"} ${range}${drops}${suffix}${hint ? ` · ${hint}` : ""}`,
      ),
      0,
      0,
    );
  });

  pi.registerMessageRenderer(COMPLETION_TYPE, (message, { expanded }, theme) => {
    const details = message.details as SerializedJobs | undefined;
    const jobs = details?.jobs ?? [];
    if (expanded) return new Text(theme.fg("dim", formatJobDetailsList(jobs)), 0, 0);
    if (!jobs.length) return new Text(theme.fg("muted", "Background completion"), 0, 0);
    const statuses = jobs.map((job) => formatStatus(job.status));
    const aggregate = statuses.some((status) => status.tone === "error")
      ? formatStatus("failed")
      : statuses.some((status) => status.tone === "warning")
        ? formatStatus("running")
        : statuses.some((status) => status.tone === "muted")
          ? formatStatus("cancelled")
          : formatStatus("completed");
    const summary = jobs
      .slice(0, 3)
      .map((job) => `${sanitizeRenderedValue(job.jobId)} ${formatStatus(job.status).label}`)
      .join(" · ");
    const omitted = jobs.length > 3 ? ` · +${jobs.length - 3} more` : "";
    const hint = expandHint();
    return new Text(
      theme.fg(aggregate.tone, `${aggregate.icon} ${summary}${omitted}${hint ? ` · ${hint}` : ""}`),
      0,
      0,
    );
  });

  pi.registerCommand("background-tasks", {
    description: "Open the background task dashboard: /background-tasks [jobId]",
    handler: async (args, ctx) => {
      await showBackgroundTasks(pi.events, ctx, requireRuntime(runtime), args.trim() || undefined);
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
    } catch (error) {
      if (runtime === next) runtime = undefined;
      updateStatus();
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
    context.ui.setStatus?.(STATUS_KEY, undefined);
    const current = runtime;
    if (runtime === current) runtime = undefined;
    if (sessionContext === context) sessionContext = undefined;
    if (current) await current.shutdown();
  });
}
