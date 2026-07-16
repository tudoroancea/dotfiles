import { describe, expect, it, vi } from "vitest";
import type { ProcessRuntime } from "../src/runtime/process-runtime.ts";
import type { JobRecord } from "../src/runtime/types.ts";
import {
  compactTaskSummary,
  formatDuration,
  jobDuration,
  showBackgroundTasks,
} from "../src/ui/dashboard.ts";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "bg_1",
    generation: 1,
    kind: "background_bash",
    command: "sleep 10",
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

function runtime(jobs: JobRecord[]): ProcessRuntime {
  return {
    list: vi.fn(() => jobs),
    resolve: vi.fn((ids: string[]) =>
      ids.map((id) => {
        const match = jobs.find((candidate) => candidate.id === id);
        if (!match) throw new Error(`Unknown background job: ${id}`);
        return match;
      }),
    ),
  } as unknown as ProcessRuntime;
}

describe("background task dashboard formatting", () => {
  it("formats short and long runtimes compactly", () => {
    expect(formatDuration(59_900)).toBe("59s");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(3_661_000)).toBe("1h 1m");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
    expect(jobDuration(job(), Date.parse("2026-01-01T00:01:05.000Z"))).toBe("1m 5s");
  });

  it("provides a concise RPC fallback rather than serialized job JSON", async () => {
    const current = runtime([
      job({ description: "benchmark" }),
      job({
        id: "bg_2",
        status: "completed",
        completedAt: "2026-01-01T00:00:03.000Z",
      }),
    ]);
    const notify = vi.fn();
    const ctx = { mode: "rpc", ui: { notify } };

    await showBackgroundTasks(ctx as never, current);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 running, 2 recent"), "info");
    expect(notify.mock.calls[0]![0]).not.toContain('{"jobs"');
    expect(compactTaskSummary(current)).toContain("bg_1 running");
  });

  it("keeps the newest multiline output in the recent-tail view", async () => {
    const current = runtime([job()]);
    const tail = `old-line\n${"x".repeat(21_000)}\nnewest-line`;
    Object.assign(current, { tail: vi.fn(() => ({ content: tail })) });
    const custom = vi.fn().mockResolvedValueOnce("tail").mockResolvedValueOnce("back");
    const editor = vi.fn(async (_title: string, _content: string) => undefined);
    const ctx = {
      mode: "tui",
      ui: { custom, editor, notify: vi.fn(), confirm: vi.fn(), setEditorText: vi.fn() },
    };

    await showBackgroundTasks(ctx as never, current, "bg_1");

    const content = editor.mock.calls[0]![1];
    expect(content).toContain("\n");
    expect(content).toContain("newest-line");
    expect(content).not.toContain("old-line");
  });

  it("honors a requested RPC job and sanitizes unknown IDs", async () => {
    const current = runtime([
      job({ id: "bg_1", description: "first", outputPath: "/tmp/first.log" }),
      job({ id: "bg_2", description: "second", outputPath: "/tmp/second.log" }),
    ]);
    const notify = vi.fn();
    const ctx = { mode: "rpc", ui: { notify } };

    await showBackgroundTasks(ctx as never, current, "bg_2");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("second"), "info");
    expect(notify.mock.calls.at(-1)![0]).toContain("/tmp/second.log");

    await showBackgroundTasks(ctx as never, current, "bad\u001b]0;title\u0007-id");
    const [message, level] = notify.mock.calls.at(-1)!;
    expect(level).toBe("error");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\u0007");
  });
});
