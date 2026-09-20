import {
  Array as TypeArray,
  Boolean as TypeBoolean,
  Literal as TypeLiteral,
  Number as TypeNumber,
  Object as TypeObject,
  Optional as TypeOptional,
  String as TypeString,
  Union as TypeUnion,
  type Static,
  type TProperties,
} from "typebox";
import { Check } from "typebox/value";

/**
 * Browser normalization limits for the job payloads the locally installed
 * background-processes extension puts in tool-result details and in its two
 * displayed custom messages. Every `background_*` tool returns the same
 * `SerializedJobs` shape, so one decoder feeds one renderer for all of them.
 *
 * These are renderer-view limits, not obligations on the extension.
 */
export const BACKGROUND_LIMITS = {
  maxJobs: 50,
  maxIdChars: 128,
  maxCommandChars: 2_048,
  maxPathChars: 1_024,
  maxErrorChars: 1_024,
  maxTailChars: 64 * 1_024,
  maxLines: 512,
  maxCount: 0x7fff_ffff,
} as const;

const StrictObject = <T extends TProperties>(properties: T) =>
  TypeObject(properties, { additionalProperties: false });
const CountSchema = TypeNumber({ minimum: 0, maximum: BACKGROUND_LIMITS.maxCount, multipleOf: 1 });

/** Mirrors the extension's `JobKind`; anything else normalizes to "background_run". */
export const BackgroundJobKindSchema = TypeUnion([
  TypeLiteral("background_run"),
  TypeLiteral("background_event_stream"),
]);
export type BackgroundJobKind = Static<typeof BackgroundJobKindSchema>;

/** Mirrors the extension's `JobStatus`; anything else normalizes to "unknown". */
export const BackgroundJobStatusSchema = TypeUnion([
  TypeLiteral("running"),
  TypeLiteral("completed"),
  TypeLiteral("failed"),
  TypeLiteral("timed_out"),
  TypeLiteral("cancelled"),
  TypeLiteral("cleanup_failed"),
  TypeLiteral("unknown"),
]);
export type BackgroundJobStatus = Static<typeof BackgroundJobStatusSchema>;

/** Mirrors the extension's `DeliveryState`; an unreadable state becomes "". */
export const BackgroundDeliveryStateSchema = TypeUnion([
  TypeLiteral(""),
  TypeLiteral("pending"),
  TypeLiteral("sending"),
  TypeLiteral("sent"),
  TypeLiteral("failed"),
  TypeLiteral("consumed"),
]);
export type BackgroundDeliveryState = Static<typeof BackgroundDeliveryStateSchema>;

/** Mirrors the extension's `RequestedTerminalCause`; absent when the job ended on its own. */
export const BackgroundTerminalCauseSchema = TypeUnion([
  TypeLiteral(""),
  TypeLiteral("timeout"),
  TypeLiteral("stop"),
  TypeLiteral("shutdown"),
  TypeLiteral("output_limit"),
  TypeLiteral("output_error"),
]);
export type BackgroundTerminalCause = Static<typeof BackgroundTerminalCauseSchema>;

/** Mirrors the extension's `CompactMonitorStatus.completionOutput`. */
export const BackgroundCompletionOutputSchema = TypeUnion([
  TypeLiteral(""),
  TypeLiteral("no_output"),
  TypeLiteral("all_delivered_live"),
  TypeLiteral("remaining"),
]);
export type BackgroundCompletionOutput = Static<typeof BackgroundCompletionOutputSchema>;

/** The live-output bookkeeping an event-stream job carries; absent for plain runs. */
export const BackgroundMonitorViewSchema = StrictObject({
  deliveries: CountSchema,
  droppedLines: CountSchema,
  droppedBytes: CountSchema,
  splitLines: CountSchema,
  captureOnly: TypeBoolean(),
  completionOutput: BackgroundCompletionOutputSchema,
  deliveryError: TypeString({ maxLength: BACKGROUND_LIMITS.maxErrorChars }),
});
export type BackgroundMonitorView = Static<typeof BackgroundMonitorViewSchema>;

