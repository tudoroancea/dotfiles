import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { BoundedTail } from "./bounded-tail.ts";
import { ArtifactStore, OutputAppendError, type JobArtifacts } from "./artifact-store.ts";
import { JobStore } from "./job-store.ts";
import {
  boundedMonitorDeliveryError,
  formatMonitorEvent,
  formatMonitorFragment,
  MONITOR_DELIVERY_INTERVAL_MS,
  MONITOR_MAX_DELIVERIES,
  MonitorPipeline,
  type MonitorEvent,
  type MonitorWindow,
} from "./monitor.ts";
import { serializeJobs, type SerializedJobs } from "./results.ts";
import type {
  CreateJobInput,
  DeliveryState,
  JobMetadata,
  JobRecord,
  RequestedTerminalCause,
  TerminalJobStatus,
} from "./types.ts";

export const OUTPUT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const RUNTIME_JOB_CAPACITY = 50;

export interface LaunchJobInput extends CreateJobInput {
  timeout?: number;
}

export interface ProcessRuntimeOptions {
  operations?: BashOperations;
  artifacts?: ArtifactStore;
  outputMaxBytes?: number;
  completedRecordLimit?: number;
  shutdownVerificationMs?: number;
  now?: () => Date;
  onChange?: () => void;
  onTerminal?: () => void;
  onMonitorEvent?: () => void;
  serializer?: typeof serializeJobs;
}

interface ManagementReference {
  readonly token: symbol;
  readonly ids: readonly string[];
  released: boolean;
}

interface MonitorPersistence {
  dirty: boolean;
  failed: boolean;
  inFlight?: Promise<void>;
}

interface ActiveJob {
  record: JobRecord;
  controller: AbortController;
  artifacts: JobArtifacts;
  tail: BoundedTail;
  cause?: RequestedTerminalCause;
  timeout?: NodeJS.Timeout;
  timeoutSeconds?: number;
  completion: Promise<void>;
  operationSettled: boolean;
  logClosing: boolean;
  logSettled: boolean;
  monitor?: {
    pipeline: MonitorPipeline;
    queued: boolean;
    deliveries: number;
    lastDeliveryAt: number;
    captureOnly: boolean;
    lastDeliveredSequence?: number;
    intervalTimer?: NodeJS.Timeout;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusFor(
  cause: RequestedTerminalCause | undefined,
  exitCode: number | null,
): TerminalJobStatus {
  if (cause === "timeout") return "timed_out";
  if (cause === "stop" || cause === "shutdown") return "cancelled";
  if (cause === "output_limit" || cause === "output_error") return "failed";
  return exitCode === 0 ? "completed" : "failed";
}

export class ProcessRuntime {
  readonly generation: number;
  readonly artifacts: ArtifactStore;
  private readonly jobs: JobStore;
  private readonly operations: BashOperations;
  private readonly outputMaxBytes: number;
  private readonly completedRecordLimit: number;
  private readonly shutdownVerificationMs: number;
  private readonly active = new Map<string, ActiveJob>();
  private readonly managementReferences = new Map<string, Set<symbol>>();
  private readonly persistenceChains = new Map<string, Promise<void>>();
  private readonly monitorPersistence = new Map<string, MonitorPersistence>();
  private readonly deliveryWork = new Set<Promise<void>>();
  private readonly launchTransferred = new Set<string>();
  private readonly onChange?: () => void;
  private readonly onTerminal?: () => void;
  private readonly onMonitorEvent?: () => void;
  private readonly serializer: typeof serializeJobs;
  private readonly persistingJobIds = new Set<string>();
  private readonly pendingLaunches = new Set<Promise<void>>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private verificationFailure?: string;

  constructor(sessionId: string, options: ProcessRuntimeOptions = {}) {
    const now = options.now ?? (() => new Date());
    this.jobs = new JobStore(() => now().toISOString());
    this.generation = this.jobs.beginGeneration();
    this.operations = options.operations ?? createLocalBashOperations();
    this.artifacts = options.artifacts ?? new ArtifactStore(sessionId, { now });
    this.outputMaxBytes = options.outputMaxBytes ?? OUTPUT_MAX_BYTES;
    this.completedRecordLimit = Math.min(
      options.completedRecordLimit ?? RUNTIME_JOB_CAPACITY,
      RUNTIME_JOB_CAPACITY,
    );
    this.shutdownVerificationMs = options.shutdownVerificationMs ?? 30_000;
    this.onChange = options.onChange;
    this.onTerminal = options.onTerminal;
    this.onMonitorEvent = options.onMonitorEvent;
    this.serializer = options.serializer ?? serializeJobs;
  }

  async initialize(): Promise<void> {
    await this.cleanupArtifacts();
    await this.artifacts.initialize();
  }

  async launch(input: LaunchJobInput): Promise<JobRecord> {
    if (this.shuttingDown) throw new Error("background process runtime is shutting down");
    if (
      input.timeout !== undefined &&
      (!Number.isFinite(input.timeout) ||
        input.timeout <= 0 ||
        input.timeout * 1_000 > 2_147_483_647)
    ) {
      throw new RangeError("timeout must be positive and no greater than 2147483.647 seconds");
    }

    this.evictEligibleRecords(1);
    if (this.jobs.list().length >= this.completedRecordLimit) {
      throw new Error(
        `Background job capacity (${this.completedRecordLimit}) is full. Wait for running jobs, inspect their status, or consume completed results with background_wait/background_stop before launching another job.`,
      );
    }

    const record = this.jobs.create(this.generation, input);
    if (!record) throw new Error("background process runtime generation is stale");
    let resolveSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });
    this.pendingLaunches.add(setup);

    try {
      let artifacts: JobArtifacts;
      try {
        artifacts = await this.artifacts.createJob(record.id);
      } catch (error) {
        this.jobs.delete(record.id);
        throw error;
      }

      if (this.shuttingDown || !this.jobs.isCurrentGeneration(this.generation)) {
        await this.finalizeOvertakenLaunch(record, artifacts);
        throw new Error("background process runtime is shutting down");
      }

      record.outputPath = artifacts.outputPath;
      record.metadataPath = artifacts.metadataPath;
      this.jobs.update(record.id, this.generation, {
        outputPath: artifacts.outputPath,
        metadataPath: artifacts.metadataPath,
      });
      const controller = new AbortController();
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const active: ActiveJob = {
        record,
        controller,
        artifacts,
        tail: new BoundedTail(),
        completion,
        operationSettled: false,
        logClosing: false,
        logSettled: false,
      };
      if (record.kind === "background_event_stream") {
        active.monitor = {
          pipeline: new MonitorPipeline(() => this.monitorReady(active)),
          queued: false,
          deliveries: 0,
          lastDeliveryAt: 0,
          captureOnly: false,
        };
      }
      this.active.set(record.id, active);
      this.onChange?.();
      try {
        await artifacts.checkpoint(this.metadata(record));
      } catch (error) {
        if (this.shuttingDown || !this.jobs.isCurrentGeneration(this.generation)) {
          await this.finalizeOvertakenLaunch(record, artifacts);
          resolveCompletion();
          throw new Error("background process runtime is shutting down");
        }
        await this.finalizeSetupFailure(
          active,
          `initial metadata checkpoint failed: ${errorMessage(error)}`,
        );
        resolveCompletion();
        throw error;
      }

      if (this.shuttingDown || !this.jobs.isCurrentGeneration(this.generation)) {
        await this.finalizeOvertakenLaunch(record, artifacts);
        resolveCompletion();
        throw new Error("background process runtime is shutting down");
      }

      if (input.timeout !== undefined) {
        active.timeoutSeconds = input.timeout;
        active.timeout = setTimeout(() => {
          if (this.claimCause(active, "timeout", `timed out after ${input.timeout} seconds`)) {
            controller.abort();
          }
        }, input.timeout * 1_000);
      }
      void this.execute(active).then(resolveCompletion, resolveCompletion);
      return this.get(record.id)!;
    } finally {
      this.pendingLaunches.delete(setup);
      resolveSetup();
    }
  }

