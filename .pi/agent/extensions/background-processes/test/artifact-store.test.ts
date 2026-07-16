import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/runtime/artifact-store.ts";
import { MAX_GENERATED_JOB_ID } from "../src/runtime/job-store.ts";
import { ARTIFACT_JOB_PATH_MAX_BYTES } from "../src/runtime/results.ts";
import type { JobMetadata } from "../src/runtime/types.ts";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-background-artifacts-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function metadata(overrides: Partial<JobMetadata> = {}): JobMetadata {
  return {
    id: "bg_1",
    runtimeId: "runtime",
    kind: "background_run",
    command: "printf secret",
    cwd: "/tmp",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    outputBytes: 0,
    deliveryState: "pending",
    verification: {
      processSettled: false,
      outputLogClosed: false,
      terminalMetadataPersisted: false,
    },
    ...overrides,
  };
}

async function createForeignRuntime(
  root: string,
  runtimeId: string,
  ownerPid: number,
  completedAt: string,
  bytes = 1,
  closedAt?: string,
): Promise<string> {
  const runtime = join(root, "foreign-session", runtimeId);
  const job = join(runtime, "bg_1");
  await mkdir(job, { recursive: true });
  await writeFile(
    join(runtime, "owner.json"),
    JSON.stringify({ pid: ownerPid, runtimeId, startedAt: completedAt, closedAt }),
  );
  await writeFile(
    join(job, "job.json"),
    JSON.stringify(metadata({ runtimeId, status: "completed", completedAt })),
  );
  await writeFile(join(job, "output.log"), Buffer.alloc(bytes));
  return runtime;
}

async function createCurrentJob(
  store: ArtifactStore,
  id: string,
  completedAt: string,
  deliveryState: JobMetadata["deliveryState"],
  bytes: number,
): Promise<string> {
  const artifacts = await store.createJob(id);
  artifacts.append(Buffer.alloc(bytes));
  await artifacts.checkpoint(
    metadata({
      id,
      runtimeId: store.runtimeId,
      status: "completed",
      completedAt,
      outputBytes: bytes,
      outputPath: artifacts.outputPath,
      metadataPath: artifacts.metadataPath,
      deliveryState,
      verification: {
        processSettled: true,
        outputLogClosed: true,
        terminalMetadataPersisted: true,
      },
    }),
  );
  await artifacts.close();
  return artifacts.directory;
}

async function createEmptyRuntime(
  root: string,
  runtimeId: string,
  ownerPid: number,
  startedAt: string,
): Promise<string> {
  const runtime = join(root, "foreign-session", runtimeId);
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(runtime, "owner.json"),
    JSON.stringify({ pid: ownerPid, runtimeId, startedAt }),
  );
  return runtime;
}

