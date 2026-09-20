// The background-processes extension's tools and its two displayed messages.
//
// Two tools launch a job (`background_run` for one completion notification,
// `background_event_stream` for live event batches); three observe jobs already
// running (`background_status`, `background_wait`, `background_stop`). Every result
// carries the same job list — see `src/wire/background.ts`.
//
// A launching tool's header names the command, so its job cards omit it. An observer
// has no command of its own, so its cards keep it.

import { useEffect, useState } from "preact/hooks";
import {
  decodeBackgroundJobsView,
  decodeBackgroundMonitorEventView,
  type BackgroundJobsView,
  type BackgroundJobStatus,
  type BackgroundJobView,
} from "../../wire/background.ts";
import {
  compactCommand,
  formatBytes,
  formatDuration,
  pluralize,
  shortenPath,
  statusIcon,
} from "../format.ts";
import {
  ExpandableOutput,
  Facts,
  isPlainDisclosureClick,
  Output,
  StatusLine,
  Summary,
  useDisclosure,
  useLiveNow,
} from "./shared.tsx";
import {
  defineTool,
  flag,
  optionalNumber,
  optionalText,
  requiredText,
  textList,
  type RegisteredTool,
  type ToolContext,
  type ToolResultView,
  type ToolStatus,
} from "./types.ts";

/** The box tone a job status maps to, and how it reads. */
function jobTone(status: BackgroundJobStatus): ToolStatus {
  if (status === "completed") return "success";
  if (status === "running") return "pending";
  return status === "unknown" ? "pending" : "error";
}

function jobLabel(status: BackgroundJobStatus): string {
  return status.replaceAll("_", " ");
}

/**
 * Job statuses onto the shared status vocabulary the icons and `status-*` classes
 * use. The extension's extra terminal states have no icon of their own, so they
 * borrow the failure one and keep their real name as the label.
 */
function jobStatusKey(status: BackgroundJobStatus): string {
  if (status === "timed_out" || status === "cleanup_failed") return "failed";
  return status === "unknown" ? "queued" : status;
}

/** The worst state in the list, so a collapsed box reports the outcome that matters. */
function aggregateStatus(jobs: readonly BackgroundJobView[]): BackgroundJobStatus {
  const tones = jobs.map((job) => jobTone(job.status));
  if (tones.includes("error")) return jobs.find((job) => jobTone(job.status) === "error")!.status;
  if (jobs.some((job) => job.status === "running")) return "running";
  return jobs.length ? "completed" : "unknown";
}

/** The live-output bookkeeping only an event-stream job carries. */
function monitorFacts(job: BackgroundJobView) {
  const monitor = job.monitor;
  if (!monitor) return [];
  const completion = {
    "": "",
    no_output: "produced no output",
    all_delivered_live: "all output delivered live",
    remaining: "output captured to the log",
  }[monitor.completionOutput];
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
    { label: "Final output", value: completion },
  ];
}

/**
 * A job's elapsed time, advanced by `liveMs` while it is still running.
 *
 * `durationMs` was measured when the extension serialized the payload and never moves again, and
 * the snapshot carries no start timestamp to measure against instead — an event-stream job omits
 * `createdAt`, and a plain run's is bounded to a few bytes. So a running job's elapsed time is
 * its serialized duration plus how long this card has been on screen, which is as close to the
 * real one as the payload allows.
 */
function jobElapsed(job: BackgroundJobView, liveMs: number): string {
  return formatDuration(job.durationMs + (job.status === "running" ? liveMs : 0));
}

/**
 * How long this list has been mounted, ticking while a job is still running.
 *
 * Mount is the only anchor available: scrolling a card out of the virtualized transcript and
 * back re-anchors it, which snaps a running job's elapsed time back to the payload's own.
 */
function useShownFor(live: boolean): number {
  const { now, setLive } = useLiveNow();
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => setLive(live), [live, setLive]);
  return Math.max(0, now - mountedAt);
}

