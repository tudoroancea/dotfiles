import type { BoundedTailSnapshot } from "./bounded-tail.ts";

export type JobKind = "background_bash" | "monitor";

export type JobStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "cleanup_failed";

export type TerminalJobStatus = Exclude<JobStatus, "running">;
export type RequestedTerminalCause =
  | "timeout"
  | "stop"
  | "shutdown"
  | "output_limit"
  | "output_error";

export interface JobVerification {
  processSettled: boolean;
  outputLogClosed: boolean;
  terminalMetadataPersisted: boolean;
}

export type DeliveryState = "pending" | "sending" | "sent" | "failed" | "consumed";

export interface MonitorStatus {
  deliveries: number;
  deliveredBytes: number;
  deliveredLines: number;
  droppedLines: number;
  droppedBytes: number;
  splitLines: number;
  captureOnly: boolean;
  throttled: boolean;
  deliveryError?: string;
  completionOutput?: "no_output" | "all_delivered_live" | "remaining";
}

export interface JobRecord {
  readonly id: string;
  readonly generation: number;
  readonly kind: JobKind;
  readonly command: string;
  readonly cwd: string;
  readonly createdAt: string;
  description?: string;
  status: JobStatus;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  requestedTerminalCause?: RequestedTerminalCause;
  outputBytes: number;
  outputPath?: string;
  metadataPath?: string;
  terminalTail?: BoundedTailSnapshot;
  deliveryState: DeliveryState;
  deliveryAttemptedAt?: string;
  deliveryError?: string;
  deliveryPersistenceError?: string;
  monitorDeliveryPersistenceError?: string;
  monitor?: MonitorStatus;
  verification: JobVerification;
}

export interface JobMetadata extends Omit<JobRecord, "generation" | "terminalTail"> {
  runtimeId: string;
}

export interface CreateJobInput {
  kind: JobKind;
  command: string;
  cwd: string;
  description?: string;
}

export interface TerminalTransition {
  status: TerminalJobStatus;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  terminalTail?: BoundedTailSnapshot;
}
