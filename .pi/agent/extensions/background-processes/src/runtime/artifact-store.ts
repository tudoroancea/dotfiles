import { randomUUID } from "node:crypto";
import { constants, writeSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_GENERATED_JOB_ID } from "./job-store.ts";
import { ARTIFACT_JOB_PATH_MAX_BYTES } from "./results.ts";
import type { JobMetadata } from "./types.ts";

export const ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024 * 1024;

export interface ArtifactStoreOptions {
  root?: string;
  now?: () => Date;
  pid?: number;
  runtimeId?: string;
  isProcessAlive?: (pid: number) => boolean;
  maxAgeMs?: number;
  maxBytes?: number;
}

interface OwnerMetadata {
  pid: number;
  runtimeId: string;
  startedAt: string;
  closedAt?: string;
}

interface CleanupCandidate {
  path: string;
  completedAt: number;
  bytes: number;
  currentJobId?: string;
}

export interface ArtifactCleanupOptions {
  isCurrentJobProtected?: (jobId: string) => boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
  return safe || "session";
}

function assertCompletionSafePath(path: string): void {
  const pathBytes = Buffer.byteLength(path, "utf8");
  const serializedBytes = Buffer.byteLength(JSON.stringify(path), "utf8") - 2;
  if (pathBytes <= ARTIFACT_JOB_PATH_MAX_BYTES && serializedBytes <= ARTIFACT_JOB_PATH_MAX_BYTES) {
    return;
  }
  throw new Error(
    `Artifact job path is not completion-safe: generated path requires ${pathBytes} bytes (${serializedBytes} bytes when serialized), but the supported maximum is ${ARTIFACT_JOB_PATH_MAX_BYTES} bytes. Choose a shorter artifact root without JSON-escaped path characters.`,
  );
}

function assertCompletionSafeJobDirectory(directory: string): void {
  assertCompletionSafePath(join(directory, "output.log"));
  assertCompletionSafePath(join(directory, "job.json"));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class OutputAppendError extends Error {
  constructor(
    message: string,
    readonly persistedBytes: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OutputAppendError";
  }
}

export class JobArtifacts {
  readonly outputPath: string;
  readonly metadataPath: string;
  readonly queuedOutputBuffers = 0;
  private checkpoints: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly directory: string,
    private readonly output: FileHandle,
  ) {
    this.outputPath = join(directory, "output.log");
    this.metadataPath = join(directory, "job.json");
  }

  append(chunk: Buffer): void {
    if (this.closed) throw new OutputAppendError("output log is closed", 0);
    let offset = 0;
    try {
      while (offset < chunk.length) {
        const bytesWritten = writeSync(this.output.fd, chunk, offset, chunk.length - offset);
        if (bytesWritten === 0) throw new Error("output log write made no progress");
        offset += bytesWritten;
      }
    } catch (error) {
      throw new OutputAppendError(`output log write failed: ${errorMessage(error)}`, offset, {
        cause: error,
      });
    }
  }

  checkpoint(metadata: JobMetadata): Promise<void> {
    const snapshot = structuredClone(metadata);
    this.checkpoints = this.checkpoints.then(
      () => atomicJson(this.metadataPath, snapshot),
      () => atomicJson(this.metadataPath, snapshot),
    );
    return this.checkpoints;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let writeError: unknown;
    try {
      await this.output.sync();
    } catch (error) {
      writeError = error;
    }
    await this.output.close().catch((error: unknown) => {
      writeError ??= error;
    });
    if (writeError) throw writeError;
  }
}

export class ArtifactStore {
  readonly root: string;
  readonly sessionDirectory: string;
  readonly runtimeDirectory: string;
  readonly runtimeId: string;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private initialized = false;
  private owner?: OwnerMetadata;
  private cleanupChain: Promise<void> = Promise.resolve();

