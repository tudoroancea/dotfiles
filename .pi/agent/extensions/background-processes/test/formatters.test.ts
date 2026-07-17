import { describe, expect, it } from "vitest";
import type { JobSnapshot } from "../src/runtime/results.ts";
import { formatCommand, formatCwd, formatDuration, formatStatus } from "../src/ui/formatters.ts";
import { formatCompactJobs, formatJobDetails } from "../src/ui/job-formatters.ts";

function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    jobId: "bg_1",
    kind: "background_run",
    status: "completed",
    command: "nub run test",
    cwd: "/home/test/project/api",
    durationMs: 62_000,
    outputBytes: 12,
    outputPath: "/tmp/bg_1/output.log",
    metadataPath: "/tmp/bg_1/job.json",
    deliveryState: "sent",
    ...overrides,
  };
}

describe("background process UI formatters", () => {
  it("shortens home cwd and sanitizes and bounds commands", () => {
    expect(formatCwd("/home/test/project", "/home/test")).toBe("~/project");
    expect(formatCommand("printf '\u001b[31munsafe\u0007'\nnext", { singleLine: true })).toBe(
      "printf ' unsafe ' next",
    );
    expect(formatCommand("x".repeat(20), { maximum: 10 })).toBe("xxxxxxxxx…");
  });

  it("uses shared duration and status vocabulary", () => {
    expect(formatDuration(3_662_000)).toBe("1h 1m");
    expect(formatStatus("running")).toMatchObject({ icon: "◆", tone: "warning" });
    expect(formatStatus("cancelled")).toMatchObject({ icon: "◇", tone: "muted" });
    expect(formatStatus("failed")).toMatchObject({ icon: "✗", tone: "error" });
  });

  it("orders bounded persisted details as cwd, command, status, output, delivery, artifacts", () => {
    const details = formatJobDetails(
      snapshot({
        tail: "test output",
        monitor: {
          deliveries: 2,
          droppedLines: 0,
          droppedBytes: 0,
          splitLines: 0,
          captureOnly: false,
        },
      }),
    );
    const ordered = [
      "/home/test/project/api",
      "$ nub run test",
      "✓ completed · 1m 2s",
      "Output",
      "Delivery",
      "Artifacts",
    ].map((value) => details.indexOf(value));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    expect(details.length).toBeLessThanOrEqual(12_000);
  });

  it("keeps aggregate collapsed rows concise", () => {
    const compact = formatCompactJobs(
      Array.from({ length: 10 }, (_, index) =>
        snapshot({ jobId: `bg_${index}`, command: "x".repeat(500) }),
      ),
    );
    expect(compact).toContain("+7 more");
    expect(compact.length).toBeLessThan(400);
  });
});