function JobCard({
  job,
  dkey,
  describedByHeader,
  liveMs,
}: {
  job: BackgroundJobView;
  dkey: string;
  /**
   * A launching tool's header already carries this job's command and description, so
   * the card leads with the job id and drops both. An observer's header carries
   * neither, so its cards keep them.
   */
  describedByHeader: boolean;
  liveMs: number;
}) {
  return (
    <div class="background-job">
      <div class="structured-head">
        <span>{describedByHeader ? job.jobId : compactCommand(job.command)}</span>
        <span class={`structured-status status-${jobStatusKey(job.status)}`}>
          {statusIcon(jobStatusKey(job.status))} {jobLabel(job.status)}
        </span>
      </div>
      <Facts
        items={[
          { label: "Job", value: describedByHeader ? "" : job.jobId },
          { label: "Task", value: describedByHeader ? "" : job.description },
          { label: "Kind", value: job.kind === "background_event_stream" ? "event stream" : "" },
          { label: "Cwd", value: shortenPath(job.cwd) },
          {
            label: "Exit",
            value: job.exitCode === undefined ? "" : String(job.exitCode),
            error: (job.exitCode ?? 0) !== 0,
          },
          { label: "Stopped by", value: job.terminalCause.replaceAll("_", " ") },
          { label: "Elapsed", value: jobElapsed(job, liveMs) },
          { label: "Output", value: formatBytes(job.outputBytes) },
          { label: "Delivery", value: job.deliveryState },
          { label: "Log", value: shortenPath(job.outputPath) },
          ...monitorFacts(job),
        ]}
      />
      {job.errors.map((error, index) => (
        <p key={index} class="tool-error">
          {error}
        </p>
      ))}
      {job.tail ? <ExpandableOutput text={job.tail} maxLines={10} dkey={`${dkey}:tail`} /> : null}
      {job.tailTruncated ? <p class="structured-muted">Output tail truncated</p> : null}
    </div>
  );
}

/** The job list, plus whatever the extension had to leave out to stay in budget. */
export function JobList({
  view,
  dkey,
  describedByHeader = false,
}: {
  view: BackgroundJobsView;
  dkey: string;
  describedByHeader?: boolean;
}) {
  const liveMs = useShownFor(view.jobs.some((job) => job.status === "running"));
  return (
    <>
      <div class="background-jobs">
        {view.jobs.map((job) => (
          <JobCard
            key={job.jobId}
            job={job}
            dkey={`${dkey}:job:${job.jobId}`}
            describedByHeader={describedByHeader}
            liveMs={liveMs}
          />
        ))}
      </div>
      {view.omittedCount ? (
        <p class="structured-muted">
          {pluralize(view.omittedCount, "job")} omitted
          {view.omittedRange ? ` (${view.omittedRange})` : ""}
          {view.omittedGuidance ? ` — ${view.omittedGuidance}` : ""}
        </p>
      ) : null}
      {view.truncated && !view.omittedCount ? (
        <p class="structured-muted">Result payload or output tail truncated</p>
      ) : null}
    </>
  );
}

