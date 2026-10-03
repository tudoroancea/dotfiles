// Tool-call renderers for the five background tools and the two delivered messages.
//
// A launching tool's header carries the command, so its job cards omit it.
// Observer cards keep the command. Collapsed results show one aggregate status line;
// expanded results show the job cards.
//
// Layout comes from `lib/tools/render.ts`; the job vocabulary (status icons and tones,
// command/cwd bounding, shared duration formatting) stays in `./formatters.ts` so a job
// reads the same in a tool card and in the `/background-tasks` dashboard.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { formatBytes, pluralize, shortenPath } from "../../../lib/tools/format.ts";
import { liveRedraw } from "../../../lib/tools/live.ts";
import {
  block,
  boundedOutput,
  details as headerDetails,
  expandHint,
  facts,
  invalidArg,
  statusLine,
  summary,
  toolName,
  type Fact,
} from "../../../lib/tools/render.ts";
import {
  defineRenderer,
  flag,
  optionalNumber,
  optionalText,
  requiredText,
  textList,
  type RenderContext,
  type Renderer,
  type ResultView,
} from "../../../lib/tools/types.ts";
import type { JobSnapshot, OmittedJobs, SerializedJobs } from "../runtime/results.ts";
import type { MonitorEvent } from "../runtime/monitor.ts";
import {
  formatCommand,
  formatCwd,
  formatDuration,
  formatStatus,
  sanitizeRenderedValue,
} from "./formatters.ts";

/** A job id or short label from a payload we did not necessarily write. */
const safeId = (value: string): string => formatCommand(value, { maximum: 100, singleLine: true });

/** Output tail lines a job card shows; the browser's nested disclosure has no equivalent. */
const MAX_TAIL_LINES = 10;
/** Event-batch lines an expanded monitor message shows. */
const MAX_EVENT_LINES = 40;
/** Jobs summarized by id on a collapsed completion message. */
const MAX_SUMMARIZED_JOBS = 3;

interface JobsView {
  jobs: JobSnapshot[];
  omittedCount: number;
  omittedJobs?: OmittedJobs;
  truncated: boolean;
}

/**
 * The job list out of a tool result or a delivered message. Both carry the same
 * `SerializedJobs`, but a resumed session's payload is only as good as the version that
 * wrote it, so every field is read defensively.
 */
function jobsView(value: unknown): JobsView {
  const payload = (value ?? {}) as Partial<SerializedJobs>;
  return {
    jobs: Array.isArray(payload.jobs) ? payload.jobs.filter((job) => job && job.jobId) : [],
    omittedCount: typeof payload.omittedCount === "number" ? payload.omittedCount : 0,
    omittedJobs: payload.omittedJobs,
    truncated: payload.truncated === true,
  };
}

/**
 * Job statuses onto the shared status vocabulary the icons and tones use. The extension's
 * extra terminal states have no icon of their own, so they borrow the failure one and keep
 * their real name as the label — the same mapping the browser's `jobStatusKey` makes.
 */
function jobStatusKey(status: string): string {
  if (status === "timed_out" || status === "cleanup_failed") return "failed";
  return status === "unknown" ? "queued" : status;
}

/**
 * The worst state in the list, so a collapsed box reports the outcome that matters. Anything
 * terminal that is not `completed` — failed, timed out, cancelled, cleanup_failed — outranks a
 * success, and a still-running job outranks nothing but success.
 */
function aggregateStatus(jobs: readonly JobSnapshot[]): string {
  const unhappy = jobs.find((job) => job.status !== "completed" && job.status !== "running");
  if (unhappy) return unhappy.status;
  if (jobs.some((job) => job.status === "running")) return "running";
  return jobs.length ? "completed" : "unknown";
}

/** The live-output bookkeeping only an event-stream job carries. */
function monitorFacts(job: JobSnapshot): Fact[] {
  const monitor = job.monitor;
  if (!monitor) return [];
  const completion: Record<string, string> = {
    no_output: "produced no output",
    all_delivered_live: "all output delivered live",
    remaining: "output captured to the log",
  };
  return [
    { label: "Deliveries", value: monitor.deliveries ? String(monitor.deliveries) : "" },
    {
      label: "Dropped",
      value: monitor.droppedLines
        ? `${pluralize(monitor.droppedLines, "line")} / ${formatBytes(monitor.droppedBytes)}`
        : "",
    },
    { label: "Split lines", value: monitor.splitLines ? String(monitor.splitLines) : "" },
    { label: "Capture only", value: monitor.captureOnly ? "not delivered to the model" : "" },
    { label: "Final output", value: completion[monitor.completionOutput ?? ""] ?? "" },
  ];
}

