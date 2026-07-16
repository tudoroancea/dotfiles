import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStore, JobArtifacts } from "../src/runtime/artifact-store.ts";
import { MAX_GENERATED_JOB_ID } from "../src/runtime/job-store.ts";
import {
  boundedMonitorDeliveryError,
  formatMonitorEvent,
  formatMonitorFragment,
  MONITOR_FRAGMENT_BYTES,
  MONITOR_PENDING_BYTES,
  MonitorCoalescer,
  MonitorDecoder,
  MonitorPipeline,
  sanitizeMonitorText,
  type MonitorEvent,
  type MonitorFragment,
} from "../src/runtime/monitor.ts";
import { ProcessRuntime } from "../src/runtime/process-runtime.ts";
import { ARTIFACT_JOB_PATH_MAX_BYTES, serializeJobs } from "../src/runtime/results.ts";
import type { JobMetadata } from "../src/runtime/types.ts";

afterEach(() => vi.useRealTimers());

describe("monitor decoder and batching", () => {
  it("preserves split UTF-8, normalizes CRLF, and flushes only a final partial line", () => {
    const decoder = new MonitorDecoder();
    const bytes = Buffer.from("one\r\n雪\r\npartial");
    expect(decoder.write(bytes.subarray(0, 6)).map((item) => item.text)).toEqual(["one"]);
    expect(decoder.write(bytes.subarray(6, 7))).toEqual([]);
    expect(decoder.write(bytes.subarray(7, 11)).map((item) => item.text)).toEqual(["雪"]);
    expect(decoder.write(bytes.subarray(11))).toEqual([]);
    expect(decoder.end().map((item) => item.text)).toEqual(["partial"]);
  });

  it("sanitizes controls and incrementally bounds a multi-megabyte newline-free line", () => {
    expect(sanitizeMonitorText("ok\u001b[31mred\u0000x")).toBe("ok red x");
    const decoder = new MonitorDecoder();
    const source = Buffer.from("雪".repeat(800_000));
    const fragments: MonitorFragment[] = [];
    for (let offset = 0; offset < source.length; offset += 7_919) {
      fragments.push(...decoder.write(source.subarray(offset, offset + 7_919)));
      const retained = (decoder as unknown as { bufferedBytes: number }).bufferedBytes;
      expect(retained).toBeLessThanOrEqual(MONITOR_FRAGMENT_BYTES);
    }
    fragments.push(...decoder.end());
    expect(fragments.length).toBeGreaterThan(100);
    expect(new Set(fragments.map((item) => item.sequence))).toEqual(new Set([1]));
    expect(fragments.every((item) => item.bytes <= MONITOR_FRAGMENT_BYTES)).toBe(true);
    expect(fragments.map((item) => item.text).join("")).toBe("雪".repeat(800_000));
  });

  it("batches at 200ms or 32 source lines independently from pending coalescing", () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const pipeline = new MonitorPipeline(ready);
    pipeline.write(Buffer.from("one\n"));
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ready).toHaveBeenCalledOnce();
    for (let index = 0; index < 32; index += 1) pipeline.write(Buffer.from(`${index}\n`));
    expect(ready).toHaveBeenCalledTimes(2);
    const window = pipeline.drain();
    expect(window.firstSequence).toBe(1);
    expect(window.lastSequence).toBe(33);
    expect(window.fragments).toHaveLength(33);
    expect(window.captureBatches).toBe(2);
    expect(
      formatMonitorEvent({
        ...window,
        jobId: "mon_1",
        description: "events",
        outputPath: "/tmp/output.log",
        delivery: 1,
        lines: window.fragments.map((fragment) => fragment.text),
        captureOnly: false,
      }),
    ).toContain("coalesced capture batches: 2");
    pipeline.dispose();
  });

  it("drain neither flushes nor notifies a partial capture", () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const pipeline = new MonitorPipeline(ready);
    pipeline.write(Buffer.from("queued\n"));
    vi.advanceTimersByTime(200);
    pipeline.write(Buffer.from("partial\n"));
    ready.mockClear();
    const first = pipeline.drain();
    expect(first.fragments.map((fragment) => fragment.text)).toEqual(["queued"]);
    expect(ready).not.toHaveBeenCalled();
    expect(pipeline.drain().fragments).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(ready).toHaveBeenCalledOnce();
    expect(pipeline.drain().fragments.map((fragment) => fragment.text)).toEqual(["partial"]);
  });

  it("bounds newest pending fragments and reports dropped bytes, lines, and sequences", () => {
    const coalescer = new MonitorCoalescer();
    const fragments: MonitorFragment[] = Array.from({ length: 2_100 }, (_, index) => ({
      sequence: index + 1,
      part: 1,
      split: false,
      text: `line-${index}`,
      bytes: Buffer.byteLength(`line-${index}`),
    }));
    coalescer.append(fragments);
    const window = coalescer.drain();
    expect(window.fragments).toHaveLength(1_990);
    expect(window.firstSequence).toBe(111);
    expect(window.lastSequence).toBe(2_100);
    expect(window.droppedLines).toBe(110);
    expect(window.droppedBytes).toBeGreaterThan(0);
    expect(window.missingFirstSequence).toBe(1);
    expect(window.missingLastSequence).toBe(110);
  });

  it("counts inter-fragment newlines in the final live event byte bound", () => {
    const fragmentCount = 1_990;
    const baseBytes = Math.floor(MONITOR_PENDING_BYTES / fragmentCount);
    const longerFragments = MONITOR_PENDING_BYTES - baseBytes * fragmentCount;
    const coalescer = new MonitorCoalescer();
    const fragments: MonitorFragment[] = Array.from({ length: fragmentCount }, (_, index) => {
      const text = "x".repeat(baseBytes + (index < longerFragments ? 1 : 0));
      return {
        sequence: index + 1,
        part: 1,
        split: false,
        text,
        bytes: Buffer.byteLength(text),
      };
    });
    expect(fragments.reduce((total, fragment) => total + fragment.bytes, 0)).toBe(
      MONITOR_PENDING_BYTES,
    );

    coalescer.append(fragments);
    const window = coalescer.drain();
    const description = "界".repeat(Math.floor(2_048 / 3));
    const deliveryError = boundedMonitorDeliveryError("界".repeat(1_000));
    const outputPath = `/${"x".repeat(ARTIFACT_JOB_PATH_MAX_BYTES - 1)}`;
    const message = formatMonitorEvent({
      ...window,
      jobId: MAX_GENERATED_JOB_ID,
      description,
      outputPath,
      delivery: 30,
      lines: window.fragments.map(formatMonitorFragment),
      captureOnly: true,
      deliveryError,
    });

    expect(window).toMatchObject({
      firstSequence: 81,
      lastSequence: 1_990,
      droppedLines: 80,
      droppedBytes: 1_920,
      missingFirstSequence: 1,
      missingLastSequence: 80,
    });
    expect(window.fragments).toHaveLength(1_910);
    expect(Buffer.byteLength(description)).toBe(2_046);
    expect(Buffer.byteLength(deliveryError)).toBe(510);
    expect(Buffer.byteLength(outputPath)).toBe(ARTIFACT_JOB_PATH_MAX_BYTES);
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(50 * 1_024);
    expect(message.split("\n").length).toBeLessThanOrEqual(2_000);
  });

  it("bounds the fully formatted message with worst-case UTF-8 metadata and split prefixes", () => {
    const coalescer = new MonitorCoalescer();
    coalescer.append(
      Array.from({ length: 2_500 }, (_, index) => ({
        sequence: Number.MAX_SAFE_INTEGER - 2_500 + index,
        part: Number.MAX_SAFE_INTEGER,
        split: true,
        text: "界".repeat(20),
        bytes: 60,
      })),
    );
    const window = coalescer.drain();
    const message = formatMonitorEvent({
      ...window,
      jobId: MAX_GENERATED_JOB_ID,
      description: "界".repeat(500),
      outputPath: `/${"界".repeat(Math.floor((ARTIFACT_JOB_PATH_MAX_BYTES - 1) / 3))}`,
      delivery: Number.MAX_SAFE_INTEGER,
      lines: window.fragments.map(formatMonitorFragment),
      captureOnly: true,
      deliveryError: "界".repeat(10_000),
      droppedLines: Number.MAX_SAFE_INTEGER,
      droppedBytes: Number.MAX_SAFE_INTEGER,
      splitLines: Number.MAX_SAFE_INTEGER,
      captureBatches: Number.MAX_SAFE_INTEGER,
      missingFirstSequence: 1,
      missingLastSequence: Number.MAX_SAFE_INTEGER,
    });

    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(50 * 1024);
    expect(message.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(message).toContain("dropped: 9007199254740991 lines");
    expect(message).toContain("previous delivery error:");
    expect(message).toContain("[source ");
  });

  it("evicts complete split source sequences without overlapping present ranges", () => {
    const coalescer = new MonitorCoalescer();
    const huge = Array.from({ length: 4 }, (_, index) => ({
      sequence: 1,
      part: index + 1,
      split: true,
      text: "x".repeat(14_000),
      bytes: 14_000,
    }));
    coalescer.append([...huge, { sequence: 2, part: 1, split: false, text: "normal", bytes: 6 }]);
    const window = coalescer.drain();
    expect(window.fragments.map((fragment) => fragment.sequence)).toEqual([2]);
    expect(window.droppedLines).toBe(1);
    expect(window.droppedBytes).toBe(56_000);
    expect([window.missingFirstSequence, window.missingLastSequence]).toEqual([1, 1]);
    expect([window.firstSequence, window.lastSequence]).toEqual([2, 2]);
    expect(coalescer.metrics()).toMatchObject({
      droppedLines: 1,
      droppedBytes: 56_000,
      splitLines: 1,
    });
  });
});