function jobsBody(
  result: ToolResultView | undefined,
  ctx: ToolContext,
  describedByHeader: boolean,
) {
  if (!result) return null;
  const view = decodeBackgroundJobsView(result.details);
  if (!view?.jobs.length) {
    // No readable job list: the tool's own text is all there is.
    if (!result.text) return null;
    return ctx.expanded ? (
      <Output text={result.text} isError={result.isError} />
    ) : (
      <Summary text={result.text.split("\n")[0]} status={result.isError ? "error" : undefined} />
    );
  }
  if (!ctx.expanded) {
    const status = aggregateStatus(view.jobs);
    return (
      <StatusLine
        status={jobStatusKey(status)}
        state={jobLabel(status)}
        parts={[pluralize(view.jobs.length, "job")]}
        expanded={false}
      />
    );
  }
  return (
    <div class="tool-details-body">
      <JobList view={view} dkey={ctx.dkey} describedByHeader={describedByHeader} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The two launching tools
// ---------------------------------------------------------------------------

const run = defineTool({
  names: ["background_run"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw) => ({
    command: requiredText(raw.command),
    description: optionalText(raw.description),
    timeout: optionalNumber(raw.timeout),
  }),
  header: (args, { expanded }) => (
    <>
      <span class="tool-name">background_run</span>
      <span class="tool-command-inline">
        {" · "}
        {args.command === null
          ? "[invalid arg]"
          : expanded
            ? args.command
            : compactCommand(args.command)}
      </span>
      {args.description ? <span class="line-count"> · {args.description}</span> : null}
      {args.timeout === undefined ? null : (
        <span class="line-count">{` · ${args.timeout}s timeout`}</span>
      )}
    </>
  ),
  body: (_args, result, ctx) => jobsBody(result, ctx, true),
});

const eventStream = defineTool({
  names: ["background_event_stream"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw) => ({
    command: requiredText(raw.command),
    description: optionalText(raw.description),
    timeout: optionalNumber(raw.timeout),
    persistent: flag(raw.persistent),
  }),
  header: (args, { expanded }) => (
    <>
      <span class="tool-name">background_event_stream</span>
      <span class="tool-command-inline">
        {" · "}
        {args.command === null
          ? "[invalid arg]"
          : expanded
            ? args.command
            : compactCommand(args.command)}
      </span>
      {args.description ? <span class="line-count"> · {args.description}</span> : null}
      <span class="line-count">
        {args.persistent
          ? " · persistent"
          : args.timeout === undefined
            ? ""
            : ` · ${args.timeout}s timeout`}
      </span>
    </>
  ),
  body: (_args, result, ctx) => jobsBody(result, ctx, true),
});

// ---------------------------------------------------------------------------
// The three observer tools
// ---------------------------------------------------------------------------

/** Job ids as the extension itself lists them: the first few, then a count. */
function jobIdList(value: unknown): string {
  const ids = textList(value);
  if (!ids.length) return "";
  const shown = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${shown}, +${ids.length - 3} more` : shown;
}

const statusTool = defineTool({
  names: ["background_status"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw) => ({
    jobId: optionalText(raw.jobId),
    tailLines: optionalNumber(raw.tailLines),
  }),
  header: (args) => (
    <>
      <span class="tool-name">background_status</span>
      <span class="line-count"> · {args.jobId || "recent jobs"}</span>
      {args.tailLines === undefined ? null : (
        <span class="line-count">{` · tail ${pluralize(args.tailLines, "line")}`}</span>
      )}
    </>
  ),
  body: (_args, result, ctx) => jobsBody(result, ctx, false),
});

const waitTool = defineTool({
  names: ["background_wait"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw) => ({
    jobIds: jobIdList(raw.jobIds),
    timeout: optionalNumber(raw.timeout),
  }),
  header: (args) => (
    <>
      <span class="tool-name">background_wait</span>
      {args.jobIds ? <span class="line-count"> · {args.jobIds}</span> : null}
      {/* The wait timeout bounds this call only; it never stops the job. */}
      {args.timeout === undefined ? null : (
        <span class="line-count">{` · giving up after ${args.timeout}s`}</span>
      )}
    </>
  ),
  body: (_args, result, ctx) => jobsBody(result, ctx, false),
});

const stopTool = defineTool({
  names: ["background_stop"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw) => ({ jobIds: jobIdList(raw.jobIds) }),
  header: (args) => (
    <>
      <span class="tool-name">background_stop</span>
      {args.jobIds ? <span class="line-count"> · {args.jobIds}</span> : null}
    </>
  ),
  body: (_args, result, ctx) => jobsBody(result, ctx, false),
});

// ---------------------------------------------------------------------------
// The two displayed messages
// ---------------------------------------------------------------------------

/**
 * A finished job delivering its result as a follow-up message. It has no tool call
 * to hang off, so it summarizes the jobs on one line and gates the cards behind a
 * disclosure of its own.
 */
export function BackgroundCompletionMessage({ details, dkey }: { details: unknown; dkey: string }) {
  const view = decodeBackgroundJobsView(details);
  const [expanded, setExpanded] = useDisclosure(`${dkey}:jobs`, false);
  if (!view?.jobs.length) return null;
  const status = aggregateStatus(view.jobs);
  const summary = view.jobs
    .slice(0, 3)
    .map((job) => `${job.jobId} · ${jobLabel(job.status)}`)
    .join(" · ");
  const more = view.jobs.length > 3 ? ` · +${view.jobs.length - 3} more` : "";
  const toggle = () => setExpanded(!expanded);
  return (
    <div
      class="background-completion clickable-disclosure"
      onClick={(event) => {
        if (isPlainDisclosureClick(event)) toggle();
      }}
    >
      <div class="tool-header">
        <span class={`structured-status status-${jobStatusKey(status)}`}>
          {statusIcon(jobStatusKey(status))} {jobLabel(status)}
        </span>{" "}
        <span class="line-count">
          {summary}
          {more}
        </span>
      </div>
      <div class="tool-details">
        <button
          type="button"
          class="tool-details-toggle"
          aria-expanded={expanded ? "true" : "false"}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {expanded ? "▾" : "▸"} {pluralize(view.jobs.length, "job")}
        </button>
        {expanded ? (
          <div class="tool-details-body">
            <JobList view={view} dkey={dkey} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One live event batch from a `background_event_stream` job. */
export function BackgroundMonitorEventMessage({
  details,
  content,
  dkey,
}: {
  details: unknown;
  /** The message's own rendered text, which is the batch's lines. */
  content: string;
  dkey: string;
}) {
  const event = decodeBackgroundMonitorEventView(details);
  const lines = event?.lines.length ? event.lines.join("\n") : content;
  return (
    <>
      <div class={`background-event-line ${event?.captureOnly ? "warning" : "success"}`}>
        <span aria-hidden="true">■ </span>
        {event?.jobId || "event stream"} #{event?.delivery || "?"} {event?.sequenceRange || "event"}
        {event?.droppedLines ? ` · dropped ${event.droppedLines}` : ""}
        {event?.splitLines ? ` · split ${event.splitLines}` : ""}
        {event?.captureOnly ? " · capture-only" : ""}
      </div>
      {event?.deliveryError ? <p class="tool-error">{event.deliveryError}</p> : null}
      {lines.trim() ? (
        <ExpandableOutput text={lines.trim()} maxLines={10} dkey={`${dkey}:out`} />
      ) : null}
    </>
  );
}

export const BACKGROUND_TOOLS: readonly RegisteredTool[] = [
  run,
  eventStream,
  statusTool,
  waitTool,
  stopTool,
];
