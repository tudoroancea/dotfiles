import type { CreateJobInput, JobRecord, TerminalTransition } from "./types.ts";

export type Clock = () => string;

export const MAX_JOB_NUMBER = Number.MAX_SAFE_INTEGER;
export const MAX_GENERATED_JOB_ID = `mon_${MAX_JOB_NUMBER}`;

export class JobStore {
  private generation = 0;
  private generationActive = false;
  private nextJobNumber = 1;
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly now: Clock = () => new Date().toISOString()) {}

  beginGeneration(): number {
    this.generation += 1;
    this.generationActive = true;
    return this.generation;
  }

  endGeneration(generation: number): boolean {
    if (!this.isCurrentGeneration(generation)) return false;
    this.generationActive = false;
    return true;
  }

  isCurrentGeneration(generation: number): boolean {
    return this.generationActive && generation === this.generation;
  }

  create(generation: number, input: CreateJobInput): JobRecord | undefined {
    if (!this.isCurrentGeneration(generation)) return undefined;

    if (this.nextJobNumber > MAX_JOB_NUMBER) {
      throw new Error(
        `Background job ID counter exhausted at ${MAX_JOB_NUMBER}; start a new session before launching another job.`,
      );
    }
    const prefix = input.kind === "monitor" ? "mon" : "bg";
    const id = `${prefix}_${this.nextJobNumber}`;
    this.nextJobNumber += 1;
    const job: JobRecord = {
      id,
      generation,
      kind: input.kind,
      command: input.command,
      cwd: input.cwd,
      createdAt: this.now(),
      description: input.description,
      status: "running",
      outputBytes: 0,
      deliveryState: "pending",
      monitor:
        input.kind === "monitor"
          ? {
              deliveries: 0,
              deliveredBytes: 0,
              deliveredLines: 0,
              droppedLines: 0,
              droppedBytes: 0,
              splitLines: 0,
              captureOnly: false,
              throttled: false,
            }
          : undefined,
      verification: {
        processSettled: false,
        outputLogClosed: false,
        terminalMetadataPersisted: false,
      },
    };
    this.jobs.set(id, job);
    return this.copy(job);
  }

  get(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    return job ? this.copy(job) : undefined;
  }

  update(id: string, generation: number, values: Partial<JobRecord>): boolean {
    if (!this.isCurrentGeneration(generation)) return false;
    const job = this.jobs.get(id);
    if (!job || job.generation !== generation || job.status !== "running") return false;
    Object.assign(job, values, { id: job.id, generation: job.generation });
    return true;
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((job) => this.copy(job));
  }

  updateDelivery(
    id: string,
    generation: number,
    expected: JobRecord["deliveryState"],
    values: Pick<JobRecord, "deliveryState"> &
      Partial<
        Pick<JobRecord, "deliveryAttemptedAt" | "deliveryError" | "deliveryPersistenceError">
      >,
  ): boolean {
    if (!this.isCurrentGeneration(generation)) return false;
    const job = this.jobs.get(id);
    if (!job || job.generation !== generation || job.deliveryState !== expected) return false;
    Object.assign(job, values);
    return true;
  }

  updateVerification(
    id: string,
    generation: number,
    values: Partial<JobRecord["verification"]>,
  ): boolean {
    if (!this.isCurrentGeneration(generation)) return false;
    const job = this.jobs.get(id);
    if (!job || job.generation !== generation) return false;
    Object.assign(job.verification, values);
    return true;
  }

  finalizeShutdownVerification(
    id: string,
    generation: number,
    values: Partial<JobRecord["verification"]>,
  ): boolean {
    if (generation !== this.generation) return false;
    const job = this.jobs.get(id);
    if (!job || job.generation !== generation) return false;
    Object.assign(job.verification, values);
    return true;
  }

  delete(id: string): boolean {
    return this.jobs.delete(id);
  }

  markCleanupFailed(
    id: string,
    generation: number,
    error: string,
    terminalTail?: JobRecord["terminalTail"],
  ): boolean {
    if (!this.isCurrentGeneration(generation)) return false;
    return this.applyCleanupFailure(id, generation, error, terminalTail);
  }

  finalizeShutdown(
    id: string,
    generation: number,
    values: Pick<JobRecord, "outputPath" | "metadataPath" | "requestedTerminalCause"> &
      TerminalTransition,
  ): boolean {
    if (generation !== this.generation) return false;
    const job = this.jobs.get(id);
    if (
      !job ||
      job.generation !== generation ||
      (job.status !== "running" && job.status !== "cleanup_failed")
    )
      return false;
    Object.assign(job, {
      outputPath: values.outputPath,
      metadataPath: values.metadataPath,
      requestedTerminalCause: values.requestedTerminalCause,
    });
    return this.applyTerminal(job, values);
  }

  finalizeShutdownCleanupFailure(
    id: string,
    generation: number,
    error: string,
    terminalTail?: JobRecord["terminalTail"],
  ): boolean {
    if (generation !== this.generation) return false;
    return this.applyCleanupFailure(id, generation, error, terminalTail);
  }

  transitionTerminal(id: string, generation: number, transition: TerminalTransition): boolean {
    if (!this.isCurrentGeneration(generation)) return false;

    const job = this.jobs.get(id);
    if (!job || job.generation !== generation || job.status !== "running") return false;

    return this.applyTerminal(job, transition);
  }

  private applyCleanupFailure(
    id: string,
    generation: number,
    error: string,
    terminalTail?: JobRecord["terminalTail"],
  ): boolean {
    const job = this.jobs.get(id);
    if (!job || job.generation !== generation) return false;
    job.status = "cleanup_failed";
    job.completedAt ??= this.now();
    job.error = error;
    if (terminalTail) job.terminalTail = terminalTail;
    return true;
  }

  private copy(job: JobRecord): JobRecord {
    return {
      ...job,
      monitor: job.monitor ? { ...job.monitor } : undefined,
      verification: { ...job.verification },
    };
  }

  private applyTerminal(job: JobRecord, transition: TerminalTransition): boolean {
    job.status = transition.status;
    job.completedAt = transition.completedAt ?? this.now();
    job.exitCode = transition.exitCode;
    job.error = transition.error;
    job.terminalTail = transition.terminalTail;
    return true;
  }
}