  markLaunchTransferred(jobId: string): void {
    if (this.get(jobId)) this.launchTransferred.add(jobId);
  }

  get(jobId: string): JobRecord | undefined {
    const active = this.active.get(jobId);
    if (active) {
      return this.copyRecord(active.record);
    }
    return this.jobs.get(jobId);
  }

  list(): JobRecord[] {
    return this.jobs.list();
  }

  tail(jobId: string): JobRecord["terminalTail"] | undefined {
    const active = this.active.get(jobId);
    return active?.tail.snapshot() ?? this.get(jobId)?.terminalTail;
  }

  resolve(jobIds: string[]): JobRecord[] {
    const records = jobIds.map((id) => this.get(id));
    const unknown = jobIds.filter((_id, index) => !records[index]);
    if (unknown.length > 0) throw new Error(`Unknown background job ID(s): ${unknown.join(", ")}`);
    return records as JobRecord[];
  }

  async wait(
    jobIds: string[],
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<JobRecord[]> {
    this.resolve(jobIds);
    const reference = this.acquireManagement(jobIds);
    try {
      return await this.waitResolved(jobIds, options);
    } finally {
      this.releaseManagement(reference);
    }
  }

  async waitResult(
    jobIds: string[],
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<SerializedJobs> {
    this.resolve(jobIds);
    const reference = this.acquireManagement(jobIds);
    try {
      const records = await this.waitResolved(jobIds, options);
      const intended = records.map((record) => this.withConsumedDelivery(record));
      const payload = this.serializer(intended, { includeTails: true });
      await this.consumeTerminal(
        records.filter((record) => payload.jobs.some((job) => job.jobId === record.id)),
      );
      return payload;
    } finally {
      this.releaseManagement(reference);
    }
  }

  async stop(jobId: string): Promise<JobRecord | undefined> {
    return (await this.stopMany([jobId]))[0];
  }

  async stopMany(jobIds: string[]): Promise<JobRecord[]> {
    this.resolve(jobIds);
    const reference = this.acquireManagement(jobIds);
    try {
      return await this.stopManyResolved(jobIds);
    } finally {
      this.releaseManagement(reference);
    }
  }

  async stopManyResult(jobIds: string[]): Promise<SerializedJobs> {
    this.resolve(jobIds);
    const reference = this.acquireManagement(jobIds);
    try {
      const records = await this.stopManyResolved(jobIds);
      const intended = records.map((record) => this.withConsumedDelivery(record));
      const payload = this.serializer(intended, { includeTails: true });
      await this.consumeTerminal(
        records.filter((record) => payload.jobs.some((job) => job.jobId === record.id)),
      );
      return payload;
    } finally {
      this.releaseManagement(reference);
    }
  }

  flushMonitorDeliveries(send: (event: MonitorEvent) => void): number {
    if (this.shuttingDown) return 0;
    let sent = 0;
    for (const job of this.active.values()) {
      const monitor = job.monitor;
      if (
        !monitor ||
        monitor.queued ||
        monitor.captureOnly ||
        !monitor.pipeline.hasPending() ||
        !this.launchTransferred.has(job.record.id)
      )
        continue;
      const elapsed = Date.now() - monitor.lastDeliveryAt;
      if (elapsed < MONITOR_DELIVERY_INTERVAL_MS) {
        this.scheduleMonitorInterval(job, MONITOR_DELIVERY_INTERVAL_MS - elapsed);
        continue;
      }
      // Claim before draining or invoking extension code. A reentrant settled/flush cannot
      // observe this delivery as available a second time.
      monitor.queued = true;
      const window = monitor.pipeline.drain();
      monitor.deliveries += 1;
      monitor.lastDeliveryAt = Date.now();
      monitor.captureOnly = monitor.deliveries >= MONITOR_MAX_DELIVERIES;
      const status = job.record.monitor!;
      status.deliveries = monitor.deliveries;
      status.deliveredBytes += window.fragments.reduce(
        (total, fragment) => total + fragment.bytes,
        0,
      );
      const deliveredSequences = [
        ...new Set(window.fragments.map((fragment) => fragment.sequence)),
      ].filter((sequence) => sequence !== monitor.lastDeliveredSequence);
      status.deliveredLines += deliveredSequences.length;
      monitor.lastDeliveredSequence = deliveredSequences.at(-1) ?? monitor.lastDeliveredSequence;
      status.captureOnly = monitor.captureOnly;
      status.throttled = monitor.captureOnly;
      this.syncMonitorMetrics(job);
      try {
        send(this.monitorEvent(job, window, monitor.captureOnly));
      } catch (error) {
        status.deliveryError = boundedMonitorDeliveryError(error);
      }
      this.syncMonitorMetrics(job);
      this.persistMonitorStatus(job);
      sent += 1;
    }
    return sent;
  }

  settleMonitorDeliveries(): void {
    if (this.shuttingDown) return;
    for (const job of this.active.values()) {
      if (job.monitor) job.monitor.queued = false;
    }
  }

  async flushCompletionDeliveries(
    send: (payload: SerializedJobs) => void | Promise<void>,
  ): Promise<boolean> {
    if (this.shuttingDown) return false;
    const eligible = this.recordsInLaunchOrder().filter(
      (job) =>
        job.status !== "running" &&
        job.deliveryState === "pending" &&
        this.launchTransferred.has(job.id),
    );
    if (eligible.length === 0) return false;
    const deliveryAttemptedAt = new Date().toISOString();
    const intended = eligible.map((job) => ({
      ...job,
      deliveryState: "sending" as const,
      deliveryAttemptedAt,
      verification: { ...job.verification },
    }));
    const payload = this.serializer(intended, { includeTails: true });
    this.assertCompletePayload(eligible, payload);
    if (!eligible.every((job) => this.currentRecord(job.id)?.deliveryState === "pending"))
      return false;
    for (const job of eligible) {
      if (
        !this.updateDelivery(job.id, "pending", {
          deliveryState: "sending",
          deliveryAttemptedAt,
        })
      )
        throw new Error(`Completion batch claim failed for ${job.id}`);
    }
    const claimed = eligible;
    const delivery = this.trackDeliveryWork(
      (async () => {
        try {
          await send(payload);
          await this.finishDeliveries(claimed, "sent");
        } catch (error) {
          await this.finishDeliveries(claimed, "failed", errorMessage(error));
        }
      })(),
    );
    await delivery;
    this.onChange?.();
    return true;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async waitResolved(
    jobIds: string[],
    options: { timeout?: number; signal?: AbortSignal },
  ): Promise<JobRecord[]> {
    const completions = jobIds.map((id) => this.active.get(id)?.completion ?? Promise.resolve());
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const barriers: Promise<unknown>[] = [Promise.all(completions)];
    if (options.timeout !== undefined) {
      barriers.push(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.timeout! * 1_000);
        }),
      );
    }
    try {
      if (options.signal?.aborted) throw new DOMException("Wait aborted", "AbortError");
      if (options.signal) {
        barriers.push(
          new Promise<void>((_resolve, reject) => {
            abortListener = () => reject(new DOMException("Wait aborted", "AbortError"));
            options.signal!.addEventListener("abort", abortListener, { once: true });
          }),
        );
      }
      await Promise.race(barriers);
      return this.resolve(jobIds);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    }
  }

