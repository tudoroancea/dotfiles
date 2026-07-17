import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProcessRuntime } from "../src/runtime/process-runtime.ts";
import type { ArtifactStore, JobArtifacts } from "../src/runtime/artifact-store.ts";
import { ARTIFACT_JOB_PATH_MAX_BYTES, type SerializedJobs } from "../src/runtime/results.ts";
import type { JobMetadata } from "../src/runtime/types.ts";

class MemoryArtifacts {
  readonly runtimeId = "memory-runtime";
  readonly checkpoints: JobMetadata[] = [];
  readonly output: Buffer[] = [];
  readonly jobs = new Map<string, JobArtifacts>();
  failWrites = false;
  failClose = false;
  failInitialCheckpoint = false;
  terminalCheckpointFailures = new Set<JobMetadata["status"]>();
  terminalCheckpointFailureCounts = new Map<JobMetadata["status"], number>();
  deliveryCheckpointFailureCounts = new Map<JobMetadata["deliveryState"], number>();
  private failedTerminalCheckpoints = new Set<JobMetadata["status"]>();
  initialize = vi.fn(async () => undefined);
  cleanup = vi.fn(async () => undefined);
  markClosed = vi.fn(async () => undefined);
  checkpoint = vi.fn(async (value: JobMetadata) => {
    this.checkpoints.push(structuredClone(value));
    const remaining = this.deliveryCheckpointFailureCounts.get(value.deliveryState) ?? 0;
    if (remaining > 0) {
      this.deliveryCheckpointFailureCounts.set(value.deliveryState, remaining - 1);
      throw new Error(`cannot persist delivery ${value.deliveryState}`);
    }
  });

  async createJob(jobId: string): Promise<JobArtifacts> {
    const artifacts = {
      directory: `/artifacts/${jobId}`,
      outputPath: `/artifacts/${jobId}/output.log`,
      metadataPath: `/artifacts/${jobId}/job.json`,
      append: (chunk: Buffer) => {
        if (this.failWrites) throw new Error("disk full");
        this.output.push(Buffer.from(chunk));
      },
      checkpoint: async (value: JobMetadata) => {
        this.checkpoints.push(structuredClone(value));
        if (this.failInitialCheckpoint && value.status === "running") {
          this.failInitialCheckpoint = false;
          throw new Error("cannot persist running");
        }
        const remainingFailures = this.terminalCheckpointFailureCounts.get(value.status) ?? 0;
        if (remainingFailures > 0) {
          this.terminalCheckpointFailureCounts.set(value.status, remainingFailures - 1);
          throw new Error(`cannot persist ${value.status}`);
        }
        if (
          this.terminalCheckpointFailures.has(value.status) &&
          !this.failedTerminalCheckpoints.has(value.status)
        ) {
          this.failedTerminalCheckpoints.add(value.status);
          throw new Error(`cannot persist ${value.status}`);
        }
      },
      close: async () => {
        if (this.failClose) throw new Error("close failed");
      },
    } as JobArtifacts;
    this.jobs.set(jobId, artifacts);
    return artifacts;
  }
}

function runtimeWith(operations: BashOperations, artifacts = new MemoryArtifacts(), options = {}) {
  return {
    runtime: new ProcessRuntime("test", {
      operations,
      artifacts: artifacts as unknown as ArtifactStore,
      ...options,
    }),
    artifacts,
  };
}

async function waitForTerminal(runtime: ProcessRuntime, id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runtime.get(id)?.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} did not settle`);
}

async function waitForVerified(runtime: ProcessRuntime, id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runtime.get(id)?.verification.terminalMetadataPersisted) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} was not verified`);
}

