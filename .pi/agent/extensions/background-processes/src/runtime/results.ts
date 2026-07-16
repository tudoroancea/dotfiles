import { Buffer } from "node:buffer";
import { MAX_GENERATED_JOB_ID, MAX_JOB_NUMBER } from "./job-store.ts";
import { sanitizeMonitorText } from "./monitor.ts";
import type { JobRecord } from "./types.ts";

export const RESULT_MAX_BYTES = 50 * 1024;
export const RESULT_MAX_LINES = 2_000;
const MAX_RESULT_JOBS = 50;

export interface CompactMonitorStatus {
  deliveries: number;
  droppedLines: number;
  droppedBytes: number;
  splitLines: number;
  captureOnly: boolean;
  deliveryError?: string;
  completionOutput?: "no_output" | "all_delivered_live" | "remaining";
}

export interface JobSnapshot {
  jobId: string;
  kind: JobRecord["kind"];
  status: JobRecord["status"];
  description?: string;
  cwd?: string;
  createdAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  error?: string;
  requestedTerminalCause?: JobRecord["requestedTerminalCause"];
  outputBytes?: number;
  outputPath?: string;
  metadataPath?: string;
  deliveryState: JobRecord["deliveryState"];
  deliveryAttemptedAt?: string;
  deliveryError?: string;
  deliveryPersistenceError?: string;
  monitorDeliveryPersistenceError?: string;
  monitor?: CompactMonitorStatus;
  tail?: string;
  tailTruncated?: boolean;
}

export interface OmittedJobs {
  count: number;
  firstJobId: string;
  lastJobId: string;
  guidance: string;
}

export interface SerializedJobs {
  jobs: JobSnapshot[];
  text: string;
  truncated: boolean;
  omittedCount: number;
  omittedJobs?: OmittedJobs;
}

function lineCount(value: string): number {
  if (!value) return 0;
  let count = value.endsWith("\n") ? 0 : 1;
  for (const character of value) if (character === "\n") count += 1;
  return count;
}

function isBounded(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= RESULT_MAX_BYTES && lineCount(value) <= RESULT_MAX_LINES
  );
}

function safeLine(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeMonitorText(value).replace(/\s+/g, " ").trim();
}

