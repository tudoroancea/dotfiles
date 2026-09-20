import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/runtime/artifact-store.ts";
import { RunEngine, type ChildRunner } from "../src/runtime/run-engine.ts";
import type { AgentNodeSpec, ChildExecutionResult } from "../src/types.ts";

const context = { cwd: "/tmp/project" } as never;
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, cost: 0.25 };
const childResult = (text: string): ChildExecutionResult => ({ text, usage });
const engineWith = (
  run: ChildRunner["run"],
  options: {
    deliver?: ConstructorParameters<typeof RunEngine>[2];
    idle?: () => boolean;
    artifacts?: ConstructorParameters<typeof RunEngine>[6];
    createClaudeRunner?: ConstructorParameters<typeof RunEngine>[7];
  } = {},
) =>
  new RunEngine(
    undefined,
    undefined,
    options.deliver,
    undefined,
    { run },
    options.idle,
    options.artifacts ??
      ({
        directory: (runId: string) => `/tmp/agentflow-tests/${runId}`,
        initialize: async (runId: string) => `/tmp/agentflow-tests/${runId}`,
        checkpoint: () => {},
        finish: async () => {},
      } as never),
    options.createClaudeRunner,
  );

describe("RunEngine subscriptions", () => {
  it("publishes fresh snapshots globally", () => {
    const engine = new RunEngine();
    const global = vi.fn();
    const unsubscribeGlobal = engine.subscribe(global);
    const runId = engine.startRun({ kind: "agent" }, context);

    expect(global).toHaveBeenCalledWith([expect.objectContaining({ runId, status: "running" })]);
    global.mock.calls[0]![0][0].name = "mutated by observer";
    expect(engine.getRun(runId).name).toBeUndefined();

    engine.log(runId, "live output");
    engine.finish(runId, "completed", "done");
    expect(engine.listRuns()).toEqual([engine.getRun(runId)]);

    unsubscribeGlobal();
    unsubscribeGlobal();
    engine.startRun({ kind: "agent" }, context);
    expect(global).toHaveBeenCalledTimes(3);
  });
});

