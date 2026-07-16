import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { MAX_GENERATED_JOB_ID } from "../src/runtime/job-store.ts";
import {
  ARTIFACT_JOB_PATH_MAX_BYTES,
  compactSnapshot,
  selectTailLines,
  serializeJobs,
} from "../src/runtime/results.ts";
import type { JobRecord } from "../src/runtime/types.ts";

function record(index: number): JobRecord {
  const content = `${index}: ${"x".repeat(30)}\n`.repeat(3_000);
  return {
    id: `bg_${index}`,
    generation: 1,
    kind: "background_run",
    command: "large command",
    description: "d".repeat(500),
    cwd: "/tmp",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    status: "completed",
    exitCode: 0,
    outputBytes: Buffer.byteLength(content),
    outputPath: `/artifacts/bg_${index}/output.log`,
    metadataPath: `/artifacts/bg_${index}/job.json`,
    deliveryState: "pending",
    terminalTail: {
      content,
      bytes: Buffer.byteLength(content),
      lines: 3_000,
      truncated: true,
    },
    verification: {
      processSettled: true,
      outputLogClosed: true,
      terminalMetadataPersisted: true,
    },
  };
}

describe("aggregate job results", () => {
  it("bounds all jobs together rather than applying a per-job limit", () => {
    const result = serializeJobs(
      Array.from({ length: 50 }, (_, index) => record(index)),
      {
        includeTails: true,
      },
    );
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(result.jobs).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.jobs.every((job) => job.outputPath)).toBe(true);
  });

  it("caps arbitrary status lists and every pathological non-path string field", () => {
    const records = Array.from({ length: 500 }, (_, index) => {
      const suffix = `/bg_${index}/output.log`;
      const outputPath = `/${" ".repeat(ARTIFACT_JOB_PATH_MAX_BYTES - Buffer.byteLength(suffix) - 1)}${suffix}`;
      return {
        ...record(index),
        id: `bg_${index}_${"i".repeat(500)}`,
        cwd: `/${"cwd/".repeat(2_000)}`,
        description: "description\n".repeat(1_000),
        error: "error\n".repeat(1_000),
        deliveryError: "delivery\n".repeat(1_000),
        outputPath,
        metadataPath: outputPath.replace(/output\.log$/, "job.json"),
      };
    });
    const result = serializeJobs(records);

    expect(result.jobs.length).toBeLessThanOrEqual(50);
    expect(result.omittedCount).toBe(500 - result.jobs.length);
    expect(result.omittedJobs).toEqual({
      count: 500 - result.jobs.length,
      firstJobId: expect.stringMatching(new RegExp(`^bg_${result.jobs.length}_`)),
      lastJobId: expect.stringMatching(/^bg_499_/),
      guidance: expect.stringContaining("artifacts"),
    });
    expect(result.text).toContain('"omittedJobs"');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(result.jobs.every((job) => job.jobId && job.outputPath && job.metadataPath)).toBe(true);
  });

  it("preserves exact artifact paths while fitting 50 worst-case compact monitor records", () => {
    const hostile = "maximum\n\r\u0000\u0007\u001b[31m\u009b32m".repeat(100);
    const records = Array.from({ length: 50 }, (_, index) => {
      const job = record(index);
      const suffix = `/bg_${index}/output.log`;
      const outputPath = `/${" ".repeat(ARTIFACT_JOB_PATH_MAX_BYTES - Buffer.byteLength(suffix) - 1)}${suffix}`;
      return {
        ...job,
        id: MAX_GENERATED_JOB_ID,
        kind: "background_event_stream" as const,
        status: "cleanup_failed" as const,
        description: hostile,
        cwd: hostile,
        exitCode: Number.MIN_SAFE_INTEGER,
        error: hostile,
        outputPath,
        metadataPath: outputPath.replace(/output\.log$/, "job.json"),
        deliveryState: "sending" as const,
        deliveryAttemptedAt: hostile,
        deliveryError: hostile,
        deliveryPersistenceError: hostile,
        monitorDeliveryPersistenceError: hostile,
        monitor: {
          deliveries: Number.MAX_SAFE_INTEGER,
          deliveredBytes: Number.MAX_SAFE_INTEGER,
          deliveredLines: Number.MAX_SAFE_INTEGER,
          droppedLines: Number.MAX_SAFE_INTEGER,
          droppedBytes: Number.MAX_SAFE_INTEGER,
          splitLines: Number.MAX_SAFE_INTEGER,
          captureOnly: true,
          throttled: true,
          deliveryError: hostile,
          completionOutput: "remaining" as const,
        },
      };
    });

    const result = serializeJobs(records);

    expect(result.jobs).toHaveLength(50);
    expect(result.omittedCount).toBe(0);
    expect(result.jobs.map((job) => job.outputPath)).toEqual(records.map((job) => job.outputPath));
    expect(result.jobs.map((job) => job.metadataPath)).toEqual(
      records.map((job) => job.metadataPath),
    );
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.text.split("\n")).toHaveLength(1);
  });

  it("does not apply display sanitization to snapshot artifact paths", () => {
    const exact = "/tmp/repeated   whitespace/bg_1/output.log";
    const job = record(1);
    job.outputPath = exact;
    job.metadataPath = exact.replace("output.log", "job.json");

    expect(compactSnapshot(job)).toMatchObject({
      outputPath: exact,
      metadataPath: exact.replace("output.log", "job.json"),
    });
  });

  it.each([
    { limit: 0, expected: "" },
    { limit: 1, expected: "third\n" },
    { limit: 200, expected: "first\nsecond\nthird\n" },
  ])("uses trailing-newline tail semantics at limit $limit", ({ limit, expected }) => {
    expect(selectTailLines("first\nsecond\nthird\n", limit)).toBe(expected);
  });

  it("uses an explicit no-output marker only when a terminal tail was requested", () => {
    const empty = record(1);
    empty.terminalTail = { content: "", bytes: 0, lines: 0, truncated: false };
    expect(serializeJobs([empty], { includeTails: true, tailLines: 1 }).jobs[0]?.tail).toBe(
      "(no output)",
    );
    expect(
      serializeJobs([empty], { includeTails: true, tailLines: 0 }).jobs[0]?.tail,
    ).toBeUndefined();

    const delivered = {
      ...empty,
      kind: "background_event_stream" as const,
      outputBytes: 10,
      monitor: {
        deliveries: 1,
        deliveredBytes: 9,
        deliveredLines: 1,
        droppedLines: 0,
        droppedBytes: 0,
        splitLines: 0,
        captureOnly: false,
        throttled: false,
        completionOutput: "all_delivered_live" as const,
      },
    };
    expect(serializeJobs([delivered], { includeTails: true }).jobs[0]?.tail).toBe(
      "(all monitor output was delivered live)",
    );
  });
});
