import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRuntime } from "../src/runtime/process-runtime.ts";
import type { JobRecord } from "../src/runtime/types.ts";
import {
  BackgroundDashboard,
  compactTaskSummary,
  formatDuration,
  jobDuration,
  renderJobDetail,
  renderJobList,
  showBackgroundTasks,
} from "../src/ui/dashboard.ts";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "bg_1",
    generation: 1,
    kind: "background_run",
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

function eventBus() {
  return { emit: vi.fn() };
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
    tail: vi.fn(() => undefined),
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

    const events = eventBus();
    await showBackgroundTasks(events, ctx as never, current);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 running, 2 recent"), "info");
    expect(events.emit).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![0]).not.toContain('{"jobs"');
    expect(compactTaskSummary(current)).toContain("bg_1 running");
  });

  it("prioritizes cwd and command before elapsed and omits IDs in narrow rows", () => {
    const lines = renderJobList(
      [job({ cwd: "/work/project", command: "nub run test" })],
      "bg_1",
      50,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    const text = lines.join("\n");
    expect(text.indexOf("/work/project")).toBeLessThan(text.indexOf("nub run test"));
    expect(text.indexOf("nub run test")).toBeLessThan(text.indexOf("0s"));
    expect(text).not.toContain("bg_1");
  });

  it("renders detail hierarchy with a bounded newest output tail", () => {
    const tail = `old-line\n${"x".repeat(21_000)}\nnewest-line`;
    const text = renderJobDetail(job({ terminalTail: { content: tail } as never }), 100).join("\n");
    const markers = [
      "◆ running ·",
      "Working directory",
      "Command",
      "Terminal",
      "Output tail",
      "Delivery health",
      "Artifacts",
    ].map((value) => text.indexOf(value));
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
    expect(text).toContain("newest-line");
    expect(text).not.toContain("old-line");
  });

  it("uses j/k navigation, configured actions, and keeps selection stable by job ID", () => {
    const requestRender = vi.fn();
    const dashboard = new BackgroundDashboard(
      [job(), job({ id: "bg_2", command: "second" })],
      { fg: (_tone: string, value: string) => value, bold: (value: string) => value } as never,
      {
        matches: (data: string, action: string) =>
          (data === "N" && action === "tui.select.down") ||
          (data === "O" && action === "tui.select.confirm") ||
          (data === "B" && action === "tui.select.cancel"),
        getKeys: (action: string) => [action],
      } as never,
      {
        onClose: vi.fn(),
        onStop: vi.fn(),
        loadTail: (id) => job({ id, command: id === "bg_2" ? "second" : "sleep 10" }),
        requestRender,
      },
    );
    dashboard.handleInput("N");
    expect(dashboard.render(60).join("\n")).toContain("> ◆ running · /tmp");
    dashboard.handleInput("j");
    const list = dashboard.render(60);
    expect(list.join("\n")).toContain("> ◆ running");
    expect(list[0]).toContain("╭─ Background tasks · 2");
    expect(list.at(-1)).toContain("j/k navigate");
    expect(list.every((line) => visibleWidth(line) === 60)).toBe(true);
    dashboard.handleInput("O");
    expect(dashboard.render(60).join("\n")).toContain("$ second");
    dashboard.replaceJob(job({ id: "bg_2", command: "updated", status: "completed" }));
    const detail = dashboard.render(60);
    expect(detail.join("\n")).toContain("$ updated");
    expect(detail[0]).toContain("╭─ Background task");
    expect(detail.at(-1)).toContain("j/k scroll");
    expect(detail.every((line) => visibleWidth(line) === 60)).toBe(true);
    dashboard.handleInput("B");
    expect(dashboard.render(60).join("\n")).toContain("Background tasks");
  });

  it("coalesces live updates, ticks elapsed, scrolls a stable output viewport, and disposes", () => {
    vi.useFakeTimers();
    try {
      let publish!: (jobs: JobRecord[]) => void;
      const unsubscribe = vi.fn();
      const requestRender = vi.fn();
      const current = job({
        terminalTail: {
          content: Array.from({ length: 18 }, (_, index) => `line-${index}`).join("\n"),
        } as never,
      });
      const dashboard = new BackgroundDashboard(
        [current],
        { fg: (_tone: string, value: string) => value, bold: (value: string) => value } as never,
        {
          matches: (data: string, action: string) =>
            (data === "O" && action === "tui.select.confirm") ||
            (data === "U" && action === "tui.select.up") ||
            (data === "D" && action === "tui.select.down") ||
            (data === "P" && action === "tui.select.pageUp") ||
            (data === "N" && action === "tui.select.pageDown"),
          getKeys: (action: string) => [action],
        } as never,
        {
          onClose: vi.fn(),
          onStop: vi.fn(),
          loadTail: () => current,
          requestRender,
          subscribe: (listener) => {
            publish = listener;
            return unsubscribe;
          },
        },
      );
      dashboard.handleInput("O");
      const bottom = dashboard.render(80);
      const bottomOutput = bottom.slice(
        bottom.findIndex((line) => line.includes("Output tail")) + 1,
        bottom.findIndex((line) => line.includes("Output tail")) + 11,
      );
      expect(bottomOutput).toHaveLength(10);
      expect(bottomOutput.join("\n")).toContain("line-17");

      dashboard.handleInput("g");
      const top = dashboard.render(80);
      const topOutput = top.slice(
        top.findIndex((line) => line.includes("Output tail")) + 1,
        top.findIndex((line) => line.includes("Output tail")) + 11,
      );
      expect(topOutput).toHaveLength(bottomOutput.length);
      expect(topOutput.join("\n")).toContain("line-0");
      dashboard.handleInput("G");
      dashboard.handleInput("P");
      expect(dashboard.render(80).join("\n")).toContain("line-8");
      dashboard.handleInput("N");

      dashboard.invalidate();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      requestRender.mockClear();
      publish([job({ id: "bg_2" })]);
      publish([current]);
      vi.advanceTimersByTime(49);
      expect(requestRender).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(requestRender).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1_000);
      expect(requestRender).toHaveBeenCalledTimes(2);

      dashboard.dispose();
      dashboard.dispose();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fresh-resolves and confirms x stop without nested action views", async () => {
    const current = runtime([job()]);
    Object.assign(current, {
      stopManyResult: vi.fn(async () => ({ jobs: [] })),
    });
    let dashboard: { handleInput: (data: string) => void } | undefined;
    const confirm = vi.fn(async () => false);
    const custom = vi.fn(async (factory) => {
      await new Promise<void>((resolve) => {
        const activeDashboard = factory(
          { requestRender: vi.fn() },
          { fg: (_tone: string, value: string) => value, bold: (value: string) => value },
          {
            matches: (data: string, action: string) =>
              data === "B" && action === "tui.select.cancel",
            getKeys: () => [],
          },
          resolve,
        );
        dashboard = activeDashboard;
        activeDashboard.handleInput("x");
        queueMicrotask(() => dashboard?.handleInput("B"));
      });
    });
    const ctx = { mode: "tui", ui: { custom, confirm, notify: vi.fn() } };

    const events = eventBus();
    await showBackgroundTasks(events, ctx as never, current);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());

    expect(current.resolve).toHaveBeenCalledWith(["bg_1"]);
    expect(current.tail).not.toHaveBeenCalled();
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect("editor" in ctx.ui).toBe(false);
    expect(events.emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: "Waiting for background task dashboard input" }],
      ["herdr:blocked", { active: false }],
    ]);
  });

  it("balances dashboard rejection and skips blocked state when there are no jobs", async () => {
    const failure = new Error("dashboard failed");
    const events = eventBus();
    const rejectingContext = {
      mode: "tui",
      ui: { custom: vi.fn(async () => Promise.reject(failure)), notify: vi.fn() },
    };
    await expect(
      showBackgroundTasks(events, rejectingContext as never, runtime([job()])),
    ).rejects.toBe(failure);
    expect(events.emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: "Waiting for background task dashboard input" }],
      ["herdr:blocked", { active: false }],
    ]);

    events.emit.mockClear();
    const emptyContext = { mode: "tui", ui: { custom: vi.fn(), notify: vi.fn() } };
    await showBackgroundTasks(events, emptyContext as never, runtime([]));
    expect(events.emit).not.toHaveBeenCalled();
    expect(emptyContext.ui.custom).not.toHaveBeenCalled();
  });

  it("honors a requested RPC job and sanitizes unknown IDs", async () => {
    const current = runtime([
      job({ id: "bg_1", description: "first", outputPath: "/tmp/first.log" }),
      job({ id: "bg_2", description: "second", outputPath: "/tmp/second.log" }),
    ]);
    const notify = vi.fn();
    const ctx = { mode: "rpc", ui: { notify } };

    await showBackgroundTasks(eventBus(), ctx as never, current, "bg_2");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("◆ running"), "info");
    expect(notify.mock.calls.at(-1)![0]).toContain("/tmp/second.log");

    await showBackgroundTasks(eventBus(), ctx as never, current, "bad\u001b]0;title\u0007-id");
    const [message, level] = notify.mock.calls.at(-1)!;
    expect(level).toBe("error");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\u0007");
  });
});