/**
 * A job's elapsed time, advanced by `liveMs` while it is still running.
 *
 * `durationMs` was computed when the extension serialized the payload and never moves again,
 * and the snapshot carries no start timestamp a renderer could measure against instead — an
 * event-stream job omits `createdAt` entirely, and a plain run's is bounded to a few bytes. So a
 * running job's elapsed time is its serialized duration plus the time this row has been shown.
 */
function jobElapsed(job: JobSnapshot, liveMs: number): string {
  if (job.durationMs === undefined) return "";
  return formatDuration(job.durationMs + (job.status === "running" ? liveMs : 0));
}

function jobErrors(job: JobSnapshot): string[] {
  return [
    job.error,
    job.deliveryError,
    job.deliveryPersistenceError,
    job.monitorDeliveryPersistenceError,
    job.monitor?.deliveryError,
  ].filter((error): error is string => Boolean(error));
}

/**
 * One job, as the browser's `JobCard`: an identity line closed by the status, then the facts,
 * then whatever went wrong, then the output tail.
 *
 * `describedByHeader` marks a job whose command and description the tool's own header already
 * carries, which is true exactly for the two launching tools.
 */
function jobCard(job: JobSnapshot, theme: Theme, describedByHeader: boolean, liveMs = 0): string {
  const status = formatStatus(job.status);
  const identity = safeId(
    describedByHeader ? job.jobId : job.description || job.command || job.jobId,
  );
  const errors = jobErrors(job);
  return block([
    `${theme.fg(status.tone, `${status.icon} ${status.label}`)} ${theme.fg("toolTitle", identity)}`,
    ...facts(theme, [
      { label: "Job", value: describedByHeader ? "" : job.jobId },
      { label: "Task", value: describedByHeader ? "" : (job.description ?? "") },
      { label: "Kind", value: job.kind === "background_event_stream" ? "event stream" : "" },
      // The browser has no Cwd fact yet; expanded is the union of both surfaces.
      { label: "Cwd", value: job.cwd ? formatCwd(job.cwd) : "" },
      {
        label: "Exit",
        value: job.exitCode === undefined ? "" : String(job.exitCode ?? "signal"),
        error: (job.exitCode ?? 0) !== 0,
      },
      { label: "Stopped by", value: (job.requestedTerminalCause ?? "").replaceAll("_", " ") },
      { label: "Elapsed", value: jobElapsed(job, liveMs) },
      { label: "Output", value: formatBytes(job.outputBytes) },
      { label: "Delivery", value: job.deliveryState ?? "" },
      { label: "Log", value: shortenPath(job.outputPath ?? "") },
      ...monitorFacts(job),
    ]),
    ...errors.map((error) => theme.fg("error", sanitizeRenderedValue(error))),
    job.tail ? boundedOutput(theme, job.tail, MAX_TAIL_LINES) : "",
    job.tailTruncated ? theme.fg("dim", "Output tail truncated") : "",
  ]);
}

/** What the extension had to leave out of the payload to stay in budget. */
function jobsNotices(view: JobsView, theme: Theme): string[] {
  const notices: string[] = [];
  if (view.omittedCount) {
    const range = view.omittedJobs
      ? ` (${safeId(view.omittedJobs.firstJobId)}…${safeId(view.omittedJobs.lastJobId)})`
      : "";
    notices.push(`${pluralize(view.omittedCount, "job")} omitted${range}`);
    if (view.omittedJobs?.guidance) notices.push(sanitizeRenderedValue(view.omittedJobs.guidance));
  } else if (view.truncated) {
    notices.push("Result payload or output tail truncated");
  }
  return notices.map((notice) => theme.fg("warning", notice));
}

/** How long this row has been showing the payload it decoded, pinned against redrawing. */
function shownFor(state: Record<string, unknown>): number {
  const observedAt = (state.observedAt ??= Date.now()) as number;
  return Math.max(0, Date.now() - observedAt);
}