function abortableOperation(onAbort?: () => void): BashOperations {
  return {
    exec: vi.fn(async (_command, _cwd, { signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            onAbort?.();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return { exitCode: null };
    }),
  };
}

describe("ProcessRuntime", () => {
  it("publishes fresh global and per-job snapshots with idempotent unsubscribe", async () => {
    let push!: (chunk: Buffer) => void;
    const { runtime } = runtimeWith({
      exec: vi.fn(async (_command, _cwd, { onData, signal }) => {
        push = onData;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { exitCode: null };
      }),
    });
    const global = vi.fn();
    const perJob = vi.fn();
    const unsubscribeGlobal = runtime.subscribe(global);
    const job = await runtime.launch({ kind: "background_run", command: "live", cwd: "/tmp" });
    const unsubscribeJob = runtime.subscribeJob(job.id, perJob);

    push(Buffer.from("fresh output"));
    expect(global).toHaveBeenCalled();
    expect(global.mock.calls.at(-1)![0][0]).toMatchObject({
      id: job.id,
      outputBytes: 12,
      terminalTail: { content: "fresh output" },
    });
    expect(perJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: job.id, outputBytes: 12 }),
    );
    global.mock.calls.at(-1)![0][0].outputBytes = 999;
    expect(runtime.get(job.id)?.outputBytes).toBe(12);

    unsubscribeGlobal();
    unsubscribeGlobal();
    unsubscribeJob();
    unsubscribeJob();
    const globalCalls = global.mock.calls.length;
    const jobCalls = perJob.mock.calls.length;
    push(Buffer.from(" ignored by subscribers"));
    expect(global).toHaveBeenCalledTimes(globalCalls);
    expect(perJob).toHaveBeenCalledTimes(jobCalls);
    await runtime.stop(job.id);
    await runtime.shutdown();
  });

  it("streams complete combined bytes and maps zero/nonzero exits", async () => {
    let invocation = 0;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        onData(Buffer.from("first"));
        onData(Buffer.from("\nsecond\n"));
        return { exitCode: invocation++ };
      }),
    };
    const { runtime, artifacts } = runtimeWith(operations);
    await runtime.initialize();
    const completed = await runtime.launch({ kind: "background_run", command: "ok", cwd: "/tmp" });
    const failed = await runtime.launch({ kind: "background_run", command: "bad", cwd: "/tmp" });
    await Promise.all([
      waitForTerminal(runtime, completed.id),
      waitForTerminal(runtime, failed.id),
    ]);

    expect(runtime.get(completed.id)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(runtime.get(failed.id)).toMatchObject({ status: "failed", exitCode: 1 });
    expect(Buffer.concat(artifacts.output).toString()).toBe("first\nsecond\nfirst\nsecond\n");
    expect(artifacts.checkpoints.at(-1)).not.toHaveProperty("env");
    await runtime.shutdown();
  });

  it("uses a runtime-owned controller and keeps timeout as the stable first cause", async () => {
    const aborted = vi.fn();
    const operations = abortableOperation(aborted);
    const { runtime } = runtimeWith(operations);
    const job = await runtime.launch({
      kind: "background_run",
      command: "sleep",
      cwd: "/tmp",
      timeout: 0.01,
    });
    await waitForTerminal(runtime, job.id);

    expect(aborted).toHaveBeenCalledOnce();
    expect(runtime.get(job.id)).toMatchObject({
      status: "timed_out",
      requestedTerminalCause: "timeout",
    });
    await runtime.shutdown();
  });

  it("keeps stop ahead of a racing operation exit", async () => {
    let release!: (value: { exitCode: number | null }) => void;
    const operations: BashOperations = {
      exec: vi.fn(
        () =>
          new Promise<{ exitCode: number | null }>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const { runtime } = runtimeWith(operations);
    const job = await runtime.launch({ kind: "background_run", command: "race", cwd: "/tmp" });
    const stopping = runtime.stop(job.id);
    release({ exitCode: 0 });
    await stopping;

    expect(runtime.get(job.id)).toMatchObject({
      status: "cancelled",
      requestedTerminalCause: "stop",
      exitCode: 0,
    });
    await runtime.shutdown();
  });

  it("keeps timeout ahead of a racing stop", async () => {
    let releaseAbort!: () => void;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              releaseAbort = () => reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { exitCode: null };
      }),
    };
    const { runtime } = runtimeWith(operations);
    const job = await runtime.launch({
      kind: "background_run",
      command: "timeout-stop-race",
      cwd: "/tmp",
      timeout: 0.005,
    });
    for (let attempt = 0; attempt < 100 && !releaseAbort; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const stopping = runtime.stop(job.id);
    releaseAbort();
    await stopping;

    expect(runtime.get(job.id)).toMatchObject({
      status: "timed_out",
      requestedTerminalCause: "timeout",
    });
    await runtime.shutdown();
  });

  it("enforces the output limit and aborts the operation", async () => {
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData, signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          onData(Buffer.from("123456789"));
        });
        return { exitCode: null };
      }),
    };
    const { runtime, artifacts } = runtimeWith(operations, new MemoryArtifacts(), {
      outputMaxBytes: 5,
    });
    const job = await runtime.launch({ kind: "background_run", command: "loud", cwd: "/tmp" });
    await waitForTerminal(runtime, job.id);

    expect(Buffer.concat(artifacts.output).toString()).toBe("12345");
    expect(runtime.get(job.id)).toMatchObject({
      status: "failed",
      requestedTerminalCause: "output_limit",
      outputBytes: 5,
    });
    await runtime.shutdown();
  });

  it("keeps an output-write failure ahead of a simultaneous successful exit", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.failWrites = true;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        onData(Buffer.from("lost"));
        return { exitCode: 0 };
      }),
    };
    const { runtime } = runtimeWith(operations, artifacts);
    const job = await runtime.launch({
      kind: "background_run",
      command: "write-exit-race",
      cwd: "/tmp",
    });
    await waitForTerminal(runtime, job.id);

    expect(runtime.get(job.id)).toMatchObject({
      status: "failed",
      requestedTerminalCause: "output_error",
      exitCode: 0,
    });
    await runtime.shutdown();
  });

  it("claims output_error and aborts when persistence fails", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.failWrites = true;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData, signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          onData(Buffer.from("data"));
        });
        return { exitCode: null };
      }),
    };
    const { runtime } = runtimeWith(operations, artifacts);
    const job = await runtime.launch({ kind: "background_run", command: "write", cwd: "/tmp" });
    await waitForTerminal(runtime, job.id);

    expect(runtime.get(job.id)).toMatchObject({
      status: "failed",
      requestedTerminalCause: "output_error",
      outputBytes: 0,
      terminalTail: { content: "", bytes: 0 },
    });
    expect(artifacts.output).toEqual([]);
    await runtime.shutdown();
  });

  it.each([
    { name: "completed", exitCode: 0, action: "exit" },
    { name: "failed", exitCode: 2, action: "exit" },
    { name: "timed_out", exitCode: null, action: "timeout" },
    { name: "stopped", exitCode: null, action: "stop" },
  ] as const)("surfaces a $name terminal checkpoint failure", async ({ exitCode, action }) => {
    const artifacts = new MemoryArtifacts();
    const terminalStatus =
      action === "timeout"
        ? "timed_out"
        : action === "stop"
          ? "cancelled"
          : exitCode === 0
            ? "completed"
            : "failed";
    artifacts.terminalCheckpointFailures.add(terminalStatus);
    const operations =
      action === "exit"
        ? ({ exec: async () => ({ exitCode }) } satisfies BashOperations)
        : abortableOperation();
    const { runtime } = runtimeWith(operations, artifacts);
    const job = await runtime.launch({
      kind: "background_run",
      command: action,
      cwd: "/tmp",
      ...(action === "timeout" ? { timeout: 0.01 } : {}),
    });
    if (action === "stop") await runtime.stop(job.id);
    await waitForTerminal(runtime, job.id);

    expect(runtime.get(job.id)).toMatchObject({
      status: "cleanup_failed",
      error: expect.stringContaining("terminal metadata checkpoint failed"),
    });
    await runtime.shutdown();
  });

  it("rejects shutdown after the terminal checkpoint retry also fails", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.terminalCheckpointFailureCounts.set("completed", 1);
    artifacts.terminalCheckpointFailureCounts.set("cleanup_failed", 1);
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    await waitForTerminal(runtime, job.id);

    expect(runtime.get(job.id)).toMatchObject({
      status: "cleanup_failed",
      verification: { terminalMetadataPersisted: false },
    });
    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
    expect(artifacts.markClosed).not.toHaveBeenCalled();
  });

  it("terminally finalizes an initial running-checkpoint failure", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.failInitialCheckpoint = true;
    const operations: BashOperations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
    const { runtime } = runtimeWith(operations, artifacts);

    await expect(
      runtime.launch({ kind: "background_run", command: "never-started", cwd: "/tmp" }),
    ).rejects.toThrow("cannot persist running");

    expect(operations.exec).not.toHaveBeenCalled();
    expect(runtime.get("bg_1")).toBeUndefined();
    expect(runtime.list()).toEqual([]);
    expect(artifacts.checkpoints.at(-1)).toMatchObject({
      status: "failed",
      verification: { terminalMetadataPersisted: true },
    });
    await runtime.shutdown();
  });

  it("surfaces failed terminal persistence after an initial checkpoint failure", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.failInitialCheckpoint = true;
    artifacts.terminalCheckpointFailureCounts.set("failed", 1);
    artifacts.terminalCheckpointFailureCounts.set("cleanup_failed", 1);
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);

    await expect(
      runtime.launch({ kind: "background_run", command: "never-started", cwd: "/tmp" }),
    ).rejects.toThrow("cannot persist running");

    expect(runtime.get("bg_1")).toBeUndefined();
    expect(runtime.list()).toEqual([]);
    await expect(runtime.shutdown()).rejects.toThrow(
      /could not be verified.*terminal metadata checkpoint failed after retry/,
    );
    expect(artifacts.markClosed).not.toHaveBeenCalled();
  });

  it("keeps observed exit authoritative while output log closure is slow", async () => {
    let releaseClose!: () => void;
    let closeStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closing = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const artifacts = new MemoryArtifacts();
    const originalCreate = artifacts.createJob.bind(artifacts);
    artifacts.createJob = vi.fn(async (jobId: string) => {
      const job = await originalCreate(jobId);
      job.close = vi.fn(async () => {
        closeStarted();
        await closeGate;
      });
      return job;
    });
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
    const job = await runtime.launch({
      kind: "background_run",
      command: "fast",
      cwd: "/tmp",
      timeout: 0.01,
    });
    await closing;
    const stopping = runtime.stop(job.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.get(job.id)).not.toHaveProperty("requestedTerminalCause");
    releaseClose();
    await stopping;

    expect(runtime.get(job.id)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(runtime.get(job.id)).not.toHaveProperty("requestedTerminalCause");
    await runtime.shutdown();
  });

  it("does not let shutdown override an exit observed before slow log closure", async () => {
    let releaseClose!: () => void;
    let closeStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closing = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const artifacts = new MemoryArtifacts();
    const originalCreate = artifacts.createJob.bind(artifacts);
    artifacts.createJob = vi.fn(async (jobId: string) => {
      const job = await originalCreate(jobId);
      job.close = vi.fn(async () => {
        closeStarted();
        await closeGate;
      });
      return job;
    });
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts, {
      shutdownVerificationMs: 100,
    });
    const job = await runtime.launch({ kind: "background_run", command: "fast", cwd: "/tmp" });
    await closing;
    const shutdown = runtime.shutdown();
    expect(runtime.get(job.id)).not.toHaveProperty("requestedTerminalCause");
    releaseClose();
    await shutdown;

    expect(runtime.get(job.id)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(runtime.get(job.id)).not.toHaveProperty("requestedTerminalCause");
  });

  it("retains output delivered after an abort claim until log closure", async () => {
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData, signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              onData(Buffer.from("buffered-after-abort\n"));
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { exitCode: null };
      }),
    };
    const { runtime, artifacts } = runtimeWith(operations);
    const job = await runtime.launch({ kind: "background_run", command: "buffer", cwd: "/tmp" });
    await runtime.stop(job.id);

    expect(Buffer.concat(artifacts.output).toString()).toBe("buffered-after-abort\n");
    expect(runtime.get(job.id)).toMatchObject({
      status: "cancelled",
      outputBytes: 21,
      terminalTail: { content: "buffered-after-abort\n" },
    });
    expect(artifacts.checkpoints.at(-1)).not.toHaveProperty("terminalTail");
    await runtime.shutdown();
  });

  it("does not start a deferred launch after shutdown begins", async () => {
    let release!: () => void;
    const artifacts = new MemoryArtifacts();
    const originalCreate = artifacts.createJob.bind(artifacts);
    artifacts.createJob = vi.fn(async (jobId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return originalCreate(jobId);
    });
    const operations: BashOperations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
    const { runtime } = runtimeWith(operations, artifacts, { shutdownVerificationMs: 100 });
    const launching = runtime.launch({ kind: "background_run", command: "late", cwd: "/tmp" });
    const shutdown = runtime.shutdown();
    release();

    await expect(launching).rejects.toThrow("shutting down");
    await shutdown;
    expect(operations.exec).not.toHaveBeenCalled();
    expect(runtime.get("bg_1")).toMatchObject({
      status: "cancelled",
      requestedTerminalCause: "shutdown",
      outputPath: "/artifacts/bg_1/output.log",
      metadataPath: "/artifacts/bg_1/job.json",
    });
    expect(artifacts.checkpoints.at(-1)).toMatchObject({
      status: "cancelled",
      requestedTerminalCause: "shutdown",
    });
  });

  it("durably finalizes a launch whose setup finishes after the shutdown deadline", async () => {
    let release!: () => void;
    const artifacts = new MemoryArtifacts();
    const originalCreate = artifacts.createJob.bind(artifacts);
    artifacts.createJob = vi.fn(async (jobId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return originalCreate(jobId);
    });
    const operations: BashOperations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
    const { runtime } = runtimeWith(operations, artifacts, { shutdownVerificationMs: 10 });
    const launching = runtime.launch({ kind: "background_run", command: "late", cwd: "/tmp" });

    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
    release();
    await expect(launching).rejects.toThrow("shutting down");

    expect(operations.exec).not.toHaveBeenCalled();
    expect(runtime.get("bg_1")).toMatchObject({
      status: "cancelled",
      requestedTerminalCause: "shutdown",
      outputPath: "/artifacts/bg_1/output.log",
      metadataPath: "/artifacts/bg_1/job.json",
    });
    expect(artifacts.checkpoints.at(-1)).toMatchObject({
      status: "cancelled",
      requestedTerminalCause: "shutdown",
      outputPath: "/artifacts/bg_1/output.log",
      metadataPath: "/artifacts/bg_1/job.json",
    });
  });

  it("rejects shutdown when owner closure cannot be verified", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.markClosed.mockRejectedValueOnce(new Error("owner disk failure"));
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    await waitForTerminal(runtime, job.id);

    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
    expect(runtime.get(job.id)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(artifacts.checkpoint).not.toHaveBeenCalled();
  });

  it("bounds owner closure verification by the shutdown deadline", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.markClosed.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts, {
      shutdownVerificationMs: 15,
    });
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    await waitForTerminal(runtime, job.id);
    const started = Date.now();

    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
    expect(Date.now() - started).toBeLessThan(150);
    expect(runtime.get(job.id)).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("bounds pending launch and cleanup diagnostic checkpoint waits by one deadline", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.createJob = vi.fn(() => new Promise<JobArtifacts>(() => undefined));
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts, {
      shutdownVerificationMs: 20,
    });
    void runtime.launch({ kind: "background_run", command: "never-created", cwd: "/tmp" });
    const started = Date.now();
    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
    expect(Date.now() - started).toBeLessThan(150);

    const checkpointArtifacts = new MemoryArtifacts();
    const neverSettles: BashOperations = {
      exec: vi.fn(() => new Promise<{ exitCode: number | null }>(() => undefined)),
    };
    const { runtime: stuckRuntime } = runtimeWith(neverSettles, checkpointArtifacts, {
      shutdownVerificationMs: 20,
    });
    const job = await stuckRuntime.launch({
      kind: "background_run",
      command: "stuck",
      cwd: "/tmp",
    });
    checkpointArtifacts.jobs.get(job.id)!.checkpoint = (value: JobMetadata) =>
      value.status === "cleanup_failed" ? new Promise<void>(() => undefined) : Promise.resolve();
    const diagnosticStarted = Date.now();
    await expect(stuckRuntime.shutdown()).rejects.toThrow("could not be verified");
    expect(Date.now() - diagnosticStarted).toBeLessThan(150);
    expect(stuckRuntime.get(job.id)?.status).toBe("cleanup_failed");
  });

  it("rejects shutdown when output-log closure fails", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.failClose = true;
    const { runtime } = runtimeWith(abortableOperation(), artifacts);
    const job = await runtime.launch({ kind: "background_run", command: "active", cwd: "/tmp" });

    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");

    expect(runtime.get(job.id)).toMatchObject({
      status: "cleanup_failed",
      requestedTerminalCause: "shutdown",
      error: expect.stringContaining("output log closure"),
      verification: { outputLogClosed: false },
    });
    expect(artifacts.markClosed).not.toHaveBeenCalled();
  });

  it("makes shutdown idempotent and records cleanup uncertainty", async () => {
    const operations: BashOperations = {
      exec: vi.fn(() => new Promise<{ exitCode: number | null }>(() => undefined)),
    };
    const { runtime, artifacts } = runtimeWith(operations, new MemoryArtifacts(), {
      shutdownVerificationMs: 10,
    });
    const job = await runtime.launch({ kind: "background_run", command: "stuck", cwd: "/tmp" });
    const first = runtime.shutdown();
    const second = runtime.shutdown();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow("could not be verified");

    expect(runtime.get(job.id)).toMatchObject({ status: "cleanup_failed" });
    expect(artifacts.checkpoints.at(-1)).toMatchObject({ status: "cleanup_failed" });
  });

  it("discards provisional records when artifact creation fails", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.createJob = vi.fn(async () => {
      throw new Error("cannot create artifacts");
    });
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);

    for (let index = 0; index < 55; index += 1) {
      await expect(
        runtime.launch({
          kind: "background_run",
          command: `failure ${index}`,
          cwd: "/tmp",
        }),
      ).rejects.toThrow("cannot create artifacts");
    }

    expect(runtime.list()).toHaveLength(0);
    await runtime.shutdown();
  });

  it("releases capacity after every thrown setup failure and permits recovery", async () => {
    const artifacts = new MemoryArtifacts();
    const operations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
    const { runtime } = runtimeWith(operations, artifacts);
    for (let index = 0; index < 55; index += 1) {
      artifacts.failInitialCheckpoint = true;
      await expect(
        runtime.launch({
          kind: "background_run",
          command: `failure ${index}`,
          cwd: "/tmp",
        }),
      ).rejects.toThrow("cannot persist running");
    }

    expect(operations.exec).not.toHaveBeenCalled();
    expect(runtime.list()).toEqual([]);
    const recovered = await runtime.launch({
      kind: "background_run",
      command: "recovered",
      cwd: "/tmp",
    });
    await waitForVerified(runtime, recovered.id);
    expect(runtime.get(recovered.id)?.status).toBe("completed");
    await runtime.shutdown();
  });

  it("wait timeout and caller abort detach without stopping or consuming jobs", async () => {
    const aborted = vi.fn();
    const { runtime } = runtimeWith(abortableOperation(aborted));
    const job = await runtime.launch({ kind: "background_run", command: "sleep", cwd: "/tmp" });

    const timedOut = await runtime.wait([job.id], { timeout: 0.005 });
    expect(timedOut[0]).toMatchObject({ status: "running", deliveryState: "pending" });
    expect(aborted).not.toHaveBeenCalled();

    const controller = new AbortController();
    const waiting = runtime.wait([job.id], { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toThrow("Wait aborted");
    expect(runtime.get(job.id)).toMatchObject({ status: "running", deliveryState: "pending" });
    expect(aborted).not.toHaveBeenCalled();
    await runtime.stop(job.id);
    await runtime.shutdown();
  });

  it("wait timeout preserves a later automatic completion delivery", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = runtimeWith({
      exec: vi.fn(async () => {
        await gate;
        return { exitCode: 0 };
      }),
    });
    const job = await runtime.launch({ kind: "background_run", command: "later", cwd: "/tmp" });
    runtime.markLaunchTransferred(job.id);

    const timedOut = await runtime.waitResult([job.id], { timeout: 0.005 });
    expect(timedOut.jobs[0]).toMatchObject({ status: "running", deliveryState: "pending" });
    expect(runtime.get(job.id)?.deliveryState).toBe("pending");
    release();
    await waitForTerminal(runtime, job.id);

    const send = vi.fn();
    await expect(runtime.flushCompletionDeliveries(send)).resolves.toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(runtime.get(job.id)?.deliveryState).toBe("sent");
    await runtime.shutdown();
  });

  it("terminal wait returns immediately and consumes only terminal deliveries", async () => {
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) });
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    await waitForTerminal(runtime, job.id);
    const before = Date.now();
    const payload = await runtime.waitResult([job.id]);
    expect(Date.now() - before).toBeLessThan(50);
    expect(payload.jobs[0]).toMatchObject({ status: "completed", deliveryState: "consumed" });
    expect(runtime.get(job.id)?.deliveryState).toBe("consumed");
    await runtime.shutdown();
  });

  it("resolves every stop ID before mutation and stops all active targets concurrently", async () => {
    const aborted: string[] = [];
    const operations: BashOperations = {
      exec: vi.fn(async (command, _cwd, { signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted.push(command);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { exitCode: null };
      }),
    };
    const { runtime } = runtimeWith(operations);
    const first = await runtime.launch({ kind: "background_run", command: "first", cwd: "/tmp" });
    const second = await runtime.launch({
      kind: "background_run",
      command: "second",
      cwd: "/tmp",
    });
    await expect(runtime.stopMany([first.id, "missing"])).rejects.toThrow("missing");
    expect(aborted).toEqual([]);

    const stopped = await runtime.stopManyResult([first.id, second.id]);
    expect(new Set(aborted)).toEqual(new Set(["first", "second"]));
    expect(
      stopped.jobs.every((job) => job.status === "cancelled" && job.deliveryState === "consumed"),
    ).toBe(true);
    expect(runtime.get(first.id)?.deliveryState).toBe("consumed");
    expect((await runtime.stopMany([first.id]))[0]?.status).toBe("cancelled");
    const send = vi.fn();
    await expect(runtime.flushCompletionDeliveries(send)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("coalesces claimed completion delivery and records an at-most-once failed send", async () => {
    const artifacts = new MemoryArtifacts();
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
    const first = await runtime.launch({ kind: "background_run", command: "one", cwd: "/tmp" });
    const second = await runtime.launch({ kind: "background_run", command: "two", cwd: "/tmp" });
    runtime.markLaunchTransferred(first.id);
    runtime.markLaunchTransferred(second.id);
    await Promise.all([waitForTerminal(runtime, first.id), waitForTerminal(runtime, second.id)]);

    const send = vi.fn(async (_payload: SerializedJobs) => {
      await runtime.flushCompletionDeliveries(send);
      throw new Error("queue unavailable");
    });
    expect(await runtime.flushCompletionDeliveries(send)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]![0];
    expect(payload.jobs.map((job: { jobId: string }) => job.jobId)).toEqual([first.id, second.id]);
    expect(payload.jobs.every((job) => job.deliveryState === "sending")).toBe(true);
    expect(Buffer.byteLength(payload.text)).toBeLessThanOrEqual(50 * 1024);
    expect(payload.text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(runtime.get(first.id)).toMatchObject({
      deliveryState: "failed",
      deliveryError: "queue unavailable",
    });
    expect(await runtime.flushCompletionDeliveries(send)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(artifacts.checkpoints.at(-1)).toMatchObject({ deliveryState: "failed" });
    await runtime.shutdown();
  });

  it("does not consume a sending delivery during concurrent wait and stop results", async () => {
    let sendStarted!: () => void;
    let releaseSend!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) });
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    runtime.markLaunchTransferred(job.id);
    await waitForTerminal(runtime, job.id);

    const flushing = runtime.flushCompletionDeliveries(async () => {
      sendStarted();
      await gate;
    });
    await started;
    expect(runtime.get(job.id)?.deliveryState).toBe("sending");

    const [waited, stopped] = await Promise.all([
      runtime.waitResult([job.id]),
      runtime.stopManyResult([job.id]),
    ]);
    expect(waited.jobs[0]?.deliveryState).toBe("sending");
    expect(stopped.jobs[0]?.deliveryState).toBe("sending");
    expect(runtime.get(job.id)?.deliveryState).toBe("sending");

    releaseSend();
    await expect(flushing).resolves.toBe(true);
    expect(runtime.get(job.id)?.deliveryState).toBe("sent");
    await runtime.shutdown();
  });

  it("does not claim delivery or consume management results when construction throws", async () => {
    const serializer = vi.fn(() => {
      throw new Error("forced construction failure");
    });
    const { runtime } = runtimeWith(
      { exec: vi.fn(async () => ({ exitCode: 0 })) },
      new MemoryArtifacts(),
      { serializer },
    );
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    runtime.markLaunchTransferred(job.id);
    await waitForTerminal(runtime, job.id);

    await expect(runtime.flushCompletionDeliveries(vi.fn())).rejects.toThrow(
      "forced construction failure",
    );
    expect(runtime.get(job.id)?.deliveryState).toBe("pending");
    await expect(runtime.waitResult([job.id])).rejects.toThrow("forced construction failure");
    expect(runtime.get(job.id)?.deliveryState).toBe("pending");
    await expect(runtime.stopManyResult([job.id])).rejects.toThrow("forced construction failure");
    expect(runtime.get(job.id)?.deliveryState).toBe("pending");
    await runtime.shutdown();
  });

  it.each(["sent", "failed", "consumed"] as const)(
    "retries the first %s delivery checkpoint without changing process status",
    async (state) => {
      const artifacts = new MemoryArtifacts();
      artifacts.deliveryCheckpointFailureCounts.set(state, 1);
      const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
      const job = await runtime.launch({ kind: "background_run", command: state, cwd: "/tmp" });
      runtime.markLaunchTransferred(job.id);
      await waitForTerminal(runtime, job.id);
      if (state === "consumed") await runtime.waitResult([job.id]);
      else
        await runtime.flushCompletionDeliveries(() => {
          if (state === "failed") throw new Error("send failed");
        });

      expect(runtime.get(job.id)).toMatchObject({ status: "completed", deliveryState: state });
      expect(runtime.get(job.id)?.deliveryPersistenceError).toBeUndefined();
      await runtime.shutdown();
    },
  );

  it.each(["sent", "failed", "consumed"] as const)(
    "isolates permanent %s delivery checkpoint failure and rejects delivery-aware shutdown",
    async (state) => {
      const artifacts = new MemoryArtifacts();
      artifacts.deliveryCheckpointFailureCounts.set(state, 2);
      const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
      const job = await runtime.launch({ kind: "background_run", command: state, cwd: "/tmp" });
      runtime.markLaunchTransferred(job.id);
      await waitForTerminal(runtime, job.id);
      if (state === "consumed") await runtime.waitResult([job.id]);
      else
        await runtime.flushCompletionDeliveries(() => {
          if (state === "failed") throw new Error("send failed");
        });

      expect(runtime.get(job.id)).toMatchObject({
        status: "completed",
        deliveryState: state,
        deliveryPersistenceError: expect.stringContaining("after retry"),
      });
      await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
      expect(runtime.get(job.id)?.status).toBe("completed");
    },
  );

  it("awaits an in-flight delivery checkpoint failure before shutdown verification", async () => {
    let checkpointStarted!: () => void;
    let releaseCheckpoint!: () => void;
    const started = new Promise<void>((resolve) => {
      checkpointStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const artifacts = new MemoryArtifacts();
    artifacts.checkpoint = vi.fn(async (value: JobMetadata) => {
      artifacts.checkpoints.push(structuredClone(value));
      if (value.deliveryState === "sent") {
        checkpointStarted();
        await gate;
        throw new Error("delivery disk unavailable");
      }
    });
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    runtime.markLaunchTransferred(job.id);
    await waitForTerminal(runtime, job.id);

    const flushing = runtime.flushCompletionDeliveries(() => undefined);
    await started;
    const shuttingDown = runtime.shutdown();
    expect(artifacts.markClosed).not.toHaveBeenCalled();
    releaseCheckpoint();

    await expect(flushing).resolves.toBe(true);
    await expect(shuttingDown).rejects.toThrow("could not be verified");
    expect(runtime.get(job.id)?.deliveryPersistenceError).toContain("after retry");
    expect(artifacts.markClosed).not.toHaveBeenCalled();
  });

  it("protects a record from capacity eviction through gated delivery persistence", async () => {
    let checkpointStarted!: () => void;
    let releaseCheckpoint!: () => void;
    const started = new Promise<void>((resolve) => {
      checkpointStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const artifacts = new MemoryArtifacts();
    artifacts.checkpoint = vi.fn(async (value: JobMetadata) => {
      artifacts.checkpoints.push(structuredClone(value));
      if (value.id === "bg_1" && value.deliveryState === "sent") {
        checkpointStarted();
        await gate;
      }
    });
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts, {
      completedRecordLimit: 2,
    });
    const first = await runtime.launch({ kind: "background_run", command: "first", cwd: "/tmp" });
    const second = await runtime.launch({
      kind: "background_run",
      command: "second",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(first.id);
    runtime.markLaunchTransferred(second.id);
    await Promise.all([waitForTerminal(runtime, first.id), waitForTerminal(runtime, second.id)]);

    const flushing = runtime.flushCompletionDeliveries(() => undefined);
    await started;
    await expect(
      runtime.launch({ kind: "background_run", command: "blocked", cwd: "/tmp" }),
    ).rejects.toThrow("capacity");
    expect(runtime.get(first.id)?.deliveryState).toBe("sent");
    expect(runtime.get(second.id)?.deliveryState).toBe("sent");

    releaseCheckpoint();
    await expect(flushing).resolves.toBe(true);
    const replacement = await runtime.launch({
      kind: "background_run",
      command: "replacement",
      cwd: "/tmp",
    });
    expect(runtime.get(first.id)).toBeUndefined();
    expect(replacement.outputPath).toBeDefined();
    await runtime.shutdown();
  });

  it("serializes terminal persistence with timed wait consumption", async () => {
    let terminalStarted!: () => void;
    let releaseTerminal!: () => void;
    const started = new Promise<void>((resolve) => {
      terminalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const artifacts = new MemoryArtifacts();
    const originalCreate = artifacts.createJob.bind(artifacts);
    artifacts.createJob = vi.fn(async (jobId: string) => {
      const job = await originalCreate(jobId);
      const checkpoint = job.checkpoint.bind(job);
      job.checkpoint = async (value: JobMetadata) => {
        if (value.status !== "running") {
          terminalStarted();
          await gate;
        }
        await checkpoint(value);
      };
      return job;
    });
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts);
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    await started;

    const waiting = runtime.waitResult([job.id], { timeout: 0.001 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.get(job.id)?.deliveryState).toBe("consumed");
    releaseTerminal();
    await waiting;
    await waitForVerified(runtime, job.id);

    const terminalStates = artifacts.checkpoints
      .filter((checkpoint) => checkpoint.status !== "running")
      .map((checkpoint) => checkpoint.deliveryState);
    expect(terminalStates.at(-1)).toBe("consumed");
    expect(runtime.get(job.id)?.deliveryState).toBe("consumed");
    await runtime.shutdown();
  });

  it("pairs concurrent management references on invalid and pre-aborted waits", async () => {
    const { runtime } = runtimeWith(abortableOperation());
    const job = await runtime.launch({ kind: "background_run", command: "sleep", cwd: "/tmp" });
    const controller = new AbortController();
    const waiting = runtime.wait([job.id], { signal: controller.signal });
    const references = (runtime as unknown as { managementReferences: Map<string, Set<symbol>> })
      .managementReferences;
    expect(references.get(job.id)?.size).toBe(1);

    await expect(runtime.waitResult([job.id, "missing"])).rejects.toThrow("missing");
    expect(references.get(job.id)?.size).toBe(1);

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(runtime.wait([job.id], { signal: preAborted.signal })).rejects.toThrow(
      "Wait aborted",
    );
    expect(references.get(job.id)?.size).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toThrow("Wait aborted");
    expect(references.has(job.id)).toBe(false);
    await runtime.stop(job.id);
    await runtime.shutdown();
  });

  it("does not deliver a fast exit until launch ownership has transferred", async () => {
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) });
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    await waitForTerminal(runtime, job.id);
    const send = vi.fn();
    expect(await runtime.flushCompletionDeliveries(send)).toBe(false);
    runtime.markLaunchTransferred(job.id);
    expect(await runtime.flushCompletionDeliveries(send)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it("rejects at capacity before artifact allocation with actionable guidance", async () => {
    const artifacts = new MemoryArtifacts();
    const createJob = vi.spyOn(artifacts, "createJob");
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts, {
      completedRecordLimit: 3,
    });
    for (let index = 0; index < 3; index += 1) {
      const job = await runtime.launch({
        kind: "background_run",
        command: `pending ${index}`,
        cwd: "/tmp",
      });
      await waitForTerminal(runtime, job.id);
    }

    await expect(
      runtime.launch({ kind: "background_run", command: "rejected", cwd: "/tmp" }),
    ).rejects.toThrow(/capacity.*Wait.*inspect.*consume/i);
    expect(createJob).toHaveBeenCalledTimes(3);
    expect(runtime.list()).toHaveLength(3);
    await runtime.shutdown();
  });

  it.each(["consumed", "sent"] as const)(
    "recovers capacity after a completion is %s and cleans transfer bookkeeping",
    async (release) => {
      const { runtime } = runtimeWith(
        { exec: vi.fn(async () => ({ exitCode: 0 })) },
        new MemoryArtifacts(),
        { completedRecordLimit: 2 },
      );
      const first = await runtime.launch({
        kind: "background_run",
        command: "first",
        cwd: "/tmp",
      });
      const second = await runtime.launch({
        kind: "background_run",
        command: "second",
        cwd: "/tmp",
      });
      runtime.markLaunchTransferred(first.id);
      runtime.markLaunchTransferred(second.id);
      await Promise.all([waitForTerminal(runtime, first.id), waitForTerminal(runtime, second.id)]);
      if (release === "consumed") await runtime.waitResult([first.id]);
      else await runtime.flushCompletionDeliveries(() => undefined);

      const transfers = (runtime as unknown as { launchTransferred: Set<string> })
        .launchTransferred;
      expect(transfers.has(first.id)).toBe(false);
      if (release === "sent") expect(transfers.has(second.id)).toBe(false);
      const replacement = await runtime.launch({
        kind: "background_run",
        command: "replacement",
        cwd: "/tmp",
      });
      expect(replacement.outputPath).toBeDefined();
      expect(runtime.list().length).toBeLessThanOrEqual(2);
      await runtime.shutdown();
    },
  );

  it("recovers capacity after repeated thrown completion sends", async () => {
    const { runtime } = runtimeWith(
      { exec: vi.fn(async () => ({ exitCode: 0 })) },
      new MemoryArtifacts(),
      { completedRecordLimit: 2 },
    );
    const send = vi.fn(() => {
      throw new Error("queue unavailable");
    });

    for (let index = 0; index < 6; index += 1) {
      const job = await runtime.launch({
        kind: "background_run",
        command: `failed delivery ${index}`,
        cwd: "/tmp",
      });
      runtime.markLaunchTransferred(job.id);
      await waitForTerminal(runtime, job.id);
      await expect(runtime.flushCompletionDeliveries(send)).resolves.toBe(true);
      expect(runtime.get(job.id)).toMatchObject({
        deliveryState: "failed",
        deliveryPersistenceError: undefined,
      });
    }

    const later = await runtime.launch({
      kind: "background_run",
      command: "later launch",
      cwd: "/tmp",
    });
    expect(later.outputPath).toBeDefined();
    expect(send).toHaveBeenCalledTimes(6);
    expect(runtime.list().length).toBeLessThanOrEqual(2);
    await runtime.shutdown();
  });

  it("keeps an unpersisted failed delivery capacity-protected and shutdown-visible", async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.deliveryCheckpointFailureCounts.set("failed", 2);
    const { runtime } = runtimeWith({ exec: vi.fn(async () => ({ exitCode: 0 })) }, artifacts, {
      completedRecordLimit: 1,
    });
    const job = await runtime.launch({
      kind: "background_run",
      command: "failed persistence",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    await waitForTerminal(runtime, job.id);
    await expect(
      runtime.flushCompletionDeliveries(() => {
        throw new Error("queue unavailable");
      }),
    ).resolves.toBe(true);

    expect(runtime.get(job.id)).toMatchObject({
      deliveryState: "failed",
      deliveryPersistenceError: expect.stringContaining("after retry"),
    });
    await expect(
      runtime.launch({ kind: "background_run", command: "blocked", cwd: "/tmp" }),
    ).rejects.toThrow("capacity");
    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
    expect(runtime.get(job.id)).toMatchObject({
      deliveryState: "failed",
      deliveryPersistenceError: expect.stringContaining("after retry"),
    });
  });

  it.each(["background_event_stream", "background_run"] as const)(
    "fits 50 maximum-path %s completions in one send and releases capacity",
    async (kind) => {
      const artifacts = new MemoryArtifacts();
      const originalCreate = artifacts.createJob.bind(artifacts);
      artifacts.createJob = vi.fn(async (jobId: string) => {
        const job = await originalCreate(jobId);
        const suffix = `/${jobId}/output.log`;
        const outputPath = `/${" ".repeat(ARTIFACT_JOB_PATH_MAX_BYTES - Buffer.byteLength(suffix) - 1)}${suffix}`;
        const directory = outputPath.slice(0, -"/output.log".length);
        Object.assign(job, {
          directory,
          outputPath,
          metadataPath: `${directory}/job.json`,
        });
        return job;
      });
      const hostile = `${"maximum\n\r\u0000\u0007\u001b[31m\u009b32m".repeat(1_000)}`;
      const { runtime } = runtimeWith(
        {
          exec: vi.fn(async (_command, _cwd, { onData }) => {
            onData(Buffer.from(`${"event\n".repeat(2_100)}${"x".repeat(100_000)}\n`));
            throw new Error(hostile);
          }),
        },
        artifacts,
      );
      const jobs = await Promise.all(
        Array.from({ length: 50 }, async (_, index) => {
          const job = await runtime.launch({
            kind,
            command: `failure ${index}`,
            description: hostile,
            cwd: `/${hostile}`,
          });
          runtime.markLaunchTransferred(job.id);
          return job;
        }),
      );
      await Promise.all(jobs.map((job) => waitForTerminal(runtime, job.id)));
      const send = vi.fn();
      await runtime.flushCompletionDeliveries(send);

      expect(send).toHaveBeenCalledOnce();
      const payload = send.mock.calls[0]![0] as SerializedJobs;
      expect(payload.omittedCount).toBe(0);
      expect(payload.jobs).toHaveLength(50);
      expect(payload.jobs.map((job) => job.jobId)).toEqual(jobs.map((job) => job.id));
      expect(payload.jobs.map((job) => job.outputPath)).toEqual(jobs.map((job) => job.outputPath));
      expect(payload.jobs.map((job) => job.metadataPath)).toEqual(
        jobs.map((job) => job.metadataPath),
      );
      expect(
        payload.jobs.every(
          (job) => Buffer.byteLength(job.outputPath!) === ARTIFACT_JOB_PATH_MAX_BYTES,
        ),
      ).toBe(true);
      expect(payload.jobs.every((job) => job.kind === kind)).toBe(true);
      expect(
        payload.jobs.every((job) => Boolean(job.monitor) === (kind === "background_event_stream")),
      ).toBe(true);
      expect(Buffer.byteLength(payload.text)).toBeLessThanOrEqual(50 * 1024);
      expect(payload.text.split("\n")).toHaveLength(1);
      const isSafeLine = (value: string | undefined) =>
        [...(value ?? "")].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
        });
      expect(payload.jobs.every((job) => isSafeLine(job.error))).toBe(true);
      expect(runtime.list()).toHaveLength(50);
      expect(
        (runtime as unknown as { launchTransferred: Set<string> }).launchTransferred.size,
      ).toBe(0);

      const recovered = await runtime.launch({
        kind: "background_run",
        command: "recovered",
        cwd: "/tmp",
      });
      expect(recovered.outputPath).toBeDefined();
      expect(runtime.list().length).toBeLessThanOrEqual(50);
      await runtime.shutdown();
    },
  );

  it("leaves every pending completion unclaimed when serialization omits one", async () => {
    const serializer = vi.fn(
      (): SerializedJobs => ({
        jobs: [],
        text: '{"jobs":[]}',
        truncated: true,
        omittedCount: 1,
      }),
    );
    const { runtime } = runtimeWith(
      { exec: vi.fn(async () => ({ exitCode: 0 })) },
      new MemoryArtifacts(),
      { serializer },
    );
    const job = await runtime.launch({ kind: "background_run", command: "true", cwd: "/tmp" });
    runtime.markLaunchTransferred(job.id);
    await waitForTerminal(runtime, job.id);
    await expect(runtime.flushCompletionDeliveries(() => undefined)).rejects.toThrow(
      /all deliveries remain pending/,
    );
    expect(runtime.get(job.id)?.deliveryState).toBe("pending");
    await runtime.shutdown();
  });
});
