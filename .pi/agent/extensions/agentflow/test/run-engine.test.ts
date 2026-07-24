import { describe, expect, it, vi } from "vitest";
import { RunEngine, type ChildRunner } from "../src/runtime/run-engine.ts";
import type { AgentNodeSpec, ChildExecutionResult } from "../src/types.ts";

const context = { cwd: "/tmp/project" } as never;
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, cost: 0.25 };
const childResult = (text: string): ChildExecutionResult => ({ text, usage });
const engineWith = (
  run: ChildRunner["run"],
  options: {
    globalConcurrency?: number;
    deliver?: ConstructorParameters<typeof RunEngine>[2];
    idle?: () => boolean;
  } = {},
) =>
  new RunEngine(
    undefined,
    undefined,
    options.deliver,
    undefined,
    { run },
    options.globalConcurrency,
    options.idle,
  );

describe("RunEngine subscriptions", () => {
  it("publishes fresh start, update, and settlement snapshots globally and per run", () => {
    const engine = new RunEngine();
    const global = vi.fn();
    const unsubscribeGlobal = engine.subscribe(global);
    const runId = engine.startRun({ kind: "agent" }, context);

    expect(global).toHaveBeenCalledWith([expect.objectContaining({ runId, status: "running" })]);
    global.mock.calls[0]![0][0].name = "mutated by observer";
    expect(engine.getRun(runId).name).toBeUndefined();

    const perRun = vi.fn();
    const unsubscribeRun = engine.subscribeRun(runId, perRun);
    engine.log(runId, "live output");
    const received = perRun.mock.calls[0]![0];
    received.name = "also mutated by observer";
    expect(engine.getRun(runId).name).toBeUndefined();

    engine.finish(runId, "completed", "done");
    expect(perRun.mock.calls.map(([value]) => value.status)).toEqual(["running", "completed"]);
    expect(perRun.mock.calls[0]![0].logs).toEqual(["live output"]);
    expect(engine.listRuns()).toEqual([engine.getRun(runId)]);

    unsubscribeRun();
    unsubscribeRun();
    unsubscribeGlobal();
    unsubscribeGlobal();
    engine.startRun({ kind: "agent" }, context);
    expect(global).toHaveBeenCalledTimes(3);
  });
});