  private async stopManyResolved(jobIds: string[]): Promise<JobRecord[]> {
    const targets = jobIds.map((id) => this.active.get(id)).filter((job) => job !== undefined);
    const claimed: ActiveJob[] = [];
    for (const job of targets) {
      if (this.claimCause(job, "stop", "stopped by request")) claimed.push(job);
    }
    for (const job of claimed) job.controller.abort();
    await Promise.all(targets.map((job) => job.completion));
    return this.resolve(jobIds);
  }

  private async execute(job: ActiveJob): Promise<void> {
    let exitCode: number | null = null;
    let operationError: string | undefined;
    try {
      const result = await this.operations.exec(job.record.command, job.record.cwd, {
        signal: job.controller.signal,
        timeout: job.timeoutSeconds,
        onData: (chunk) => this.capture(job, chunk),
      });
      exitCode = result.exitCode;
    } catch (error) {
      operationError = errorMessage(error);
      if (operationError.startsWith("timeout:") && !job.cause) {
        this.claimCause(job, "timeout", `timed out after ${job.timeoutSeconds} seconds`);
      }
    } finally {
      if (job.timeout) {
        clearTimeout(job.timeout);
        job.timeout = undefined;
      }
      job.operationSettled = true;
      this.setVerification(job.record, { processSettled: true });
    }

    job.monitor?.pipeline.finish();
    if (job.monitor) {
      this.syncMonitorMetrics(job);
      await this.awaitMonitorPersistence(job);
    }
    if (job.monitor?.intervalTimer) clearTimeout(job.monitor.intervalTimer);
    job.logClosing = true;
    try {
      await job.artifacts.close();
      job.logSettled = true;
      this.setVerification(job.record, { outputLogClosed: true });
    } catch (error) {
      const message = `output log failed: ${errorMessage(error)}`;
      this.recordVerificationFailure(message);
      if (this.claimCause(job, "output_error", message)) job.controller.abort();
      else if (job.cause === "shutdown") job.record.error = message;
      operationError = message;
    }

    if (!this.jobs.isCurrentGeneration(this.generation)) {
      job.tail.clear();
      this.active.delete(job.record.id);
      return;
    }
    const cause = job.cause;
    const error = job.record.error ?? (cause ? undefined : operationError);
    const status = !job.logSettled ? "cleanup_failed" : statusFor(cause, exitCode);
    const terminalTail = job.monitor
      ? this.monitorTerminalTail(job, job.monitor.pipeline.drain())
      : job.tail.snapshot();
    this.jobs.transitionTerminal(job.record.id, this.generation, {
      status,
      exitCode,
      error,
      terminalTail,
    });
    Object.assign(job.record, this.jobs.get(job.record.id));
    await this.persistTerminal(job.record, job.artifacts, terminalTail);
    job.tail.clear();
    this.active.delete(job.record.id);
    this.monitorPersistence.delete(job.record.id);
    this.evictCompletedRecords();
    this.onChange?.();
    if (!this.shuttingDown) {
      void this.cleanupArtifacts().catch(() => undefined);
      this.onTerminal?.();
    }
  }