function jobsBody(result: ResultView, ctx: RenderContext, describedByHeader: boolean): string {
  const { theme, expanded } = ctx;
  const view = jobsView(result.details);
  if (!view.jobs.length) {
    // No readable job list: the tool's own text is all there is.
    if (!result.text) return "";
    const text = sanitizeRenderedValue(result.text);
    return expanded
      ? theme.fg(result.isError ? "error" : "toolOutput", `\n${text}`)
      : summary(theme, text.split("\n")[0] ?? "", result.isError ? "error" : "dim");
  }
  // Pinned on the first render whatever the state, so a job left collapsed for a while still
  // reports the whole of it once opened.
  const shown = shownFor(ctx.state);
  // Only a card carries an elapsed time, so only an expanded row has anything to advance.
  const running = view.jobs.some((job) => job.status === "running");
  liveRedraw(ctx, running && expanded);
  if (!expanded) {
    const status = aggregateStatus(view.jobs);
    return block([
      statusLine(theme, jobStatusKey(status), {
        state: formatStatus(status).label,
        parts: [pluralize(view.jobs.length, "job")],
        expanded: false,
      }),
      ...jobsNotices(view, theme),
    ]);
  }
  return block([
    "",
    ...view.jobs.map((job) => jobCard(job, theme, describedByHeader, shown)),
    ...jobsNotices(view, theme),
  ]);
}

// ---------------------------------------------------------------------------
// The two launching tools
// ---------------------------------------------------------------------------

const run = defineRenderer({
  names: ["background_run"],
  decode: (raw) => ({
    command: requiredText(raw.command),
    description: optionalText(raw.description),
    timeout: optionalNumber(raw.timeout),
  }),
  header: (args, { theme, expanded }) =>
    `${toolName(theme, "background_run")}${headerDetails(theme, [
      args.command === null
        ? invalidArg(theme)
        : formatCommand(args.command, expanded ? {} : { maximum: 100, singleLine: true }),
      args.description ? safeId(args.description) : undefined,
      args.timeout === undefined ? undefined : `${args.timeout}s timeout`,
    ])}`,
  body: (_args, result, ctx) => jobsBody(result, ctx, true),
});

const eventStream = defineRenderer({
  names: ["background_event_stream"],
  decode: (raw) => ({
    command: requiredText(raw.command),
    description: optionalText(raw.description),
    timeout: optionalNumber(raw.timeout),
    persistent: flag(raw.persistent),
  }),
  header: (args, { theme, expanded }) =>
    `${toolName(theme, "background_event_stream")}${headerDetails(theme, [
      args.command === null
        ? invalidArg(theme)
        : formatCommand(args.command, expanded ? {} : { maximum: 100, singleLine: true }),
      args.description ? safeId(args.description) : undefined,
      args.persistent
        ? "persistent"
        : args.timeout === undefined
          ? undefined
          : `${args.timeout}s timeout`,
    ])}`,
  body: (_args, result, ctx) => jobsBody(result, ctx, true),
});

// ---------------------------------------------------------------------------
// The three observer tools
// ---------------------------------------------------------------------------