  constructor(sessionId: string, options: ArtifactStoreOptions = {}) {
    this.root = options.root ?? join(getAgentDir(), "background-processes");
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.sessionDirectory = join(this.root, safeSegment(sessionId));
    this.runtimeDirectory = join(this.sessionDirectory, safeSegment(this.runtimeId));
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.maxAgeMs = options.maxAgeMs ?? ARTIFACT_MAX_AGE_MS;
    this.maxBytes = options.maxBytes ?? ARTIFACT_MAX_BYTES;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    assertCompletionSafeJobDirectory(join(this.runtimeDirectory, MAX_GENERATED_JOB_ID));
    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(this.root, 0o700),
      chmod(this.sessionDirectory, 0o700),
      chmod(this.runtimeDirectory, 0o700),
    ]);
    const owner: OwnerMetadata = {
      pid: this.pid,
      runtimeId: this.runtimeId,
      startedAt: this.now().toISOString(),
    };
    await atomicJson(join(this.runtimeDirectory, "owner.json"), owner);
    this.owner = owner;
    this.initialized = true;
  }

  async markClosed(): Promise<void> {
    if (!this.initialized || !this.owner) throw new Error("artifact store is not initialized");
    const owner = { ...this.owner, closedAt: this.now().toISOString() };
    await atomicJson(join(this.runtimeDirectory, "owner.json"), owner);
    this.owner = owner;
  }

  async checkpoint(metadata: JobMetadata): Promise<void> {
    if (
      !metadata.metadataPath ||
      dirname(dirname(metadata.metadataPath)) !== this.runtimeDirectory
    ) {
      throw new Error("job metadata path is outside this runtime");
    }
    await atomicJson(metadata.metadataPath, metadata);
  }

  async createJob(jobId: string): Promise<JobArtifacts> {
    await this.initialize();
    const directory = join(this.runtimeDirectory, safeSegment(jobId));
    assertCompletionSafeJobDirectory(directory);
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    const outputPath = join(directory, "output.log");
    const output = await open(
      outputPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await chmod(outputPath, 0o600);
      return new JobArtifacts(directory, output);
    } catch (error) {
      await output.close().catch(() => undefined);
      throw error;
    }
  }

  cleanup(options: ArtifactCleanupOptions = {}): Promise<void> {
    const work = this.cleanupChain.catch(() => undefined).then(() => this.performCleanup(options));
    this.cleanupChain = work;
    return work;
  }

  private async performCleanup(options: ArtifactCleanupOptions): Promise<void> {
    assertCompletionSafeJobDirectory(join(this.runtimeDirectory, MAX_GENERATED_JOB_ID));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const candidates: CleanupCandidate[] = [];
    for (const session of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!session.isDirectory()) continue;
      const sessionPath = join(this.root, session.name);
      for (const runtime of await readdir(sessionPath, { withFileTypes: true }).catch(() => [])) {
        if (!runtime.isDirectory()) continue;
        const runtimePath = join(sessionPath, runtime.name);
        if (runtimePath === this.runtimeDirectory) {
          if (options.isCurrentJobProtected) {
            candidates.push(...(await this.completedCurrentJobs(options.isCurrentJobProtected)));
          }
          continue;
        }
        const candidate = await this.completedInactiveRuntime(runtimePath);
        if (candidate) candidates.push(candidate);
      }
    }

    candidates.sort(
      (left, right) => left.completedAt - right.completedAt || left.path.localeCompare(right.path),
    );
    const now = this.now().getTime();
    let total = await directorySize(this.root);
    for (const candidate of candidates) {
      if (now - candidate.completedAt <= this.maxAgeMs && total <= this.maxBytes) continue;
      if (candidate.currentJobId && options.isCurrentJobProtected?.(candidate.currentJobId))
        continue;
      await rm(candidate.path, { recursive: true, force: true });
      total -= candidate.bytes;
    }
  }

  private async completedCurrentJobs(
    isProtected: (jobId: string) => boolean,
  ): Promise<CleanupCandidate[]> {
    const candidates: CleanupCandidate[] = [];
    for (const entry of await readdir(this.runtimeDirectory, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (!entry.isDirectory() || isProtected(entry.name)) continue;
      const path = join(this.runtimeDirectory, entry.name);
      try {
        const metadata = JSON.parse(await readFile(join(path, "job.json"), "utf8")) as JobMetadata;
        const completedAt = metadata.completedAt ? Date.parse(metadata.completedAt) : Number.NaN;
        const settled =
          metadata.deliveryState === "sent" ||
          metadata.deliveryState === "failed" ||
          metadata.deliveryState === "consumed";
        if (
          metadata.id !== entry.name ||
          metadata.runtimeId !== this.runtimeId ||
          metadata.status === "running" ||
          !settled ||
          !metadata.verification.processSettled ||
          !metadata.verification.outputLogClosed ||
          !metadata.verification.terminalMetadataPersisted ||
          metadata.deliveryPersistenceError ||
          metadata.monitorDeliveryPersistenceError ||
          !Number.isFinite(completedAt)
        ) {
          continue;
        }
        candidates.push({
          path,
          completedAt,
          bytes: await directorySize(path),
          currentJobId: metadata.id,
        });
      } catch {
        continue;
      }
    }
    return candidates;
  }

  private async completedInactiveRuntime(path: string): Promise<CleanupCandidate | undefined> {
    let owner: OwnerMetadata;
    try {
      owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as OwnerMetadata;
    } catch {
      return undefined;
    }
    if (owner.runtimeId !== basename(path)) return undefined;
    const ownerAlive = this.isProcessAlive(owner.pid);
    if (ownerAlive && !owner.closedAt) return undefined;

    let completedAt = owner.closedAt ? Date.parse(owner.closedAt) : Date.parse(owner.startedAt);
    let jobs = 0;
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      try {
        const metadata = JSON.parse(
          await readFile(join(path, entry.name, "job.json"), "utf8"),
        ) as JobMetadata;
        if (metadata.status === "running" || !metadata.completedAt) return undefined;
        completedAt = Math.max(completedAt, Date.parse(metadata.completedAt));
        jobs += 1;
      } catch {
        return undefined;
      }
    }
    if (!Number.isFinite(completedAt)) return undefined;
    return { path, completedAt, bytes: await directorySize(path) };
  }
}