  private capture(job: ActiveJob, incoming: Buffer): void {
    if (
      incoming.length === 0 ||
      job.logClosing ||
      job.logSettled ||
      job.cause === "output_limit" ||
      job.cause === "output_error"
    ) {
      return;
    }
    const remaining = this.outputMaxBytes - job.record.outputBytes;
    if (remaining <= 0) {
      if (this.claimCause(job, "output_limit", `output exceeded ${this.outputMaxBytes} bytes`)) {
        job.controller.abort();
      }
      return;
    }
    const chunk = incoming.length > remaining ? incoming.subarray(0, remaining) : incoming;
    let persistedBytes = 0;
    let writeError: unknown;
    try {
      persistedBytes = job.artifacts.append(chunk) ?? chunk.length;
    } catch (error) {
      persistedBytes = error instanceof OutputAppendError ? error.persistedBytes : 0;
      writeError = error;
    }
    if (persistedBytes > 0) {
      const persisted = chunk.subarray(0, persistedBytes);
      job.record.outputBytes += persisted.length;
      this.jobs.update(job.record.id, this.generation, { outputBytes: job.record.outputBytes });
      job.tail.append(persisted.toString("utf8"));
      job.monitor?.pipeline.write(persisted);
    }
    if (writeError) {
      const message = `output log write failed: ${errorMessage(writeError)}`;
      if (this.claimCause(job, "output_error", message)) job.controller.abort();
      return;
    }
    if (incoming.length > remaining) {
      if (this.claimCause(job, "output_limit", `output exceeded ${this.outputMaxBytes} bytes`)) {
        job.controller.abort();
      }
    }
  }

  private monitorReady(job: ActiveJob): void {
    if (this.shuttingDown || !this.active.has(job.record.id)) return;
    this.syncMonitorMetrics(job);
    this.persistMonitorStatus(job);
    try {
      this.onMonitorEvent?.();
    } catch (error) {
      if (job.record.monitor) job.record.monitor.deliveryError = boundedMonitorDeliveryError(error);
      this.syncMonitorMetrics(job);
      this.persistMonitorStatus(job);
    }
  }

  private scheduleMonitorInterval(job: ActiveJob, delay: number): void {
    const monitor = job.monitor!;
    if (monitor.intervalTimer || this.shuttingDown) return;
    monitor.intervalTimer = setTimeout(() => {
      monitor.intervalTimer = undefined;
      this.monitorReady(job);
    }, delay);
  }