class MemoryArtifacts {
  readonly runtimeId = "monitor-memory";
  readonly raw: Buffer[] = [];
  initialize = vi.fn(async () => undefined);
  cleanup = vi.fn(async () => undefined);
  markClosed = vi.fn(async () => undefined);
  checkpoint = vi.fn(async (_value: JobMetadata) => undefined);
  async createJob(jobId: string): Promise<JobArtifacts> {
    return {
      directory: `/tmp/${jobId}`,
      outputPath: `/tmp/${jobId}/output.log`,
      metadataPath: `/tmp/${jobId}/job.json`,
      append: (chunk: Buffer) => {
        this.raw.push(Buffer.from(chunk));
      },
      checkpoint: async (value: JobMetadata) => this.checkpoint(value),
      close: async () => undefined,
    } as unknown as JobArtifacts;
  }
}

async function terminal(runtime: ProcessRuntime, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = runtime.get(id)!;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("monitor did not terminate");
}

describe("monitor runtime delivery", () => {
  it("keeps raw bytes exact and folds the final partial line into completion", async () => {
    const artifacts = new MemoryArtifacts();
    const raw = Buffer.from([0x61, 0x0d, 0x0a, 0xe9, 0x9b, 0xaa, 0x00, 0x62]);
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        onData(raw.subarray(0, 4));
        onData(raw.subarray(4));
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: artifacts as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "emit",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    const done = await terminal(runtime, job.id);
    expect(Buffer.concat(artifacts.raw)).toEqual(raw);
    expect(done.terminalTail?.content).toContain("a");
    expect(done.terminalTail?.content).toContain("雪 b");
    expect(runtime.flushMonitorDeliveries(vi.fn())).toBe(0);
    await runtime.shutdown();
  });

  it("settles queued delivery before draining pending while leaving partial capture alone", async () => {
    vi.useFakeTimers();
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: new MemoryArtifacts() as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "stream",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    const events: MonitorEvent[] = [];
    emit(Buffer.from("queued\n"));
    vi.advanceTimersByTime(200);
    expect(runtime.flushMonitorDeliveries((event) => events.push(event))).toBe(1);
    emit(Buffer.from("pending\n"));
    vi.advanceTimersByTime(200);
    emit(Buffer.from("partial"));
    runtime.settleMonitorDeliveries();
    vi.advanceTimersByTime(800);
    expect(runtime.flushMonitorDeliveries((event) => events.push(event))).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[1]!.lines).toEqual(["pending"]);
    expect(events[1]!.lines).not.toEqual([]);
    stop();
    await vi.runAllTimersAsync();
    await terminal(runtime, job.id);
    await runtime.shutdown();
  });

  it("allows one queued event, waits one second, and makes delivery 30 capture-only", async () => {
    vi.useFakeTimers();
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: new MemoryArtifacts() as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "stream",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    const events: MonitorEvent[] = [];
    for (let delivery = 1; delivery < 30; delivery += 1) {
      emit(Buffer.from(`line-${delivery}\n`));
      vi.advanceTimersByTime(200);
      expect(
        runtime.flushMonitorDeliveries((event) => {
          events.push(event);
          if (delivery === 29) throw new Error("prior delivery failed");
        }),
      ).toBe(1);
      expect(runtime.flushMonitorDeliveries((event) => events.push(event))).toBe(0);
      runtime.settleMonitorDeliveries();
      vi.advanceTimersByTime(1_000);
    }
    emit(Buffer.from(`${"x\n".repeat(2_100)}${"z".repeat(20_000)}\n`));
    vi.advanceTimersByTime(200);
    expect(runtime.flushMonitorDeliveries((event) => events.push(event))).toBe(1);
    runtime.settleMonitorDeliveries();
    vi.advanceTimersByTime(1_000);

    emit(Buffer.from("capture-after-limit\n"));
    vi.advanceTimersByTime(1_200);
    runtime.settleMonitorDeliveries();
    expect(runtime.flushMonitorDeliveries((event) => events.push(event))).toBe(0);
    expect(events).toHaveLength(30);
    const thirtieth = events.at(-1)!;
    expect(thirtieth.captureOnly).toBe(true);
    expect(thirtieth.lines).toHaveLength(1_990);
    expect(thirtieth).toMatchObject({
      droppedLines: 112,
      droppedBytes: 112,
      missingFirstSequence: 30,
      missingLastSequence: 141,
      firstSequence: 142,
      lastSequence: 2_130,
      splitLines: 1,
      deliveryError: "prior delivery failed",
    });
    expect(thirtieth.lines.at(-2)).toMatch(/^\[source 2130 part 1\] z+$/);
    expect(thirtieth.lines.at(-1)).toMatch(/^\[source 2130 part 2\] z+$/);
    expect(formatMonitorEvent(thirtieth).split("\n")).toHaveLength(2_000);
    expect(runtime.get(job.id)?.monitor).toMatchObject({
      deliveries: 30,
      deliveredLines: 2_018,
      droppedLines: 112,
      droppedBytes: 112,
      splitLines: 1,
      captureOnly: true,
      throttled: true,
    });
    stop();
    await vi.runAllTimersAsync();
    const done = await terminal(runtime, job.id);
    expect(done.terminalTail?.content).toContain("capture-after-limit");
    expect(done.monitor).toMatchObject({ deliveries: 30, captureOnly: true, throttled: true });
    await runtime.shutdown();
  });

  it("persists cumulative drop and split totals in running and terminal metadata", async () => {
    vi.useFakeTimers();
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    const artifacts = new MemoryArtifacts();
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: artifacts as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "stream",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    emit(Buffer.from(`${"x".repeat(100_000)}\nnormal\n`));
    vi.advanceTimersByTime(200);
    expect(runtime.get(job.id)?.monitor).toMatchObject({
      droppedLines: 1,
      droppedBytes: 100_000,
      splitLines: 1,
    });
    await vi.runAllTimersAsync();
    expect(artifacts.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor: expect.objectContaining({ droppedLines: 1, splitLines: 1 }),
      }),
    );
    stop();
    await vi.runAllTimersAsync();
    const done = await terminal(runtime, job.id);
    expect(done.monitor).toMatchObject({ droppedLines: 1, droppedBytes: 100_000, splitLines: 1 });
    expect(artifacts.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        monitor: expect.objectContaining({ droppedLines: 1, splitLines: 1 }),
      }),
    );
    await runtime.shutdown();
  });

  it("marks completion when all nonempty output was already delivered live", async () => {
    vi.useFakeTimers();
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: new MemoryArtifacts() as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "stream",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    emit(Buffer.from("live-only\n"));
    vi.advanceTimersByTime(200);
    expect(runtime.flushMonitorDeliveries(vi.fn())).toBe(1);
    stop();
    await vi.runAllTimersAsync();
    const done = await terminal(runtime, job.id);
    expect(done.outputBytes).toBeGreaterThan(0);
    expect(done.terminalTail?.content).toBe("");
    expect(done.monitor?.completionOutput).toBe("all_delivered_live");
    await runtime.shutdown();
  });

  it("contains threshold and timer callback sends that throw", async () => {
    vi.useFakeTimers();
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    let runtime!: ProcessRuntime;
    const send = vi.fn(() => {
      throw new Error("live send failed");
    });
    runtime = new ProcessRuntime("test", {
      operations,
      artifacts: new MemoryArtifacts() as unknown as ArtifactStore,
      onMonitorEvent: () => runtime.flushMonitorDeliveries(send),
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "stream",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    expect(() =>
      emit(Buffer.from(Array.from({ length: 32 }, () => "line").join("\n") + "\n")),
    ).not.toThrow();
    runtime.settleMonitorDeliveries();
    vi.advanceTimersByTime(1_000);
    emit(Buffer.from("timer\n"));
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
    expect(runtime.get(job.id)?.monitor?.deliveryError).toBe("live send failed");
    stop();
    await vi.runAllTimersAsync();
    await terminal(runtime, job.id);
    await runtime.shutdown();
  });

  it("contains a throwing monitor send as one persisted at-most-once attempt", async () => {
    vi.useFakeTimers();
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    const artifacts = new MemoryArtifacts();
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: artifacts as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "stream",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    emit(Buffer.from("event\n"));
    vi.advanceTimersByTime(200);
    const send = vi.fn(() => {
      throw new Error("monitor queue unavailable");
    });
    expect(() => runtime.flushMonitorDeliveries(send)).not.toThrow();
    expect(runtime.flushMonitorDeliveries(send)).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(runtime.get(job.id)?.monitor).toMatchObject({
      deliveries: 1,
      deliveryError: "monitor queue unavailable",
    });
    await vi.runAllTimersAsync();
    expect(artifacts.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor: expect.objectContaining({ deliveryError: "monitor queue unavailable" }),
      }),
    );
    stop();
    await vi.runAllTimersAsync();
    const done = await terminal(runtime, job.id);
    expect(done.monitor?.completionOutput).toBe("remaining");
    const completion = serializeJobs([done], { includeTails: true }).jobs[0];
    expect(completion?.tail).toContain("captured; inspect the artifact");
    expect(completion?.outputPath).toBe(`/tmp/${job.id}/output.log`);
    await runtime.shutdown();
  });

  it("bounds noisy capture-only checkpoint backlog to one in-flight and one latest state", async () => {
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    let releaseCheckpoint!: () => void;
    let checkpointStarted!: () => void;
    const checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const started = new Promise<void>((resolve) => {
      checkpointStarted = resolve;
    });
    const artifacts = new MemoryArtifacts();
    let blockMonitorCheckpoints = false;
    let checkpointCalls = 0;
    let concurrentCheckpoints = 0;
    let maximumConcurrentCheckpoints = 0;
    const originalCreate = artifacts.createJob.bind(artifacts);
    artifacts.createJob = vi.fn(async (jobId: string) => {
      const jobArtifacts = await originalCreate(jobId);
      const checkpoint = jobArtifacts.checkpoint.bind(jobArtifacts);
      jobArtifacts.checkpoint = async (value: JobMetadata) => {
        if (blockMonitorCheckpoints && value.status === "running") {
          checkpointCalls += 1;
          concurrentCheckpoints += 1;
          maximumConcurrentCheckpoints = Math.max(
            maximumConcurrentCheckpoints,
            concurrentCheckpoints,
          );
          if (checkpointCalls === 1) {
            checkpointStarted();
            await checkpointGate;
          }
          concurrentCheckpoints -= 1;
        }
        await checkpoint(value);
      };
      return jobArtifacts;
    });
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: artifacts as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "noisy",
      description: "events",
      cwd: "/tmp",
    });
    runtime.markLaunchTransferred(job.id);
    const active = (
      runtime as unknown as {
        active: Map<string, { monitor?: { captureOnly: boolean } }>;
      }
    ).active.get(job.id)!;
    active.monitor!.captureOnly = true;
    blockMonitorCheckpoints = true;

    emit(
      Buffer.from(Array.from({ length: 3_200 }, (_, index) => `line-${index}`).join("\n") + "\n"),
    );
    await started;
    const persistence = (
      runtime as unknown as {
        monitorPersistence: Map<
          string,
          { dirty: boolean; inFlight?: Promise<void>; failed: boolean }
        >;
      }
    ).monitorPersistence.get(job.id);
    expect(persistence).toMatchObject({ dirty: true, failed: false });
    expect(persistence?.inFlight).toBeInstanceOf(Promise);
    expect(checkpointCalls).toBe(1);
    expect(maximumConcurrentCheckpoints).toBe(1);

    releaseCheckpoint();
    for (let attempt = 0; attempt < 20 && checkpointCalls < 2; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(checkpointCalls).toBe(2);
    expect(maximumConcurrentCheckpoints).toBe(1);

    stop();
    await terminal(runtime, job.id);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it("retries monitor checkpoint rejection, exposes permanent failure, and blocks verification", async () => {
    let emit!: (chunk: Buffer) => void;
    let stop!: () => void;
    const artifacts = new MemoryArtifacts();
    let rejectMonitorCheckpoints = false;
    let rejected = 0;
    const originalCreate = artifacts.createJob.bind(artifacts);
    artifacts.createJob = vi.fn(async (jobId: string) => {
      const jobArtifacts = await originalCreate(jobId);
      const checkpoint = jobArtifacts.checkpoint.bind(jobArtifacts);
      jobArtifacts.checkpoint = async (value: JobMetadata) => {
        if (rejectMonitorCheckpoints && value.status === "running" && rejected < 2) {
          rejected += 1;
          throw new Error("monitor metadata unavailable");
        }
        await checkpoint(value);
      };
      return jobArtifacts;
    });
    const operations: BashOperations = {
      exec: vi.fn(async (_command, _cwd, { onData }) => {
        emit = onData;
        await new Promise<void>((resolve) => {
          stop = resolve;
        });
        return { exitCode: 0 };
      }),
    };
    const runtime = new ProcessRuntime("test", {
      operations,
      artifacts: artifacts as unknown as ArtifactStore,
    });
    const job = await runtime.launch({
      kind: "background_event_stream",
      command: "stream",
      description: "events",
      cwd: "/tmp",
    });
    rejectMonitorCheckpoints = true;
    emit(Buffer.from(Array.from({ length: 32 }, () => "line").join("\n") + "\n"));
    for (let attempt = 0; attempt < 20 && rejected < 2; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));

    expect(rejected).toBe(2);
    expect(runtime.get(job.id)).toMatchObject({
      status: "running",
      monitorDeliveryPersistenceError: expect.stringContaining("after retry"),
    });
    stop();
    const done = await terminal(runtime, job.id);
    expect(done).toMatchObject({
      status: "completed",
      monitorDeliveryPersistenceError: expect.stringContaining("after retry"),
    });
    expect(serializeJobs([done]).jobs[0]?.monitorDeliveryPersistenceError).toContain("after retry");
    expect(artifacts.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        monitorDeliveryPersistenceError: expect.stringContaining("after retry"),
      }),
    );
    await expect(runtime.shutdown()).rejects.toThrow("could not be verified");
    expect(runtime.get(job.id)?.status).toBe("completed");
    expect(artifacts.markClosed).not.toHaveBeenCalled();
  });
});