export const BackgroundJobViewSchema = StrictObject({
  jobId: TypeString({ maxLength: BACKGROUND_LIMITS.maxIdChars }),
  kind: BackgroundJobKindSchema,
  status: BackgroundJobStatusSchema,
  command: TypeString({ maxLength: BACKGROUND_LIMITS.maxCommandChars }),
  description: TypeString({ maxLength: BACKGROUND_LIMITS.maxCommandChars }),
  cwd: TypeString({ maxLength: BACKGROUND_LIMITS.maxPathChars }),
  /** Elapsed run time in milliseconds; 0 when the extension reported none. */
  durationMs: CountSchema,
  /** A finished process's exit status; absent while running or when killed by signal. */
  exitCode: TypeOptional(TypeNumber()),
  /** Why the runtime ended the job, when it was not the process's own choice. */
  terminalCause: BackgroundTerminalCauseSchema,
  outputBytes: CountSchema,
  outputPath: TypeString({ maxLength: BACKGROUND_LIMITS.maxPathChars }),
  metadataPath: TypeString({ maxLength: BACKGROUND_LIMITS.maxPathChars }),
  deliveryState: BackgroundDeliveryStateSchema,
  /** Every failure the job carries, from the process and from result delivery. */
  errors: TypeArray(TypeString({ maxLength: BACKGROUND_LIMITS.maxErrorChars }), {
    maxItems: 8,
  }),
  monitor: TypeOptional(BackgroundMonitorViewSchema),
  tail: TypeString({ maxLength: BACKGROUND_LIMITS.maxTailChars }),
  tailTruncated: TypeBoolean(),
});
export type BackgroundJobView = Static<typeof BackgroundJobViewSchema>;

export const BackgroundJobsViewSchema = StrictObject({
  jobs: TypeArray(BackgroundJobViewSchema, { maxItems: BACKGROUND_LIMITS.maxJobs }),
  /** Jobs the extension dropped to stay inside its result budget. */
  omittedCount: CountSchema,
  omittedRange: TypeString({ maxLength: BACKGROUND_LIMITS.maxIdChars * 2 + 1 }),
  omittedGuidance: TypeString({ maxLength: BACKGROUND_LIMITS.maxErrorChars }),
  truncated: TypeBoolean(),
});
export type BackgroundJobsView = Static<typeof BackgroundJobsViewSchema>;

export const BackgroundMonitorEventViewSchema = StrictObject({
  jobId: TypeString({ maxLength: BACKGROUND_LIMITS.maxIdChars }),
  description: TypeString({ maxLength: BACKGROUND_LIMITS.maxCommandChars }),
  outputPath: TypeString({ maxLength: BACKGROUND_LIMITS.maxPathChars }),
  /** 1-based delivery counter for this job's event batches; 0 when unreadable. */
  delivery: CountSchema,
  /** Source line range this batch covers, e.g. "12-18"; empty when unreadable. */
  sequenceRange: TypeString({ maxLength: 64 }),
  droppedLines: CountSchema,
  droppedBytes: CountSchema,
  splitLines: CountSchema,
  /** The batch was captured to the log without being delivered to the model. */
  captureOnly: TypeBoolean(),
  deliveryError: TypeString({ maxLength: BACKGROUND_LIMITS.maxErrorChars }),
  lines: TypeArray(TypeString({ maxLength: BACKGROUND_LIMITS.maxCommandChars }), {
    maxItems: BACKGROUND_LIMITS.maxLines,
  }),
});
export type BackgroundMonitorEventView = Static<typeof BackgroundMonitorEventViewSchema>;

type RawRecord = Record<string, unknown>;

function record(value: unknown): RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replaceAll("\0", "");
  return clean.length > max ? clean.slice(0, max) : clean;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), BACKGROUND_LIMITS.maxCount);
}

/**
 * The accepted values of a literal-union schema, read from the schema itself so a
 * literal cannot be added to one and forgotten in the other.
 */
function accepted<T extends string>(schema: { anyOf: readonly { const: string }[] }): readonly T[] {
  return schema.anyOf.map((member) => member.const as T);
}

/** One of a schema's literals, or `fallback` when the payload carries none of them. */
function literal<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const JOB_STATUSES = accepted<BackgroundJobStatus>(BackgroundJobStatusSchema);
const DELIVERY_STATES = accepted<BackgroundDeliveryState>(BackgroundDeliveryStateSchema);
const TERMINAL_CAUSES = accepted<BackgroundTerminalCause>(BackgroundTerminalCauseSchema);
const COMPLETION_OUTPUTS = accepted<BackgroundCompletionOutput>(BackgroundCompletionOutputSchema);

function decodeMonitor(value: unknown): BackgroundMonitorView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const monitor = value as RawRecord;
  return {
    deliveries: count(monitor.deliveries),
    droppedLines: count(monitor.droppedLines),
    droppedBytes: count(monitor.droppedBytes),
    splitLines: count(monitor.splitLines),
    captureOnly: monitor.captureOnly === true,
    completionOutput: literal(monitor.completionOutput, COMPLETION_OUTPUTS, ""),
    deliveryError: text(monitor.deliveryError, BACKGROUND_LIMITS.maxErrorChars),
  };
}