describe("ArtifactStore", () => {
  it("creates restrictive artifacts and atomically replaces environment-free metadata", async () => {
    const root = await temporaryRoot();
    const store = new ArtifactStore("session/unsafe", {
      root,
      runtimeId: "runtime",
      pid: 123,
    });
    await store.initialize();
    const job = await store.createJob("bg_1");
    await job.append(Buffer.from([0, 1, 2, 255]));
    await job.checkpoint(metadata({ outputBytes: 4 }));
    await job.checkpoint(metadata({ outputBytes: 5, status: "completed" }));
    await job.close();

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(store.runtimeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(job.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(job.outputPath)).mode & 0o777).toBe(0o600);
    expect((await stat(job.metadataPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(store.runtimeDirectory, "owner.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(job.outputPath)).toEqual(Buffer.from([0, 1, 2, 255]));
    const persisted = JSON.parse(await readFile(job.metadataPath, "utf8"));
    expect(persisted.outputBytes).toBe(5);
    expect(persisted.env).toBeUndefined();
    expect((await import("node:fs/promises")).readdir(job.directory)).resolves.toEqual([
      "job.json",
      "output.log",
    ]);
  });

  it("supports the deepest completion-safe generated job path", async () => {
    const parent = await temporaryRoot();
    const fixedSuffix = `/deep/runtime/${MAX_GENERATED_JOB_ID}/output.log`;
    const root = join(
      parent,
      " ".repeat(
        ARTIFACT_JOB_PATH_MAX_BYTES -
          Buffer.byteLength(parent) -
          Buffer.byteLength(fixedSuffix) -
          1,
      ),
    );
    const store = new ArtifactStore("deep", { root, runtimeId: "runtime" });

    await store.initialize();
    const job = await store.createJob(MAX_GENERATED_JOB_ID);

    expect(Buffer.byteLength(job.outputPath)).toBe(ARTIFACT_JOB_PATH_MAX_BYTES);
    expect(job.outputPath).toContain("  ");
    await job.close();
  });

  it("rejects an over-limit root before allocating runtime or job artifacts", async () => {
    const parent = await temporaryRoot();
    const fixedSuffix = `/deep/runtime/${MAX_GENERATED_JOB_ID}/output.log`;
    const root = join(
      parent,
      "x".repeat(
        ARTIFACT_JOB_PATH_MAX_BYTES - Buffer.byteLength(parent) - Buffer.byteLength(fixedSuffix),
      ),
    );
    const store = new ArtifactStore("deep", { root, runtimeId: "runtime" });

    await expect(store.initialize()).rejects.toThrow(
      `supported maximum is ${ARTIFACT_JOB_PATH_MAX_BYTES} bytes`,
    );
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes stress output synchronously without queued buffers", async () => {
    const root = await temporaryRoot();
    const store = new ArtifactStore("stress", { root, runtimeId: "runtime" });
    await store.initialize();
    const job = await store.createJob("bg_stress");
    const chunks = Array.from({ length: 10_000 }, (_, index) =>
      Buffer.from(`${index.toString().padStart(5, "0")}\n`),
    );
    for (const chunk of chunks) {
      expect(job.append(chunk)).toBeUndefined();
      expect(job.queuedOutputBuffers).toBe(0);
    }
    await job.close();
    expect(await readFile(job.outputPath)).toEqual(Buffer.concat(chunks));
  });

  it("atomically marks a verified runtime closed", async () => {
    const root = await temporaryRoot();
    const now = new Date("2026-01-03T00:00:00.000Z");
    const store = new ArtifactStore("closed", {
      root,
      runtimeId: "runtime",
      now: () => now,
    });
    await store.initialize();
    await store.markClosed();
    const owner = JSON.parse(await readFile(join(store.runtimeDirectory, "owner.json"), "utf8"));
    expect(owner.closedAt).toBe(now.toISOString());
  });

  it("isolates concurrent same-session runtimes and cleans only the closed owner", async () => {
    const root = await temporaryRoot();
    const now = () => new Date("2026-01-03T00:00:00.000Z");
    const first = new ArtifactStore("shared-session", {
      root,
      runtimeId: "runtime-first",
      pid: 101,
      now,
      isProcessAlive: (pid) => pid === 101 || pid === 202,
      maxAgeMs: 0,
      maxBytes: 0,
    });
    const second = new ArtifactStore("shared-session", {
      root,
      runtimeId: "runtime-second",
      pid: 202,
      now,
      isProcessAlive: (pid) => pid === 101 || pid === 202,
      maxAgeMs: 0,
      maxBytes: 0,
    });
    await Promise.all([first.initialize(), second.initialize()]);
    const [firstJob, secondJob] = await Promise.all([
      first.createJob("bg_first"),
      second.createJob("bg_second"),
    ]);
    await Promise.all([
      firstJob.checkpoint(
        metadata({
          id: "bg_first",
          runtimeId: first.runtimeId,
          metadataPath: firstJob.metadataPath,
        }),
      ),
      secondJob.checkpoint(
        metadata({
          id: "bg_second",
          runtimeId: second.runtimeId,
          metadataPath: secondJob.metadataPath,
        }),
      ),
    ]);

    await Promise.all([first.cleanup(), second.cleanup()]);
    expect(JSON.parse(await readFile(firstJob.metadataPath, "utf8"))).toMatchObject({
      status: "running",
      runtimeId: "runtime-first",
    });
    expect(JSON.parse(await readFile(secondJob.metadataPath, "utf8"))).toMatchObject({
      status: "running",
      runtimeId: "runtime-second",
    });

    const completedAt = now().toISOString();
    await firstJob.checkpoint(
      metadata({
        id: "bg_first",
        runtimeId: first.runtimeId,
        metadataPath: firstJob.metadataPath,
        status: "completed",
        completedAt,
      }),
    );
    await firstJob.close();
    await first.markClosed();
    const cleaner = new ArtifactStore("shared-session", {
      root,
      runtimeId: "runtime-cleaner",
      pid: 303,
      now,
      isProcessAlive: (pid) => pid === 202 || pid === 303,
      maxAgeMs: 0,
      maxBytes: 0,
    });
    await cleaner.initialize();
    await cleaner.cleanup();

    await expect(stat(first.runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(second.runtimeDirectory)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(secondJob.metadataPath, "utf8"))).toMatchObject({
      status: "running",
      runtimeId: "runtime-second",
    });
    await secondJob.close();
  });

  it("prunes oldest settled current-runtime jobs while retaining protected and foreign active artifacts", async () => {
    const root = await temporaryRoot();
    const now = new Date("2026-01-10T00:00:00.000Z");
    const store = new ArtifactStore("current", {
      root,
      runtimeId: "current-runtime",
      pid: 1,
      now: () => now,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxBytes: 20_000,
      isProcessAlive: (pid) => pid === 999,
    });
    await store.initialize();
    const eligible = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createCurrentJob(
          store,
          `bg_${index + 1}`,
          new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          "consumed",
          2_048,
        ),
      ),
    );
    const pending = await createCurrentJob(
      store,
      "bg_pending",
      "2026-01-01T12:00:00.000Z",
      "pending",
      2_048,
    );
    const sending = await createCurrentJob(
      store,
      "bg_sending",
      "2026-01-01T13:00:00.000Z",
      "sending",
      1,
    );
    const managed = await createCurrentJob(
      store,
      "bg_managed",
      "2026-01-01T14:00:00.000Z",
      "sent",
      1,
    );
    const persisting = await createCurrentJob(
      store,
      "bg_persisting",
      "2026-01-01T15:00:00.000Z",
      "failed",
      1,
    );
    const activeArtifacts = await store.createJob("bg_active");
    await activeArtifacts.checkpoint(
      metadata({
        id: "bg_active",
        runtimeId: store.runtimeId,
        outputPath: activeArtifacts.outputPath,
        metadataPath: activeArtifacts.metadataPath,
      }),
    );
    await activeArtifacts.close();
    const activeForeign = await createForeignRuntime(
      root,
      "active-foreign",
      999,
      "2025-01-01T00:00:00.000Z",
      2_048,
    );

    await store.cleanup({
      isCurrentJobProtected: (id) => id === "bg_managed" || id === "bg_persisting",
    });

    await expect(stat(eligible[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(eligible.at(-1)!)).resolves.toBeDefined();
    await expect(stat(pending)).resolves.toBeDefined();
    await expect(stat(sending)).resolves.toBeDefined();
    await expect(stat(managed)).resolves.toBeDefined();
    await expect(stat(persisting)).resolves.toBeDefined();
    await expect(stat(activeArtifacts.directory)).resolves.toBeDefined();
    await expect(stat(activeForeign)).resolves.toBeDefined();
    await expect(stat(store.runtimeDirectory)).resolves.toBeDefined();
  });

  it("applies age retention to settled jobs inside the still-open current runtime", async () => {
    const root = await temporaryRoot();
    const store = new ArtifactStore("current", {
      root,
      runtimeId: "current-runtime",
      now: () => new Date("2026-01-10T00:00:00.000Z"),
      maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxBytes: Number.POSITIVE_INFINITY,
    });
    await store.initialize();
    const expired = await createCurrentJob(
      store,
      "bg_expired",
      "2026-01-02T00:00:00.000Z",
      "failed",
      1,
    );
    const retained = await createCurrentJob(
      store,
      "bg_retained",
      "2026-01-04T00:00:00.000Z",
      "sent",
      1,
    );

    await store.cleanup({ isCurrentJobProtected: () => false });

    await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(retained)).resolves.toBeDefined();
  });

  it("prunes only completed inactive runtimes by age and quota", async () => {
    const root = await temporaryRoot();
    const old = await createForeignRuntime(root, "old", 101, "2025-01-01T00:00:00.000Z", 20);
    const quotaOldest = await createForeignRuntime(
      root,
      "quota-oldest",
      102,
      "2026-01-01T00:00:00.000Z",
      200,
    );
    const active = await createForeignRuntime(root, "active", 999, "2025-01-01T00:00:00.000Z", 200);
    const incomplete = await createForeignRuntime(
      root,
      "incomplete",
      103,
      "2025-01-01T00:00:00.000Z",
      200,
    );
    const incompleteMetadata = metadata({ runtimeId: "incomplete", status: "running" });
    await writeFile(join(incomplete, "bg_1", "job.json"), JSON.stringify(incompleteMetadata));
    const samePidClosed = await createForeignRuntime(
      root,
      "same-pid-closed",
      999,
      "2025-01-01T00:00:00.000Z",
      20,
      "2025-01-02T00:00:00.000Z",
    );
    const deadEmpty = await createEmptyRuntime(root, "dead-empty", 104, "2025-01-01T00:00:00.000Z");
    const closedRunning = await createForeignRuntime(
      root,
      "closed-running",
      999,
      "2025-01-01T00:00:00.000Z",
      20,
      "2025-01-02T00:00:00.000Z",
    );
    await writeFile(
      join(closedRunning, "bg_1", "job.json"),
      JSON.stringify(metadata({ runtimeId: "closed-running", status: "running" })),
    );

    const store = new ArtifactStore("current", {
      root,
      runtimeId: "current-runtime",
      pid: 1,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
      maxAgeMs: 24 * 60 * 60 * 1_000,
      maxBytes: 650,
      isProcessAlive: (pid) => pid === 999,
    });
    await store.initialize();
    await store.cleanup();

    await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(quotaOldest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(samePidClosed)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(deadEmpty)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(active)).resolves.toBeDefined();
    await expect(stat(incomplete)).resolves.toBeDefined();
    await expect(stat(closedRunning)).resolves.toBeDefined();
    await expect(stat(store.runtimeDirectory)).resolves.toBeDefined();
  });
});
