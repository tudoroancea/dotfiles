import type { JobSnapshot } from "../runtime/results.ts";
import {
  boundText,
  formatCommand,
  formatCwd,
  formatDuration,
  formatStatus,
  sanitizeRenderedValue,
} from "./formatters.ts";

const MAX_JOB_DETAILS = 12_000;
const MAX_ALL_DETAILS = 20_000;

function kindLabel(job: JobSnapshot): string {
  return job.kind === "background_event_stream" ? "event stream" : "background command";
}

function monitorDetail(job: JobSnapshot): string | undefined {
  if (!job.monitor) return undefined;
  const monitor = job.monitor;
  return [
    `${monitor.deliveries} deliveries`,
    monitor.droppedLines ? `${monitor.droppedLines} dropped` : "",
    monitor.captureOnly ? "capture-only" : "",
    monitor.deliveryError ? `send error: ${sanitizeRenderedValue(monitor.deliveryError)}` : "",
    job.monitorDeliveryPersistenceError ? "checkpoint error" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatCompactJob(job: JobSnapshot): string {
  const status = formatStatus(job.status);
  const identity = formatCommand(job.description || job.command || job.jobId, {
    maximum: 80,
    singleLine: true,
  });
  const elapsed = job.durationMs === undefined ? "" : ` · ${formatDuration(job.durationMs)}`;
  return `${status.icon} ${identity} · ${status.label}${elapsed}`;
}

export function formatCompactJobs(jobs: JobSnapshot[]): string {
  if (!jobs.length) return "No jobs";
  const shown = jobs.slice(0, 3).map(formatCompactJob).join(" · ");
  return jobs.length > 3 ? `${shown} · +${jobs.length - 3} more` : shown;
}

export function formatJobDetails(job: JobSnapshot): string {
  const status = formatStatus(job.status);
  const lines = [
    formatCwd(job.cwd),
    `$ ${formatCommand(job.command ?? "")}`,
    "",
    `${status.icon} ${status.label} · ${formatDuration(job.durationMs ?? 0)} · ${kindLabel(job)}`,
    job.exitCode !== undefined ? `Exit: ${job.exitCode ?? "signal"}` : "",
    job.requestedTerminalCause
      ? `Terminal cause: ${sanitizeRenderedValue(job.requestedTerminalCause)}`
      : "",
    job.error ? `Error: ${sanitizeRenderedValue(job.error)}` : "",
    "",
    "Output",
    job.tail
      ? `${job.tailTruncated ? "[Earlier output omitted]\n" : ""}${sanitizeRenderedValue(job.tail)}`
      : `${job.outputBytes ?? 0} bytes captured`,
    "",
    "Delivery",
    `completion: ${job.deliveryState}`,
    job.deliveryError ? `error: ${sanitizeRenderedValue(job.deliveryError)}` : "",
    job.deliveryPersistenceError
      ? `checkpoint error: ${sanitizeRenderedValue(job.deliveryPersistenceError)}`
      : "",
    monitorDetail(job) ?? "",
    "",
    "Artifacts",
    job.outputPath ? `output: ${sanitizeRenderedValue(job.outputPath)}` : "output: unavailable",
    job.metadataPath
      ? `metadata: ${sanitizeRenderedValue(job.metadataPath)}`
      : "metadata: unavailable",
  ];
  return boundText(
    lines
      .filter((line, index) => line !== "" || lines[index - 1] !== "")
      .join("\n")
      .trim(),
    MAX_JOB_DETAILS,
  );
}

export function formatJobDetailsList(jobs: JobSnapshot[]): string {
  if (!jobs.length) return "No jobs";
  return boundText(jobs.map(formatJobDetails).join("\n\n────────\n\n"), MAX_ALL_DETAILS);
}