function truncate(value: string | undefined, maxBytes: number): string | undefined {
  const normalized = safeLine(value);
  if (normalized === undefined || Buffer.byteLength(normalized, "utf8") <= maxBytes)
    return normalized;
  const suffix = "…";
  const bytes = Buffer.from(normalized, "utf8");
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

function boundedPath(value: string | undefined, maxBytes: number): string | undefined {
  const normalized = safeLine(value);
  if (normalized === undefined || Buffer.byteLength(normalized, "utf8") <= maxBytes)
    return normalized;
  const bytes = Buffer.from(normalized, "utf8");
  const prefixBytes = Math.floor((maxBytes - Buffer.byteLength("…")) / 2);
  let start = bytes.length - (maxBytes - prefixBytes - Buffer.byteLength("…"));
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return `${truncate(normalized, prefixBytes)}${bytes.subarray(start).toString("utf8")}`;
}

function truncateError(value: string | undefined, maxBytes: number): string | undefined {
  return boundedPath(value, maxBytes);
}

function truncatePersistenceError(value: string | undefined, maxBytes: number): string | undefined {
  const normalized = safeLine(value);
  if (normalized === undefined) return undefined;
  const retry = normalized.indexOf("after retry");
  return truncateError(retry < 0 ? normalized : normalized.slice(retry), maxBytes);
}

function durationMs(record: JobRecord, now: number): number {
  const start = Date.parse(record.createdAt);
  const end = record.completedAt ? Date.parse(record.completedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function compactSnapshot(record: JobRecord, now = Date.now()): JobSnapshot {
  const monitor = record.kind === "background_event_stream";
  return {
    jobId: safeLine(record.id)!,
    kind: record.kind,
    status: record.status,
    description: monitor ? undefined : truncate(record.description, 12),
    cwd: monitor ? undefined : boundedPath(record.cwd, 12)!,
    createdAt: monitor ? undefined : truncate(record.createdAt, 12)!,
    completedAt: monitor ? undefined : truncate(record.completedAt, 12),
    durationMs: monitor ? undefined : durationMs(record, now),
    exitCode: record.exitCode,
    error: truncateError(record.error, 24),
    requestedTerminalCause: monitor ? undefined : record.requestedTerminalCause,
    outputBytes: monitor ? undefined : record.outputBytes,
    outputPath: record.outputPath,
    metadataPath: record.metadataPath,
    deliveryState: record.deliveryState,
    deliveryAttemptedAt: truncate(record.deliveryAttemptedAt, 24),
    deliveryError: truncateError(record.deliveryError, 24),
    deliveryPersistenceError: truncatePersistenceError(record.deliveryPersistenceError, 24),
    monitorDeliveryPersistenceError: truncatePersistenceError(
      record.monitorDeliveryPersistenceError,
      32,
    ),
    monitor: record.monitor
      ? {
          deliveries: record.monitor.deliveries,
          droppedLines: record.monitor.droppedLines,
          droppedBytes: record.monitor.droppedBytes,
          splitLines: record.monitor.splitLines,
          captureOnly: record.monitor.captureOnly,
          deliveryError: truncateError(record.monitor.deliveryError, 12),
          completionOutput: record.monitor.completionOutput,
        }
      : undefined,
  };
}

export function selectTailLines(value: string, maximum: number): string {
  if (maximum <= 0 || value.length === 0) return "";
  const trailingNewline = value.endsWith("\n");
  const lines = value.split("\n");
  if (trailingNewline) lines.pop();
  const selected = lines.slice(Math.max(0, lines.length - maximum)).join("\n");
  return trailingNewline && selected ? `${selected}\n` : selected;
}

function omittedJobs(records: JobRecord[], includedCount: number): OmittedJobs | undefined {
  const omitted = records.slice(includedCount);
  if (omitted.length === 0) return undefined;
  return {
    count: omitted.length,
    firstJobId: truncate(omitted[0]!.id, 96)!,
    lastJobId: truncate(omitted.at(-1)!.id, 96)!,
    guidance: "Use background_status or the job artifacts to inspect omitted completion details.",
  };
}

function stringify(jobs: JobSnapshot[], truncated: boolean, omitted?: OmittedJobs): string {
  return JSON.stringify({
    jobs,
    truncated,
    omittedCount: omitted?.count ?? 0,
    ...(omitted ? { omittedJobs: omitted } : {}),
  });
}

function largestCompactSnapshot(kind: JobRecord["kind"], pathBytes: number): JobSnapshot {
  const common: JobSnapshot = {
    jobId: kind === "background_event_stream" ? MAX_GENERATED_JOB_ID : `bg_${MAX_JOB_NUMBER}`,
    kind,
    status: "cleanup_failed",
    exitCode: Number.MIN_SAFE_INTEGER,
    error: "x".repeat(24),
    outputPath: "x".repeat(pathBytes),
    metadataPath: "x".repeat(pathBytes),
    deliveryState: "sending",
    deliveryAttemptedAt: "x".repeat(24),
    deliveryError: "x".repeat(24),
    deliveryPersistenceError: "x".repeat(24),
    monitorDeliveryPersistenceError: "x".repeat(32),
    tailTruncated: true,
  };
  if (kind === "background_run") {
    return {
      ...common,
      description: "x".repeat(12),
      cwd: "x".repeat(12),
      createdAt: "x".repeat(12),
      completedAt: "x".repeat(12),
      durationMs: MAX_JOB_NUMBER,
      requestedTerminalCause: "output_error",
      outputBytes: MAX_JOB_NUMBER,
    };
  }
  return {
    ...common,
    monitor: {
      deliveries: MAX_JOB_NUMBER,
      droppedLines: MAX_JOB_NUMBER,
      droppedBytes: MAX_JOB_NUMBER,
      splitLines: MAX_JOB_NUMBER,
      captureOnly: true,
      deliveryError: "x".repeat(12),
      completionOutput: "remaining",
    },
  };
}

function completionSafeArtifactPathMaximum(kind: JobRecord["kind"]): number {
  let low = 0;
  let high = RESULT_MAX_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const jobs = Array.from({ length: MAX_RESULT_JOBS }, () =>
      largestCompactSnapshot(kind, middle),
    );
    if (isBounded(stringify(jobs, true))) low = middle;
    else high = middle - 1;
  }
  return low;
}

export const ARTIFACT_JOB_PATH_MAX_BYTES = Math.min(
  completionSafeArtifactPathMaximum("background_run"),
  completionSafeArtifactPathMaximum("background_event_stream"),
);

function fitTail(jobs: JobSnapshot[], index: number, tail: string, omitted?: OmittedJobs): boolean {
  let low = 0;
  let high = tail.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    jobs[index]!.tail = tail.slice(tail.length - middle);
    if (isBounded(stringify(jobs, true, omitted))) low = middle;
    else high = middle - 1;
  }
  jobs[index]!.tail = tail.slice(tail.length - low);
  return low < tail.length;
}

export function serializeJobs(
  records: JobRecord[],
  options: { includeTails?: boolean; tailLines?: number; maxJobs?: number } = {},
): SerializedJobs {
  const limit = Math.max(0, Math.min(options.maxJobs ?? MAX_RESULT_JOBS, MAX_RESULT_JOBS));
  const jobs: JobSnapshot[] = [];
  for (const record of records.slice(0, limit)) {
    const snapshot = compactSnapshot(record);
    const candidate = [...jobs, snapshot];
    const omission = omittedJobs(records, candidate.length);
    if (!isBounded(stringify(candidate, Boolean(omission), omission))) break;
    jobs.push(snapshot);
  }

  let omission = omittedJobs(records, jobs.length);
  let truncated = Boolean(omission);
  if (options.includeTails) {
    const maximumLines = Math.max(
      0,
      Math.min(options.tailLines ?? RESULT_MAX_LINES, RESULT_MAX_LINES),
    );
    for (let index = 0; index < jobs.length; index += 1) {
      const record = records[index]!;
      const snapshot = record.terminalTail;
      if (!snapshot?.content) {
        if (record.status !== "running" && maximumLines > 0) {
          jobs[index]!.tail =
            record.monitor?.completionOutput === "all_delivered_live"
              ? "(all monitor output was delivered live)"
              : record.monitor?.completionOutput === "remaining"
                ? "(monitor output was captured; inspect the artifact)"
                : "(no output)";
        }
        continue;
      }
      const tail = selectTailLines(snapshot.content, maximumLines);
      if (maximumLines === 0) continue;
      jobs[index]!.tail = "";
      const wasFitted = fitTail(jobs, index, tail, omission);
      const tailTruncated = wasFitted || snapshot.truncated || tail !== snapshot.content;
      jobs[index]!.tailTruncated = tailTruncated || undefined;
      truncated ||= tailTruncated;
    }
  }

  let text = stringify(jobs, truncated, omission);
  if (!isBounded(text)) {
    for (const job of jobs) {
      delete job.tail;
      job.tailTruncated = true;
    }
    truncated = true;
    text = stringify(jobs, truncated, omission);
  }
  // Snapshot field and list caps make this unreachable for schema-valid inputs. Keep the
  // function total if a future field changes that invariant.
  while (!isBounded(text) && jobs.length > 0) {
    jobs.pop();
    omission = omittedJobs(records, jobs.length);
    truncated = true;
    text = stringify(jobs, truncated, omission);
  }
  return {
    jobs,
    text,
    truncated,
    omittedCount: omission?.count ?? 0,
    ...(omission ? { omittedJobs: omission } : {}),
  };
}
