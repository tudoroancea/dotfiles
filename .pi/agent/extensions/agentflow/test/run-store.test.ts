import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../src/state/run-store.ts";

const snapshot = (runId: string) => ({
  runId,
  kind: "agent" as const,
  status: "running" as const,
  createdAt: new Date(0).toISOString(),
  phases: [],
  nodes: [],
  logs: [],
});
const live = (runId: string, extra: Record<string, unknown> = {}) => {
  let resolveCompletion!: (value: never) => void;
  const completion = new Promise<never>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    snapshot: snapshot(runId),
    controls: new Map(),
    controller: new AbortController(),
    context: {} as never,
    completion,
    resolveCompletion,
    consumed: false,
    ...extra,
  };
};

describe("RunStore", () => {
  it("returns defensive snapshots and sends updates", () => {
    const store = new RunStore();
    const notify = vi.fn();
    store.add(live("r1", { notify }) as never);
    store.update("r1", (state) => state.logs.push("hello"));
    const copy = store.get("r1")!;
    copy.logs.push("mutated");
    expect(store.get("r1")!.logs).toEqual(["hello"]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("keeps terminal snapshots immutable when late updates arrive", () => {
    const store = new RunStore();
    store.add(live("r1") as never);
    store.settle(
      "r1",
      (state) => {
        state.status = "completed";
        state.completedAt = new Date(1).toISOString();
      },
      (terminalSnapshot) => ({
        runId: "r1",
        status: "completed",
        result: "done",
        snapshot: terminalSnapshot,
      }),
    );

    store.update("r1", (state) => {
      state.status = "failed";
      state.logs.push("late provider event");
    });

    expect(store.get("r1")).toMatchObject({ status: "completed", logs: [] });
    expect(store.getResult("r1")).toMatchObject({ status: "completed", result: "done" });
  });

  it("refuses to attach a child control after settlement", () => {
    const store = new RunStore();
    store.add(live("r1") as never);
    store.settle(
      "r1",
      (state) => {
        state.status = "completed";
      },
      (terminalSnapshot) => ({
        runId: "r1",
        status: "completed",
        result: "done",
        snapshot: terminalSnapshot,
      }),
    );

    expect(store.attachControl("r1", "n1", { abort: vi.fn(async () => undefined) })).toBe(false);
  });

  it("aborts the run controller and live child controls", async () => {
    const store = new RunStore();
    const abort = vi.fn(async () => undefined);
    const controller = new AbortController();
    store.add(live("r1", { controls: new Map([["n1", { abort }]]), controller }) as never);
    await store.abort("r1");
    expect(controller.signal.aborted).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
  });
});