  private monitorEvent(job: ActiveJob, window: MonitorWindow, captureOnly: boolean): MonitorEvent {
    return {
      jobId: job.record.id,
      description: job.record.description ?? job.record.command,
      outputPath: job.record.outputPath ?? "",
      delivery: job.monitor?.deliveries ?? 0,
      lines: window.fragments.map(formatMonitorFragment),
      firstSequence: window.firstSequence,
      lastSequence: window.lastSequence,
      droppedLines: window.droppedLines,
      droppedBytes: window.droppedBytes,
      missingFirstSequence: window.missingFirstSequence,
      missingLastSequence: window.missingLastSequence,
      splitLines: window.splitLines,
      captureBatches: window.captureBatches,
      captureOnly,
      deliveryError: job.record.monitor?.deliveryError,
    };
  }

  private monitorTerminalTail(job: ActiveJob, window: MonitorWindow): JobRecord["terminalTail"] {
    this.syncMonitorMetrics(job);
    const monitor = job.record.monitor!;
    if (window.fragments.length === 0) {
      monitor.completionOutput =
        job.record.outputBytes === 0
          ? "no_output"
          : monitor.deliveries > 0 && monitor.droppedLines === 0 && !monitor.deliveryError
            ? "all_delivered_live"
            : "remaining";
      this.syncMonitorMetrics(job);
      return { content: "", bytes: 0, lines: 0, truncated: false };
    }
    monitor.completionOutput = "remaining";
    this.syncMonitorMetrics(job);
    const content = formatMonitorEvent(
      this.monitorEvent(job, window, job.monitor?.captureOnly ?? false),
    );
    return {
      content,
      bytes: Buffer.byteLength(content),
      lines: content.split("\n").length,
      truncated: window.droppedLines > 0 || window.droppedBytes > 0,
    };
  }

  private claimCause(job: ActiveJob, cause: RequestedTerminalCause, error: string): boolean {
    if (
      job.cause ||
      job.record.status !== "running" ||
      (job.operationSettled && (cause === "timeout" || cause === "stop" || cause === "shutdown"))
    ) {
      return false;
    }
    job.cause = cause;
    job.record.requestedTerminalCause = cause;
    job.record.error = error;
    this.jobs.update(job.record.id, this.generation, {
      requestedTerminalCause: cause,
      error,
    });
    if (!job.monitor)
      void job.artifacts.checkpoint(this.metadata(job.record)).catch(() => undefined);
    return true;
  }

  private async finalizeOvertakenLaunch(record: JobRecord, artifacts: JobArtifacts): Promise<void> {
    record.outputPath = artifacts.outputPath;
    record.metadataPath = artifacts.metadataPath;
    record.requestedTerminalCause = "shutdown";
    record.error = "launch cancelled during session shutdown";
    this.setVerification(record, { processSettled: true }, true);
    let closeError: string | undefined;
    try {
      await artifacts.close();
      this.setVerification(record, { outputLogClosed: true }, true);
    } catch (error) {
      closeError = `output log failed: ${errorMessage(error)}`;
      this.recordVerificationFailure(closeError);
    }
    const terminalTail = new BoundedTail().snapshot();
    this.jobs.finalizeShutdown(record.id, this.generation, {
      outputPath: record.outputPath,
      metadataPath: record.metadataPath,
      requestedTerminalCause: "shutdown",
      status: closeError ? "cleanup_failed" : "cancelled",
      error: closeError ?? record.error,
      terminalTail,
    });
    Object.assign(record, this.jobs.get(record.id));
    await this.persistTerminal(record, artifacts, terminalTail, true);
    this.active.delete(record.id);
    this.evictCompletedRecords();
    this.onChange?.();
  }

  private async performShutdown(): Promise<void> {
    const deadline = Date.now() + this.shutdownVerificationMs;
    const launchSetups = [...this.pendingLaunches];
    this.abortActiveForShutdown();

    const launchesSettled = await this.settlesBefore(Promise.all(launchSetups), deadline);
    this.abortActiveForShutdown();
    const pending = [...this.active.values()];
    const completionsSettled =
      launchesSettled &&
      (await this.settlesBefore(Promise.all(pending.map((job) => job.completion)), deadline));
    const deliverySettled = await this.settlesBefore(Promise.all(this.deliveryWork), deadline);
    const allRecords = this.recordsInLaunchOrder();
    const coreJobsVerified =
      launchesSettled &&
      completionsSettled &&
      deliverySettled &&
      !this.verificationFailure &&
      allRecords.every((job) => this.isVerified(job));
    const deliveryVerified = allRecords.every(
      (job) => !job.deliveryPersistenceError && !job.monitorDeliveryPersistenceError,
    );
    let ownerClosed = false;
    if (coreJobsVerified && deliveryVerified) {
      ownerClosed = await this.settlesBefore(this.artifacts.markClosed(), deadline);
    }
    const verified = coreJobsVerified && deliveryVerified && ownerClosed;

    if (!verified) {
      const diagnosticCheckpoints: Promise<void>[] = [];
      for (const record of this.jobs.list()) {
        const missing = [
          ...(record.verification.processSettled ? [] : ["process settlement"]),
          ...(record.verification.outputLogClosed ? [] : ["output log closure"]),
          ...(record.verification.terminalMetadataPersisted
            ? []
            : ["terminal metadata persistence"]),
        ];
        if (missing.length === 0) continue;
        const diagnostic = `shutdown could not confirm ${missing.join(", ")} within ${this.shutdownVerificationMs}ms`;
        this.jobs.markCleanupFailed(record.id, this.generation, diagnostic, record.terminalTail);
        const failed = this.jobs.get(record.id)!;
        const active = this.active.get(record.id);
        if (active) Object.assign(active.record, failed);
        const checkpoint = active
          ? active.artifacts.checkpoint(this.metadata(failed))
          : failed.metadataPath
            ? this.artifacts.checkpoint(this.metadata(failed))
            : undefined;
        if (checkpoint) diagnosticCheckpoints.push(checkpoint.catch(() => undefined));
      }
      await this.settlesBefore(Promise.all(diagnosticCheckpoints), deadline);
    }
    this.jobs.endGeneration(this.generation);
    if (!verified) {
      const diagnostic = this.verificationFailure ? `: ${this.verificationFailure}` : "";
      throw new Error(
        `background process shutdown could not be verified within ${this.shutdownVerificationMs}ms${diagnostic}`,
      );
    }
  }

