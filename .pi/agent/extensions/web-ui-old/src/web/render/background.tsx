import { CodeBlock } from "../components/CodeBlock.js";
import { Facts } from "../components/Facts.js";
import { asArray, asRecord, num, str, type ToolView } from "../lib/tool-model.js";
import { compactCommand, formatBytes, formatDuration, pluralize } from "../lib/text.js";
import type { ToolAdapter } from "./types.js";

function jobList(view: ToolView): Record<string, unknown>[] {
  return asArray(view.details.jobs).map(asRecord);
}

function MonitorFacts({ monitor }: { monitor: Record<string, unknown> }) {
  return (
    <Facts
      items={[
        { label: "Deliveries", value: String(num(monitor.deliveries) ?? 0) },
        {
          label: "Dropped",
          value: `${num(monitor.droppedLines) ?? 0} lines / ${num(monitor.droppedBytes) ?? 0} bytes`,
        },
        num(monitor.splitLines)
          ? { label: "Split lines", value: String(num(monitor.splitLines)) }
          : null,
        {
          label: "Capture only",
          value: monitor.captureOnly === true ? "yes" : "no",
          tone: "muted",
        },
        str(monitor.deliveryError)
          ? { label: "Delivery error", value: str(monitor.deliveryError), tone: "error" }
          : null,
      ]}
    />
  );
}

function JobCard({ job }: { job: Record<string, unknown> }) {
  const status = str(job.status);
  const monitor = job.monitor ? asRecord(job.monitor) : undefined;
  const tail = str(job.tail);
  const exitCode = num(job.exitCode);
  return (
    <div class="job">
      <div class="job__head">
        <span class="job__command">{compactCommand(job.command)}</span>
        <span class={`job__status job__status--${status ?? "unknown"}`}>{status}</span>
      </div>
      <Facts
        items={[
          str(job.description) ? { label: "Task", value: str(job.description) } : null,
          { label: "Job", value: str(job.jobId) ?? "—", tone: "muted" },
          exitCode !== undefined
            ? { label: "Exit", value: String(exitCode), tone: exitCode === 0 ? "default" : "error" }
            : null,
          formatDuration(num(job.durationMs))
            ? { label: "Elapsed", value: formatDuration(num(job.durationMs)) }
            : null,
          formatBytes(num(job.outputBytes))
            ? { label: "Output", value: formatBytes(num(job.outputBytes)) }
            : null,
          str(job.deliveryState)
            ? { label: "Delivery", value: str(job.deliveryState), tone: "muted" }
            : null,
          str(job.outputPath) ? { label: "Log", value: str(job.outputPath), tone: "muted" } : null,
          str(job.error) ? { label: "Error", value: str(job.error), tone: "error" } : null,
          str(job.deliveryError)
            ? { label: "Delivery error", value: str(job.deliveryError), tone: "error" }
            : null,
          str(job.deliveryPersistenceError)
            ? {
                label: "Delivery persistence",
                value: str(job.deliveryPersistenceError),
                tone: "error",
              }
            : null,
          str(job.monitorDeliveryPersistenceError)
            ? {
                label: "Monitor persistence",
                value: str(job.monitorDeliveryPersistenceError),
                tone: "error",
              }
            : null,
        ]}
      />
      {monitor ? <MonitorFacts monitor={monitor} /> : null}
      {tail ? <CodeBlock code={tail} variant="output" /> : null}
      {job.tailTruncated === true ? <p class="jobs__note">Output tail truncated</p> : null}
    </div>
  );
}

function BackgroundJobs({ jobs }: { jobs: readonly Record<string, unknown>[] }) {
  return (
    <div class="jobs">
      {jobs.map((job, index) => (
        <JobCard key={str(job.jobId) ?? index} job={job} />
      ))}
    </div>
  );
}

function jobsSummary(view: ToolView, verb: string) {
  const jobs = jobList(view);
  const first = jobs[0];
  const status = first ? str(first.status) : undefined;
  return (
    <span>
      <span class="tool__phase">{status ?? verb}</span>
      {jobs.length > 1 ? (
        <span class="tool__preview"> — {pluralize(jobs.length, "job")}</span>
      ) : null}
    </span>
  );
}

function backgroundAdapter(config: { label: string; glyph: string; verb: string }): ToolAdapter {
  return {
    glyph: config.glyph,
    label: config.label,
    title: (view) => {
      const jobs = jobList(view);
      const command = str(view.args.command) ?? str(jobs[0]?.command);
      const description = str(view.args.description) ?? str(jobs[0]?.description);
      return (
        <span class="tool__command">
          {command ? compactCommand(command) : config.label}
          {description ? <span class="tool__hint"> · {description}</span> : null}
        </span>
      );
    },
    summary: (view) => {
      if (view.isError) return `failed · ${view.text.split("\n")[0] || "error"}`;
      return jobsSummary(view, config.verb);
    },
    detail: (view) => {
      const jobs = jobList(view);
      const omitted = num(view.details.omittedCount) ?? 0;
      const omittedJobs = asRecord(view.details.omittedJobs);
      if (view.isError && view.text) {
        return <CodeBlock code={view.text} variant="output" />;
      }
      if (jobs.length === 0 && !view.text && omitted === 0) return undefined;
      return (
        <>
          {jobs.length > 0 ? <BackgroundJobs jobs={jobs} /> : null}
          {jobs.length === 0 && view.text ? <CodeBlock code={view.text} variant="output" /> : null}
          {omitted > 0 ? (
            <p class="jobs__note">
              {pluralize(omitted, "job")} omitted
              {str(omittedJobs.firstJobId) && str(omittedJobs.lastJobId)
                ? ` (${str(omittedJobs.firstJobId)}…${str(omittedJobs.lastJobId)})`
                : ""}
              {str(omittedJobs.guidance) ? ` — ${str(omittedJobs.guidance)}` : ""}
            </p>
          ) : null}
          {view.details.truncated === true && omitted === 0 ? (
            <p class="jobs__note">Result payload or output tail truncated</p>
          ) : null}
        </>
      );
    },
  };
}

export const backgroundAdapters: Record<string, ToolAdapter> = {
  background_run: backgroundAdapter({ label: "background run", glyph: "⟳", verb: "started" }),
  background_event_stream: backgroundAdapter({
    label: "event stream",
    glyph: "≋",
    verb: "streaming",
  }),
  background_status: backgroundAdapter({ label: "background status", glyph: "◔", verb: "queried" }),
  background_wait: backgroundAdapter({ label: "background wait", glyph: "◷", verb: "settled" }),
  background_stop: backgroundAdapter({ label: "background stop", glyph: "◼", verb: "stopped" }),
};