function decodeJob(value: unknown, index: number): BackgroundJobView {
  const job = record(value);
  const monitor = record(job.monitor);
  const exitCode = job.exitCode;
  return {
    jobId: text(job.jobId, BACKGROUND_LIMITS.maxIdChars) || `job-${index}`,
    kind: job.kind === "background_event_stream" ? "background_event_stream" : "background_run",
    status: literal(job.status, JOB_STATUSES, "unknown"),
    command: text(job.command, BACKGROUND_LIMITS.maxCommandChars),
    description: text(job.description, BACKGROUND_LIMITS.maxCommandChars),
    cwd: text(job.cwd, BACKGROUND_LIMITS.maxPathChars),
    durationMs: count(job.durationMs),
    // A signal-killed process reports null, which is distinct from "still running".
    exitCode: typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : undefined,
    terminalCause: literal(job.requestedTerminalCause, TERMINAL_CAUSES, ""),
    outputBytes: count(job.outputBytes),
    outputPath: text(job.outputPath, BACKGROUND_LIMITS.maxPathChars),
    metadataPath: text(job.metadataPath, BACKGROUND_LIMITS.maxPathChars),
    deliveryState: literal(job.deliveryState, DELIVERY_STATES, ""),
    errors: [
      job.error,
      job.deliveryError,
      job.deliveryPersistenceError,
      job.monitorDeliveryPersistenceError,
      monitor.deliveryError,
    ]
      .map((error) => text(error, BACKGROUND_LIMITS.maxErrorChars))
      .filter(Boolean),
    monitor: decodeMonitor(job.monitor),
    tail: text(job.tail, BACKGROUND_LIMITS.maxTailChars),
    tailTruncated: job.tailTruncated === true,
  };
}

function isJobsView(value: unknown): value is BackgroundJobsView {
  return Check(BackgroundJobsViewSchema, value);
}

/**
 * Read the job list out of a `background_*` tool result, or out of the extension's
 * `background-process-completion` message, which carries the same `SerializedJobs`
 * payload. Total: unreadable details yield an empty job list and the caller falls
 * back to the tool's own text.
 */
export function decodeBackgroundJobsView(details: unknown): BackgroundJobsView | null {
  try {
    const payload = record(details);
    const omitted = record(payload.omittedJobs);
    const first = text(omitted.firstJobId, BACKGROUND_LIMITS.maxIdChars);
    const last = text(omitted.lastJobId, BACKGROUND_LIMITS.maxIdChars);
    const view: BackgroundJobsView = {
      jobs: array(payload.jobs)
        .slice(0, BACKGROUND_LIMITS.maxJobs)
        .map((job, index) => decodeJob(job, index)),
      omittedCount: count(payload.omittedCount),
      omittedRange: first && last ? `${first}…${last}` : "",
      omittedGuidance: text(omitted.guidance, BACKGROUND_LIMITS.maxErrorChars),
      truncated: payload.truncated === true,
    };
    return isJobsView(view) ? view : null;
  } catch {
    return null;
  }
}

function isMonitorEventView(value: unknown): value is BackgroundMonitorEventView {
  return Check(BackgroundMonitorEventViewSchema, value);
}

/**
 * Read one live event batch out of the extension's `background-monitor-event`
 * message details. The message's own text content stays the fallback when the
 * details are unreadable.
 */
export function decodeBackgroundMonitorEventView(
  details: unknown,
): BackgroundMonitorEventView | null {
  try {
    const event = record(details);
    const first = event.firstSequence;
    const last = event.lastSequence;
    const view: BackgroundMonitorEventView = {
      jobId: text(event.jobId, BACKGROUND_LIMITS.maxIdChars),
      description: text(event.description, BACKGROUND_LIMITS.maxCommandChars),
      outputPath: text(event.outputPath, BACKGROUND_LIMITS.maxPathChars),
      delivery: count(event.delivery),
      sequenceRange:
        typeof first === "number" && Number.isFinite(first)
          ? `${count(first)}-${typeof last === "number" && Number.isFinite(last) ? count(last) : count(first)}`
          : "",
      droppedLines: count(event.droppedLines),
      droppedBytes: count(event.droppedBytes),
      splitLines: count(event.splitLines),
      captureOnly: event.captureOnly === true,
      deliveryError: text(event.deliveryError, BACKGROUND_LIMITS.maxErrorChars),
      lines: array(event.lines)
        .slice(0, BACKGROUND_LIMITS.maxLines)
        .map((line) => text(line, BACKGROUND_LIMITS.maxCommandChars)),
    };
    return isMonitorEventView(view) ? view : null;
  } catch {
    return null;
  }
}