  private async finalizeSetupFailure(job: ActiveJob, setupError: string): Promise<void> {
    this.setVerification(job.record, { processSettled: true });
    let closeError: string | undefined;
    try {
      await job.artifacts.close();
      job.logSettled = true;
      this.setVerification(job.record, { outputLogClosed: true });
    } catch (error) {
      closeError = `output log failed: ${errorMessage(error)}`;
      this.recordVerificationFailure(closeError);
    }
    const terminalTail = job.tail.snapshot();
    this.jobs.transitionTerminal(job.record.id, this.generation, {
      status: closeError ? "cleanup_failed" : "failed",
      error: closeError ?? setupError,
      terminalTail,
    });
    Object.assign(job.record, this.jobs.get(job.record.id));
    await this.persistTerminal(job.record, job.artifacts, terminalTail);
    job.tail.clear();
    this.active.delete(job.record.id);
    this.jobs.delete(job.record.id);
    this.launchTransferred.delete(job.record.id);
  }

  private async persistTerminal(
    record: JobRecord,
    artifacts: JobArtifacts,
    terminalTail?: JobRecord["terminalTail"],
    shutdownFinalization = false,
  ): Promise<void> {
    this.persistingJobIds.add(record.id);
    try {
      await this.serializePersistence(record.id, async () => {
        const checkpoint = async () => {
          const current = this.currentRecord(record.id);
          if (!current) throw new Error(`job ${record.id} disappeared during terminal persistence`);
          await artifacts.checkpoint(
            this.metadata({
              ...current,
              verification: { ...current.verification, terminalMetadataPersisted: true },
            }),
          );
        };
        try {
          await checkpoint();
          this.setVerification(record, { terminalMetadataPersisted: true }, shutdownFinalization);
          return;
        } catch (error) {
          const diagnostic = `terminal metadata checkpoint failed: ${errorMessage(error)}`;
          if (shutdownFinalization) {
            this.jobs.finalizeShutdownCleanupFailure(
              record.id,
              this.generation,
              diagnostic,
              terminalTail,
            );
          } else {
            this.jobs.markCleanupFailed(record.id, this.generation, diagnostic, terminalTail);
          }
          const failed = this.jobs.get(record.id);
          if (failed) Object.assign(record, failed);
          else this.recordVerificationFailure(diagnostic);
        }
        try {
          await checkpoint();
          this.setVerification(record, { terminalMetadataPersisted: true }, shutdownFinalization);
        } catch (error) {
          const diagnostic = `terminal metadata checkpoint failed after retry: ${errorMessage(error)}`;
          this.recordVerificationFailure(diagnostic);
          if (shutdownFinalization) {
            this.jobs.finalizeShutdownCleanupFailure(
              record.id,
              this.generation,
              diagnostic,
              terminalTail,
            );
          } else {
            this.jobs.markCleanupFailed(record.id, this.generation, diagnostic, terminalTail);
          }
          const failed = this.jobs.get(record.id);
          if (failed) Object.assign(record, failed);
        }
      });
    } finally {
      this.persistingJobIds.delete(record.id);
    }
  }

  private withConsumedDelivery(record: JobRecord): JobRecord {
    return record.status !== "running" && record.deliveryState === "pending"
      ? {
          ...record,
          deliveryState: "consumed",
          verification: { ...record.verification },
        }
      : this.copyRecord(record)!;
  }

  private async consumeTerminal(records: JobRecord[]): Promise<void> {
    if (this.shuttingDown) return;
    const consumed = records.filter(
      (record) =>
        record.status !== "running" &&
        record.deliveryState === "pending" &&
        this.updateDelivery(record.id, "pending", {
          deliveryState: "consumed",
        }),
    );
    await this.trackDeliveryWork(this.persistDeliveryRecords(consumed));
    for (const record of consumed) this.launchTransferred.delete(record.id);
    if (consumed.length > 0) {
      await this.cleanupArtifacts().catch(() => undefined);
      this.onChange?.();
    }
  }