describe("RunEngine settlement", () => {
  it("is first-writer-wins and does not duplicate settlement side effects", () => {
    const emit = vi.fn();
    const engine = new RunEngine(emit);
    let runId = "";
    runId = engine.startRun({ kind: "agent" }, context, undefined, () => {
      // Exercise synchronous re-entry through snapshot notification.
      engine.finish(runId, "aborted", undefined, "late cancellation");
    });

    const first = engine.finish(runId, "completed", "first result");
    const second = engine.finish(runId, "failed", undefined, "late failure");

    expect(first.status).toBe("completed");
    expect(second).toEqual(first);
    expect(engine.getSnapshot(runId)).toMatchObject({
      status: "completed",
      resultPreview: "first result",
    });
    expect(engine.getSnapshot(runId)).not.toHaveProperty("error");
    expect(emit.mock.calls.filter(([name]) => name === "agentflow:run.completed")).toHaveLength(1);
    expect(
      emit.mock.calls.filter(([name]) => String(name).startsWith("agentflow:run.failed")),
    ).toHaveLength(0);
  });

  it("bounds cancellation when task initialization ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const engine = engineWith(async () => new Promise(() => undefined));
      const runId = engine.startRun({ kind: "agent", background: true }, context);
      void engine.runTask(runId, { id: "agent", label: "agent", prompt: "test" });
      await Promise.resolve();

      const cancellation = engine.cancel([runId]);
      await vi.advanceTimersByTimeAsync(3_001);
      await cancellation;

      expect(engine.getResult(runId)?.status).toBe("aborted");
      expect(engine.getSnapshot(runId)).toMatchObject({
        status: "aborted",
        nodes: [{ status: "aborted" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for active task bookkeeping before cancellation settles the run", async () => {
    const engine = engineWith(
      async (_runId: string, _node: AgentNodeSpec, _ctx: unknown, signal: AbortSignal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => queueMicrotask(() => reject(new DOMException("aborted", "AbortError"))),
            { once: true },
          ),
        ),
    );
    const runId = engine.startRun({ kind: "agent", background: true }, context);
    const task = engine.runTask(runId, { id: "agent", label: "agent", prompt: "test" });

    await engine.cancel([runId]);
    await expect(task).resolves.toMatchObject({ ok: false, aborted: true });
    expect(engine.getSnapshot(runId)).toMatchObject({
      status: "aborted",
      nodes: [{ status: "aborted" }],
    });
    expect(engine.getResult(runId)?.status).toBe("aborted");
  });

  it("returns one normalized task envelope with provenance", async () => {
    const engine = engineWith(async () => ({
      ...childResult("explanation"),
      structured: { answer: 42 },
      sessionFile: "/tmp/child.jsonl",
    }));
    const runId = engine.startRun(
      { kind: "agent", originTool: "agentflow_review", semanticRole: "review" },
      context,
    );
    const result = await engine.runTask(runId, {
      id: "review",
      label: "review",
      prompt: "inspect",
    });

    expect(result).toEqual({
      ok: true,
      output: "explanation",
      structured: { answer: 42 },
      aborted: false,
      sessionFile: "/tmp/child.jsonl",
      usage,
    });
    expect(engine.getSnapshot(runId)).toMatchObject({
      originTool: "agentflow_review",
      semanticRole: "review",
      nodes: [
        {
          originTool: "agentflow_review",
          semanticRole: "review",
          prompt: "inspect",
          cwd: "/tmp/project",
          usage,
        },
      ],
    });
  });

  it("starts workflow tasks without default per-run or process-wide concurrency caps", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const engine = engineWith(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return childResult("done");
    });
    const runId = engine.startRun({ kind: "workflow" }, context);
    const tasks = Array.from({ length: 20 }, (_, index) =>
      engine.runTask(runId, { id: `n${index}`, label: `n${index}`, prompt: "work" }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(20));
    releases.splice(0).forEach((release) => release());
    await Promise.all(tasks);

    expect(peak).toBe(20);
    expect(engine.getLimits(runId)).toEqual({});
  });

  it("enforces an explicitly configured per-run concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const engine = engineWith(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return childResult("done");
    });
    const runId = engine.startRun({ kind: "workflow", limits: { concurrency: 2 } }, context);
    const tasks = Array.from({ length: 3 }, (_, index) =>
      engine.runTask(runId, { id: `n${index}`, label: `n${index}`, prompt: "work" }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await Promise.all(tasks);

    expect(peak).toBe(2);
  });

  it("enforces an explicitly configured maximum agent count", async () => {
    const engine = engineWith(async () => childResult("done"));
    const runId = engine.startRun({ kind: "workflow", limits: { maxAgents: 1 } }, context);

    await expect(
      engine.runTask(runId, { id: "first", label: "first", prompt: "work" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      engine.runTask(runId, { id: "second", label: "second", prompt: "work" }),
    ).resolves.toMatchObject({
      ok: false,
      aborted: true,
      error: "Maximum agent count exceeded (1)",
    });
  });

  it("enforces an explicitly configured run timeout for running and queued tasks", async () => {
    vi.useFakeTimers();
    try {
      const engine = engineWith(
        async (_runId, _node, _ctx, signal) =>
          new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            ),
          ),
      );
      const runId = engine.startRun(
        { kind: "workflow", limits: { concurrency: 1, timeoutMs: 10 } },
        context,
      );
      const running = engine.runTask(runId, { id: "running", label: "running", prompt: "work" });
      const queued = engine.runTask(runId, { id: "queued", label: "queued", prompt: "work" });

      await vi.advanceTimersByTimeAsync(11);
      await expect(Promise.all([running, queued])).resolves.toEqual([
        expect.objectContaining({ ok: false, aborted: true }),
        expect.objectContaining({ ok: false, aborted: true }),
      ]);
      await expect(engine.observeCompletion(runId)).resolves.toMatchObject({
        status: "aborted",
        error: "Run timeout exceeded after 10ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an explicit child deadline to the child runner without a competing run timer", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      let childSignal!: AbortSignal;
      const engine = engineWith(async (_runId, _node, _ctx, signal) => {
        childSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return childResult("done");
      });
      const launched = engine.launchAgent(
        { id: "agent", label: "agent", prompt: "work", config: { timeoutMs: 10 } },
        context,
        { background: false },
      );

      await vi.advanceTimersByTimeAsync(11);
      expect(childSignal.aborted).toBe(false);
      release();
      await expect(launched).resolves.toMatchObject({ status: "completed", result: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("layers explicitly configured process-wide concurrency over independent runs", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const engine = engineWith(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return childResult("done");
      },
      { globalConcurrency: 2 },
    );
    const ids = Array.from({ length: 3 }, () =>
      engine.startRun({ kind: "agent", limits: { concurrency: 1 } }, context),
    );
    const tasks = ids.map((id, index) =>
      engine.runTask(id, { id: `n${index}`, label: `n${index}`, prompt: "work" }),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await Promise.all(tasks);

    expect(peak).toBe(2);
  });

  it("delivers a background result once, and only while the parent is idle", async () => {
    let idle = false;
    const deliver = vi.fn();
    const engine = engineWith(async () => childResult("done"), { deliver, idle: () => idle });
    const result = await engine.launchAgent(
      { id: "agent", label: "agent", prompt: "work" },
      context,
      { background: true },
    );
    await engine.wait([result.runId]);
    engine.flushBackgroundDeliveries();
    expect(deliver).not.toHaveBeenCalled();

    // wait() consumes delivery. A second run exercises idle-triggered delivery.
    const second = await engine.launchAgent(
      { id: "agent", label: "agent", prompt: "work" },
      context,
      { background: true },
    );
    await vi.waitFor(() => expect(engine.getResult(second.runId)).toBeDefined());
    idle = true;
    engine.flushBackgroundDeliveries();
    engine.flushBackgroundDeliveries();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      runId: second.runId,
      status: "completed",
      snapshot: { nodes: [{ usage: { cost: 0.25 } }] },
    });
  });
});