/** Job ids as the extension itself lists them: the first few, then a count. */
function jobIdList(value: unknown): string {
  const ids = textList(value).map((id) => formatCommand(id, { maximum: 40, singleLine: true }));
  if (!ids.length) return "";
  const shown = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${shown}, +${ids.length - 3} more` : shown;
}

const statusTool = defineRenderer({
  names: ["background_status"],
  decode: (raw) => ({
    jobId: optionalText(raw.jobId),
    tailLines: optionalNumber(raw.tailLines),
  }),
  header: (args, { theme }) =>
    `${toolName(theme, "background_status")}${headerDetails(theme, [
      args.jobId ? safeId(args.jobId) : "recent jobs",
      args.tailLines === undefined ? undefined : `tail ${pluralize(args.tailLines, "line")}`,
    ])}`,
  body: (_args, result, ctx) => jobsBody(result, ctx, false),
});

const waitTool = defineRenderer({
  names: ["background_wait"],
  decode: (raw) => ({
    jobIds: jobIdList(raw.jobIds),
    timeout: optionalNumber(raw.timeout),
  }),
  header: (args, { theme }) =>
    `${toolName(theme, "background_wait")}${headerDetails(theme, [
      args.jobIds || undefined,
      // The wait timeout bounds this call only; it never stops the job.
      args.timeout === undefined ? undefined : `giving up after ${args.timeout}s`,
    ])}`,
  body: (_args, result, ctx) => jobsBody(result, ctx, false),
});

const stopTool = defineRenderer({
  names: ["background_stop"],
  decode: (raw) => ({ jobIds: jobIdList(raw.jobIds) }),
  header: (args, { theme }) =>
    `${toolName(theme, "background_stop")}${headerDetails(theme, [args.jobIds || undefined])}`,
  body: (_args, result, ctx) => jobsBody(result, ctx, false),
});

export const BACKGROUND_RENDERERS: readonly Renderer[] = [
  run,
  eventStream,
  statusTool,
  waitTool,
  stopTool,
];

export function backgroundRenderer(name: string): Renderer {
  const renderer = BACKGROUND_RENDERERS.find((entry) => entry.names.includes(name));
  if (!renderer) throw new Error(`no background renderer for ${name}`);
  return renderer;
}

// ---------------------------------------------------------------------------
// The two delivered messages
// ---------------------------------------------------------------------------

function boxed(text: string, theme: Theme, outputPad: number): Component {
  const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(text, 0, 0));
  return box;
}

/**
 * A finished job delivering its result as a follow-up message. It has no tool call to hang
 * off, so it summarizes the jobs on one line and shows the cards when expanded.
 */
export function renderCompletionMessage(
  detailsValue: unknown,
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
): Component {
  const view = jobsView(detailsValue);
  if (!view.jobs.length)
    return boxed(theme.fg("muted", "Background completion"), theme, options.outputPad);
  if (options.expanded) {
    return boxed(
      block([...view.jobs.map((job) => jobCard(job, theme, false)), ...jobsNotices(view, theme)]),
      theme,
      options.outputPad,
    );
  }
  const status = aggregateStatus(view.jobs);
  const listed = view.jobs
    .slice(0, MAX_SUMMARIZED_JOBS)
    .map((job) => `${safeId(job.jobId)} · ${formatStatus(job.status).label}`)
    .join(" · ");
  const more =
    view.jobs.length > MAX_SUMMARIZED_JOBS
      ? ` · +${view.jobs.length - MAX_SUMMARIZED_JOBS} more`
      : "";
  return boxed(
    block([
      statusLine(theme, jobStatusKey(status), {
        state: formatStatus(status).label,
        parts: [`${listed}${more}`],
        expanded: false,
      }),
      ...jobsNotices(view, theme),
    ]),
    theme,
    options.outputPad,
  );
}

/** One live event batch from a `background_event_stream` job. */
export function renderMonitorEventMessage(
  detailsValue: unknown,
  content: string,
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
  job: JobSnapshot | undefined,
): Component {
  const event = detailsValue as MonitorEvent | undefined;
  const head = [
    `■ ${safeId(event?.jobId ?? "event stream")}`,
    `#${event?.delivery ?? "?"}`,
    event?.firstSequence ? `${event.firstSequence}-${event.lastSequence}` : "event",
    event?.droppedLines ? `dropped ${event.droppedLines}` : "",
    event?.splitLines ? `split ${event.splitLines}` : "",
    event?.captureOnly ? "capture-only" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const hint = options.expanded ? undefined : expandHint(theme, false);
  // The batch's own lines are the point of an event stream, so they show in both states, as
  // they do in the browser. `content` is the model-facing block, which repeats the header
  // facts, so the decoded lines are preferred when they are there.
  const batch = (event?.lines?.length ? event.lines.join("\n") : content).trim();
  const lines = [
    theme.fg(event?.captureOnly ? "warning" : "success", head) + (hint ? ` · ${hint}` : ""),
    event?.deliveryError ? theme.fg("error", sanitizeRenderedValue(event.deliveryError)) : "",
    batch ? boundedOutput(theme, batch, options.expanded ? MAX_EVENT_LINES : MAX_TAIL_LINES) : "",
    // The event carries no job facts of its own; expanded borrows them from the live job.
    options.expanded && job ? jobCard({ ...job, tail: undefined }, theme, false) : "",
  ];
  return boxed(block(lines), theme, options.outputPad);
}