  private async finishDeliveries(
    records: JobRecord[],
    state: Extract<DeliveryState, "sent" | "failed">,
    deliveryError?: string,
  ): Promise<void> {
    const updated = records.filter((record) =>
      this.updateDelivery(record.id, "sending", {
        deliveryState: state,
        ...(deliveryError ? { deliveryError } : {}),
      }),
    );
    await this.persistDeliveryRecords(updated);
    for (const record of updated) this.launchTransferred.delete(record.id);
    if (updated.length > 0) await this.cleanupArtifacts().catch(() => undefined);
  }

  private async persistDeliveryRecords(records: JobRecord[]): Promise<void> {
    await Promise.all(
      records.map((record) =>
        this.serializePersistence(record.id, async () => {
          let failure: string | undefined;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const current = this.currentRecord(record.id);
              if (!current)
                throw new Error(`job ${record.id} disappeared during delivery persistence`);
              if (!current.metadataPath)
                throw new Error(
                  `job ${record.id} has no metadata path during delivery persistence`,
                );
              await this.artifacts.checkpoint(this.metadata(current));
              this.setDeliveryPersistenceError(record.id, undefined);
              return;
            } catch (error) {
              failure = `delivery metadata checkpoint failed${attempt === 1 ? " after retry" : ""}: ${errorMessage(error)}`;
            }
          }
          this.setDeliveryPersistenceError(record.id, failure);
          this.recordVerificationFailure(failure!);
        }),
      ),
    );
  }

  private recordVerificationFailure(diagnostic: string): void {
    this.verificationFailure ??= errorMessage(diagnostic).replace(/\s+/g, " ").slice(0, 512);
  }

  private setVerification(
    record: JobRecord,
    values: Partial<JobRecord["verification"]>,
    shutdownFinalization = false,
  ): void {
    if (shutdownFinalization) {
      this.jobs.finalizeShutdownVerification(record.id, this.generation, values);
    } else {
      this.jobs.updateVerification(record.id, this.generation, values);
    }
    Object.assign(record.verification, values);
  }

  private isVerified(record: JobRecord): boolean {
    return (
      record.verification.processSettled &&
      record.verification.outputLogClosed &&
      record.verification.terminalMetadataPersisted
    );
  }

  private abortActiveForShutdown(): void {
    for (const job of this.active.values()) {
      job.monitor?.pipeline.dispose();
      if (job.monitor?.intervalTimer) clearTimeout(job.monitor.intervalTimer);
      if (job.timeout) {
        clearTimeout(job.timeout);
        job.timeout = undefined;
      }
      if (this.claimCause(job, "shutdown", "cancelled during session shutdown")) {
        job.controller.abort();
      }
    }
  }

  private async settlesBefore(promise: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return settled;
  }

  private metadata(record: JobRecord): JobMetadata {
    const { generation: _generation, terminalTail: _terminalTail, ...metadata } = record;
    return { ...metadata, runtimeId: this.artifacts.runtimeId };
  }

  private evictCompletedRecords(): void {
    const excess = Math.max(0, this.jobs.list().length - this.completedRecordLimit);
    if (excess > 0) this.evictEligibleRecords(excess);
  }

  private evictEligibleRecords(requiredSlots: number): void {
    let remaining = Math.max(
      0,
      this.jobs.list().length + requiredSlots - this.completedRecordLimit,
    );
    if (remaining === 0) return;
    for (const job of this.jobs
      .list()
      .filter(
        (record) =>
          record.status !== "running" &&
          (record.deliveryState === "sent" ||
            record.deliveryState === "failed" ||
            record.deliveryState === "consumed") &&
          !record.deliveryPersistenceError &&
          !this.active.has(record.id) &&
          !this.persistingJobIds.has(record.id) &&
          !this.persistenceChains.has(record.id) &&
          (this.managementReferences.get(record.id)?.size ?? 0) === 0,
      )
      .sort((left, right) => (left.completedAt ?? "").localeCompare(right.completedAt ?? ""))) {
      this.jobs.delete(job.id);
      this.launchTransferred.delete(job.id);
      remaining -= 1;
      if (remaining === 0) break;
    }
  }

  private updateDelivery(
    id: string,
    expected: DeliveryState,
    values: Pick<JobRecord, "deliveryState"> &
      Partial<
        Pick<JobRecord, "deliveryAttemptedAt" | "deliveryError" | "deliveryPersistenceError">
      >,
  ): boolean {
    const updated = this.jobs.updateDelivery(id, this.generation, expected, values);
    if (updated) {
      const active = this.active.get(id);
      if (active) Object.assign(active.record, values);
    }
    return updated;
  }

  private setDeliveryPersistenceError(id: string, error: string | undefined): void {
    const record = this.jobs.get(id);
    if (record) {
      this.jobs.updateDelivery(id, this.generation, record.deliveryState, {
        deliveryState: record.deliveryState,
        deliveryPersistenceError: error,
      });
      const active = this.active.get(id);
      if (active) active.record.deliveryPersistenceError = error;
    }
  }

  private acquireManagement(ids: string[]): ManagementReference {
    const reference: ManagementReference = { token: Symbol("management"), ids, released: false };
    for (const id of ids) {
      const references = this.managementReferences.get(id) ?? new Set<symbol>();
      references.add(reference.token);
      this.managementReferences.set(id, references);
    }
    return reference;
  }

  private releaseManagement(reference: ManagementReference): void {
    if (reference.released) return;
    reference.released = true;
    for (const id of reference.ids) {
      const references = this.managementReferences.get(id);
      if (!references?.delete(reference.token)) continue;
      if (references.size > 0) continue;
      this.managementReferences.delete(id);
    }
    this.evictCompletedRecords();
    void this.cleanupArtifacts().catch(() => undefined);
  }

  private cleanupArtifacts(): Promise<void> {
    return this.artifacts.cleanup({
      isCurrentJobProtected: (id) => this.isArtifactProtected(id),
    });
  }

  private isArtifactProtected(id: string): boolean {
    const monitor = this.monitorPersistence.get(id);
    const record = this.currentRecord(id);
    return (
      Boolean(
        record?.deliveryPersistenceError ||
        record?.monitorDeliveryPersistenceError ||
        (record && !record.verification.terminalMetadataPersisted),
      ) ||
      this.active.has(id) ||
      this.launchTransferred.has(id) ||
      this.persistingJobIds.has(id) ||
      this.persistenceChains.has(id) ||
      (this.managementReferences.get(id)?.size ?? 0) > 0 ||
      Boolean(monitor?.dirty || monitor?.inFlight)
    );
  }

  private currentRecord(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  private recordsInLaunchOrder(): JobRecord[] {
    return this.jobs.list().sort((left, right) => {
      const leftSequence = Number(left.id.slice(left.id.lastIndexOf("_") + 1));
      const rightSequence = Number(right.id.slice(right.id.lastIndexOf("_") + 1));
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }

  private assertCompletePayload(records: JobRecord[], payload: SerializedJobs): void {
    const represented = new Map(payload.jobs.map((job) => [job.jobId, job]));
    for (const record of records) {
      const snapshot = represented.get(record.id);
      if (
        snapshot?.jobId !== record.id ||
        snapshot.outputPath !== record.outputPath ||
        snapshot.metadataPath !== record.metadataPath
      ) {
        throw new Error(
          `Completion payload could not represent ${record.id} with its exact ID and artifact paths; all deliveries remain pending.`,
        );
      }
    }
    if (payload.jobs.length !== records.length || payload.omittedCount !== 0) {
      throw new Error("Completion payload omitted a claimed job; all deliveries remain pending.");
    }
  }

  private async serializePersistence(id: string, persist: () => Promise<void>): Promise<void> {
    const previous = this.persistenceChains.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(persist);
    this.persistenceChains.set(id, current);
    try {
      await current;
    } finally {
      if (this.persistenceChains.get(id) === current) this.persistenceChains.delete(id);
    }
  }

  private trackDeliveryWork(work: Promise<void>): Promise<void> {
    this.deliveryWork.add(work);
    void work.finally(() => this.deliveryWork.delete(work)).catch(() => undefined);
    return work;
  }

  private syncMonitorMetrics(job: ActiveJob): void {
    if (!job.monitor || !job.record.monitor) return;
    const metrics = job.monitor.pipeline.metrics();
    Object.assign(job.record.monitor, metrics);
    this.jobs.update(job.record.id, this.generation, { monitor: { ...job.record.monitor } });
  }

  private persistMonitorStatus(job: ActiveJob): void {
    if (!job.record.metadataPath || this.shuttingDown) return;
    const state = this.monitorPersistence.get(job.record.id) ?? {
      dirty: false,
      failed: false,
    };
    this.monitorPersistence.set(job.record.id, state);
    state.dirty = true;
    if (!state.inFlight && !state.failed) {
      const work = this.drainMonitorPersistence(job, state);
      state.inFlight = work;
      void work
        .finally(() => {
          if (state.inFlight === work) state.inFlight = undefined;
        })
        .catch(() => undefined);
    }
    this.onChange?.();
  }

  private async drainMonitorPersistence(job: ActiveJob, state: MonitorPersistence): Promise<void> {
    while (state.dirty && !state.failed) {
      state.dirty = false;
      let failure: string | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const current = this.currentRecord(job.record.id);
          if (!current)
            throw new Error(`job ${job.record.id} disappeared during monitor persistence`);
          await job.artifacts.checkpoint(this.metadata(current));
          failure = undefined;
          break;
        } catch (error) {
          failure = `monitor delivery metadata checkpoint failed${attempt === 1 ? " after retry" : ""}: ${errorMessage(error)}`;
        }
      }
      if (failure) {
        state.failed = true;
        state.dirty = false;
        job.record.monitorDeliveryPersistenceError = failure;
        this.jobs.update(job.record.id, this.generation, {
          monitorDeliveryPersistenceError: failure,
        });
        const current = this.currentRecord(job.record.id);
        if (current) await job.artifacts.checkpoint(this.metadata(current)).catch(() => undefined);
        this.recordVerificationFailure(failure);
      }
    }
  }

  private async awaitMonitorPersistence(job: ActiveJob): Promise<void> {
    const state = this.monitorPersistence.get(job.record.id);
    if (state?.inFlight) await state.inFlight;
  }

  private copyRecord(record: JobRecord | undefined): JobRecord | undefined {
    return record
      ? {
          ...record,
          monitor: record.monitor ? { ...record.monitor } : undefined,
          verification: { ...record.verification },
        }
      : undefined;
  }
}