describe("RunEngine session scoping", () => {
  it("stamps new runs with the scope and filters listings to it", () => {
    const engine = new RunEngine();
    const legacy = engine.startRun({ kind: "agent" }, context);
    engine.setSessionScope("session-a");
    const runA = engine.startRun({ kind: "agent" }, context);
    engine.setSessionScope("session-b");
    const runB = engine.startRun({ kind: "workflow" }, context);

    expect(engine.getRun(runA).sessionId).toBe("session-a");
    expect(engine.getRun(runB).sessionId).toBe("session-b");
    expect(engine.getRun(legacy).sessionId).toBeUndefined();
    expect(engine.listRuns().map((run) => run.runId)).toEqual([runB]);
    expect((engine.getSnapshot() as { runId: string }[]).map((run) => run.runId)).toEqual([runB]);
    expect(engine.listAll().map((run) => run.runId)).toEqual([runB, runA, legacy]);
  });

  it("persists standalone agent runs for resumed-session recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-agent-scope-"));
    try {
      const artifacts = new ArtifactStore(root);
      const first = engineWith(async () => childResult("done"), { artifacts });
      first.setSessionScope("session-a");

      const result = await first.launchAgent(
        {
          id: "finder",
          label: "finder",
          prompt: "Inspect authentication boundaries",
          semanticRole: "finder",
        },
        context,
        { background: false },
      );
      await vi.waitFor(async () => {
        await expect(readFile(join(root, result.runId, "run.json"), "utf8")).resolves.toContain(
          "session-a",
        );
      });

      const resumed = new RunEngine(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        artifacts,
      );
      await resumed.recover();
      resumed.setSessionScope("session-a");
      expect(resumed.listRuns()).toEqual([
        expect.objectContaining({
          runId: result.runId,
          sessionId: "session-a",
          kind: "agent",
          status: "completed",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists every run when no scope is configured", () => {
    const engine = new RunEngine();
    const first = engine.startRun({ kind: "agent" }, context);
    engine.setSessionScope("session-a");
    engine.setSessionScope(undefined);
    const second = engine.startRun({ kind: "agent" }, context);

    expect(engine.listRuns().map((run) => run.runId)).toEqual([second, first]);
  });

  it("preserves the originating session across recovery and filters resumed sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-scope-"));
    try {
      const store = new ArtifactStore(root);
      const first = new RunEngine(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        store,
      );
      first.setSessionScope("session-a");
      const runId = first.startRun({ kind: "agent" }, context);
      await first.setArtifact(runId, "return null", null);
      first.finish(runId, "completed", "done");
      await vi.waitFor(async () => {
        await expect(readFile(join(root, runId, "run.json"), "utf8")).resolves.toContain(
          "session-a",
        );
      });

      const resumed = new RunEngine(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        store,
      );
      await resumed.recover();
      expect(resumed.listAll()).toEqual([
        expect.objectContaining({ runId, sessionId: "session-a", status: "completed" }),
      ]);
      resumed.setSessionScope("session-a");
      expect(resumed.listRuns().map((run) => run.runId)).toEqual([runId]);
      resumed.setSessionScope("session-b");
      expect(resumed.listRuns()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it.each([
    ["foreground", false],
    ["background", true],
  ] as const)(
    "returns settlement when a %s launch is cancelled during artifact initialization",
    async (_mode, background) => {
      const root = await mkdtemp(join(tmpdir(), "agentflow-agent-initialize-"));
      try {
        let release!: () => void;
        const initialized = new Promise<void>((resolve) => {
          release = resolve;
        });
        const artifacts = new (class extends ArtifactStore {
          override async initialize(runId: string): Promise<string> {
            await initialized;
            return super.initialize(runId);
          }
        })(root);
        const run = vi.fn(async () => childResult("unexpected"));
        const engine = engineWith(run, { artifacts });
        engine.setSessionScope("session-a");

        const launch = engine.launchAgent(
          { id: "agent", label: "agent", prompt: "test" },
          context,
          { background },
        );
        await vi.waitFor(() => expect(engine.listAll()).toHaveLength(1));
        const runId = engine.listAll()[0]!.runId;
        await engine.cancel([runId]);
        release();

        await expect(launch).resolves.toMatchObject({ runId, status: "aborted" });
        expect(run).not.toHaveBeenCalled();
        await vi.waitFor(async () => {
          await expect(readFile(join(root, runId, "run.json"), "utf8")).resolves.toContain(
            "session-a",
          );
        });

        const resumed = new RunEngine(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          artifacts,
        );
        await resumed.recover();
        resumed.setSessionScope("session-a");
        expect(resumed.listRuns()).toEqual([expect.objectContaining({ runId, status: "aborted" })]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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

  it("routes only marked nodes to Claude and snapshots requested model and cost", async () => {
    const piRun = vi.fn(async () => childResult("pi"));
    const claudeRun = vi.fn(async () => childResult("claude"));
    const engine = engineWith(piRun, {
      createClaudeRunner: () => ({ run: claudeRun }),
    });

    const piResult = await engine.launchAgent(
      { id: "pi", label: "pi", prompt: "routine" },
      context,
      { background: false },
    );
    const claudeResult = await engine.launchAgent(
      {
        id: "claude",
        label: "claude/fable",
        prompt: "hard advice",
        claude: true,
        config: { model: "fable" },
      },
      context,
      { background: false },
    );

    expect(piRun).toHaveBeenCalledOnce();
    expect(claudeRun).toHaveBeenCalledOnce();
    expect(piResult).toMatchObject({ status: "completed", result: "pi" });
    expect(claudeResult).toMatchObject({
      status: "completed",
      result: "claude",
      snapshot: {
        nodes: [{ backend: "claude", model: "fable", usage }],
      },
    });
  });

  it("never falls back to the Pi runner for a marked Claude node", async () => {
    const piRun = vi.fn(async () => childResult("wrong runner"));
    const engine = engineWith(piRun);

    const result = await engine.launchAgent(
      { id: "claude", label: "claude/opus", prompt: "work", claude: true },
      context,
      { background: false },
    );

    expect(piRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      error: "Claude runner is not configured",
      snapshot: { nodes: [{ backend: "claude", model: "opus" }] },
    });
  });

  it("reports unsupported Claude steering and stays aborted when its control resolves normally", async () => {
    const abort = vi.fn();
    const engine = engineWith(async () => childResult("pi"), {
      createClaudeRunner: (store) => ({
        run: async (runId, node) =>
          new Promise((resolve) => {
            store.attachControl(runId, node.id, {
              abort: async () => {
                abort();
                resolve(childResult("late result"));
              },
            });
          }),
      }),
    });
    const launched = await engine.launchAgent(
      { id: "claude", label: "claude/opus", prompt: "work", claude: true },
      context,
      { background: true },
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot(launched.runId)).toMatchObject({ nodes: [{ status: "running" }] }),
    );

    await expect(engine.steer(launched.runId, undefined, "change direction")).rejects.toThrow(
      "Claude runs do not support steering in v1",
    );
    await engine.cancel([launched.runId]);

    expect(abort).toHaveBeenCalledOnce();
    expect(engine.getSnapshot(launched.runId)).toMatchObject({
      status: "aborted",
      nodes: [{ status: "aborted", backend: "claude" }],
    });
  });

  it("keeps a Claude run aborted when shutdown races a successful resolution", async () => {
    const engine = engineWith(async () => childResult("pi"), {
      createClaudeRunner: (store) => ({
        run: async (runId, node) =>
          new Promise((resolve) => {
            store.attachControl(runId, node.id, {
              abort: async () => resolve(childResult("late shutdown result")),
            });
          }),
      }),
    });
    const launched = await engine.launchAgent(
      { id: "claude", label: "claude/opus", prompt: "work", claude: true },
      context,
      { background: true },
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot(launched.runId)).toMatchObject({ nodes: [{ status: "running" }] }),
    );

    await engine.shutdown();

    expect(engine.getResult(launched.runId)).toMatchObject({
      status: "aborted",
      snapshot: { nodes: [{ status: "aborted", backend: "claude" }] },
    });
  });

  it("delivers a background result once, and only while the parent is idle", async () => {
    let idle = false;
    const deliver = vi.fn();
    const engine = engineWith(async () => childResult("pi"), {
      deliver,
      idle: () => idle,
      createClaudeRunner: () => ({ run: async () => childResult("done") }),
    });
    const result = await engine.launchAgent(
      { id: "claude", label: "claude/opus", prompt: "work", claude: true },
      context,
      { background: true },
    );
    await engine.wait([result.runId]);
    engine.flushBackgroundDeliveries();
    expect(deliver).not.toHaveBeenCalled();

    // wait() consumes delivery. A second run exercises idle-triggered delivery.
    const second = await engine.launchAgent(
      { id: "claude", label: "claude/opus", prompt: "work", claude: true },
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
      snapshot: { nodes: [{ backend: "claude", model: "opus", usage: { cost: 0.25 } }] },
    });
  });
});
