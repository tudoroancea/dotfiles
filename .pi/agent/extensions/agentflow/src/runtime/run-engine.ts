import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTaskResult,
  ChildExecutionResult,
  LiveRun,
  RunKind,
  RunLimits,
  RunResult,
  RunSnapshot,
} from "../types.ts";
import { RunStore } from "../state/run-store.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { SubagentRunner } from "./subagent-runner.ts";
import { boundEffectiveCwd, boundInitialPrompt } from "./snapshot-fields.ts";

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
const preview = (v: unknown) => {
  try {
    return (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 1000);
  } catch {
    return "[unserializable]";
  }
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const TASK_SETTLE_TIMEOUT_MS = 3_000;
type Update = (snapshot: RunSnapshot) => void;
type ListUpdate = (snapshots: RunSnapshot[]) => void;
interface Runtime {
  scheduled: number;
  active: number;
  queue: Array<() => void>;
  tasks: Set<Promise<unknown>>;
  limits: RunLimits;
  deadline?: NodeJS.Timeout;
}
export interface ChildRunner {
  run(
    runId: string,
    node: AgentNodeSpec,
    ctx: ExtensionContext,
    parentSignal: AbortSignal,
  ): Promise<ChildExecutionResult>;
}

export class RunEngine {
  private readonly store = new RunStore();
  private readonly runner: ChildRunner;
  private readonly runtime = new Map<string, Runtime>();
  private readonly subscribers = new Set<ListUpdate>();
  private readonly runSubscribers = new Map<string, Set<Update>>();
  private globalActive = 0;
  private readonly globalQueue: Array<{
    start: () => void;
    reject: (error: DOMException) => void;
    signal: AbortSignal;
  }> = [];
  constructor(
    private readonly emit: (name: string, payload: unknown) => void = () => {},
    getTools: () => string[] = () => [],
    private readonly deliver?: (message: string, result: RunResult) => void,
    getThinking: () => import("@earendil-works/pi-agent-core").ThinkingLevel | undefined = () =>
      undefined,
    runner?: ChildRunner,
    private readonly globalConcurrency?: number,
    private readonly isParentIdle: () => boolean = () => true,
    private readonly artifacts = new ArtifactStore(),
  ) {
    if (
      globalConcurrency !== undefined &&
      (!Number.isInteger(globalConcurrency) || globalConcurrency < 1)
    )
      throw new Error("globalConcurrency must be a positive integer");
    this.runner = runner ?? new SubagentRunner(this.store, getTools, getThinking);
  }

  async recover(): Promise<void> {
    for (const snapshot of await this.artifacts.recover()) this.store.addRecovered(snapshot);
  }

  startRun(
    spec: {
      kind: RunKind;
      name?: string;
      description?: string;
      originTool?: string;
      semanticRole?: RunSnapshot["semanticRole"];
      limits?: RunLimits;
      background?: boolean;
    },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: Update,
  ): string {
    const runId = this.store.allocateId();
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    let resolveCompletion!: (r: RunResult) => void;
    const completion = new Promise<RunResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const snapshot: RunSnapshot = {
      runId,
      kind: spec.kind,
      name: spec.name,
      description: spec.description,
      originTool: spec.originTool,
      semanticRole: spec.semanticRole,
      status: "running",
      createdAt: new Date().toISOString(),
      phases: [],
      nodes: [],
      logs: [],
      background: spec.background,
    };
    const live: LiveRun = {
      snapshot,
      sessions: new Map(),
      controller,
      context: ctx,
      completion,
      resolveCompletion,
      consumed: !spec.background,
      notify: (s) => {
        onUpdate?.(structuredClone(s));
        this.publish(s);
        this.emit("agentflow:run.updated", s);
        this.artifacts.checkpoint(s);
      },
    };
    this.store.add(live);
    const limits = { ...spec.limits };
    const state: Runtime = { scheduled: 0, active: 0, queue: [], tasks: new Set(), limits };
    this.runtime.set(runId, state);
    if (limits.timeoutMs)
      state.deadline = setTimeout(() => {
        const error = new Error(`Run timeout exceeded after ${limits.timeoutMs}ms`);
        controller.abort(error);
        void this.abortAndWait(runId).then(() => {
          if (!this.store.getResult(runId)) this.finish(runId, "aborted", undefined, error.message);
        });
      }, limits.timeoutMs);
    this.publish(snapshot);
    this.emit("agentflow:run.started", structuredClone(snapshot));
    return runId;
  }
  async setArtifact(runId: string, script: string, args: unknown): Promise<string> {
    const dir = await this.artifacts.create(runId, script, args);
    if (!this.store.getResult(runId))
      this.store.update(runId, (snapshot) => {
        snapshot.artifactDir = dir;
      });
    return dir;
  }
  private async reserveGlobal(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new DOMException("Run aborted", "AbortError");
    if (this.globalConcurrency !== undefined && this.globalActive >= this.globalConcurrency)
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: resolve,
          reject,
          signal,
        };
        this.globalQueue.push(entry);
        signal.addEventListener(
          "abort",
          () => {
            const index = this.globalQueue.indexOf(entry);
            if (index >= 0) this.globalQueue.splice(index, 1);
            reject(new DOMException("Run aborted", "AbortError"));
          },
          { once: true },
        );
      });
    if (signal.aborted) throw new DOMException("Run aborted", "AbortError");
    this.globalActive++;
    return () => {
      this.globalActive--;
      for (;;) {
        const next = this.globalQueue.shift();
        if (!next) break;
        if (next.signal.aborted) {
          next.reject(new DOMException("Run aborted", "AbortError"));
          continue;
        }
        next.start();
        break;
      }
    };
  }
  private async reserve(runId: string): Promise<() => void> {
    const state = this.runtime.get(runId);
    const live = this.store.getLive(runId);
    if (!state || !live) throw new Error(`Unknown active run: ${runId}`);
    if (live.controller.signal.aborted) throw new DOMException("Run aborted", "AbortError");
    state.scheduled++;
    if (state.limits.maxAgents !== undefined && state.scheduled > state.limits.maxAgents) {
      const error = new Error(`Maximum agent count exceeded (${state.limits.maxAgents})`);
      live.controller.abort(error);
      throw error;
    }
    const spent = live.snapshot.nodes.reduce((sum, n) => sum + n.usage.total, 0);
    if (state.limits.tokenBudget !== undefined && spent >= state.limits.tokenBudget) {
      const error = new Error(`Token budget exhausted (${spent}/${state.limits.tokenBudget})`);
      live.controller.abort(error);
      throw error;
    }
    if (state.limits.concurrency !== undefined && state.active >= state.limits.concurrency)
      await new Promise<void>((resolve, reject) => {
        const start = () =>
          live.controller.signal.aborted
            ? reject(new DOMException("Run aborted", "AbortError"))
            : resolve();
        state.queue.push(start);
        live.controller.signal.addEventListener(
          "abort",
          () => {
            const i = state.queue.indexOf(start);
            if (i >= 0) state.queue.splice(i, 1);
            reject(new DOMException("Run aborted", "AbortError"));
          },
          { once: true },
        );
      });
    state.active++;
    let releaseGlobal: (() => void) | undefined;
    try {
      releaseGlobal = await this.reserveGlobal(live.controller.signal);
    } catch (error) {
      state.active--;
      state.queue.shift()?.();
      throw error;
    }
    return () => {
      releaseGlobal?.();
      state.active--;
      state.queue.shift()?.();
    };
  }
  runTask(runId: string, node: AgentNodeSpec): Promise<AgentTaskResult> {
    const state = this.runtime.get(runId);
    if (!state) return Promise.reject(new Error(`Unknown active run: ${runId}`));
    const task = this.executeTask(runId, node);
    state.tasks.add(task);
    const remove = () => state.tasks.delete(task);
    task.then(remove, remove);
    return task;
  }
  private async executeTask(runId: string, node: AgentNodeSpec): Promise<AgentTaskResult> {
    const live = this.store.getLive(runId);
    if (!live?.context) throw new Error(`Unknown active run: ${runId}`);
    if (live.snapshot.nodes.some((n) => n.id === node.id))
      throw new Error(`Duplicate task id: ${node.id}`);
    this.store.update(runId, (s) =>
      s.nodes.push({
        id: node.id,
        label: node.label,
        phase: node.phase ?? s.currentPhase,
        dependsOn: node.dependsOn,
        originTool: node.originTool ?? live.snapshot.originTool,
        semanticRole: node.semanticRole ?? live.snapshot.semanticRole,
        prompt: boundInitialPrompt(node.prompt),
        cwd: boundEffectiveCwd(node.config?.cwd ?? live.context!.cwd),
        status: "queued",
        queuedAt: new Date().toISOString(),
        tools: 0,
        toolCalls: [],
        usage: emptyUsage(),
      }),
    );
    let release: (() => void) | undefined;
    try {
      release = await this.reserve(runId);
    } catch (error) {
      if (!live.result)
        this.store.updateNode(runId, node.id, (n) => {
          n.status = live.controller.signal.aborted || isAbort(error) ? "aborted" : "failed";
          n.completedAt = new Date().toISOString();
          n.error = errorText(error);
        });
      return {
        ok: false,
        output: "",
        error: errorText(error),
        aborted: live.controller.signal.aborted || isAbort(error),
        usage: emptyUsage(),
      };
    }
    if (live.result || live.controller.signal.aborted) {
      release();
      const error = new DOMException("Run aborted", "AbortError");
      if (!live.result)
        this.store.updateNode(runId, node.id, (nodeSnapshot) => {
          nodeSnapshot.status = "aborted";
          nodeSnapshot.completedAt = new Date().toISOString();
          nodeSnapshot.error = error.message;
        });
      return {
        ok: false,
        output: "",
        error: error.message,
        aborted: true,
        usage: emptyUsage(),
      };
    }
    this.store.updateNode(runId, node.id, (n) => {
      n.status = "running";
      n.startedAt = new Date().toISOString();
    });
    this.emit("agentflow:task.started", {
      runId,
      taskId: node.id,
      originTool: node.originTool ?? live.snapshot.originTool,
      semanticRole: node.semanticRole ?? live.snapshot.semanticRole,
    });
    try {
      const result = await this.runner.run(runId, node, live.context, live.controller.signal);
      if (live.result) throw new DOMException("Run already settled", "AbortError");
      const snap = this.store.updateNode(runId, node.id, (n) => {
        n.status = "completed";
        n.completedAt = new Date().toISOString();
        n.resultPreview = preview(result.structured ?? result.text);
        n.sessionFile = result.sessionFile;
        n.usage = { ...result.usage };
      });
      const state = this.runtime.get(runId);
      if (!state) throw new DOMException("Run already settled", "AbortError");
      const spent = snap.nodes.reduce((sum, n) => sum + n.usage.total, 0);
      if (state.limits.tokenBudget !== undefined && spent > state.limits.tokenBudget) {
        const error = new Error(`Token budget exceeded (${spent}/${state.limits.tokenBudget})`);
        live.controller.abort(error);
        throw error;
      }
      this.emit("agentflow:task.completed", {
        runId,
        taskId: node.id,
        originTool: node.originTool ?? live.snapshot.originTool,
        semanticRole: node.semanticRole ?? live.snapshot.semanticRole,
      });
      return {
        ok: true,
        output: result.text,
        structured: result.structured,
        aborted: false,
        sessionFile: result.sessionFile,
        usage: { ...result.usage },
      };
    } catch (error) {
      if (!live.result) {
        this.store.updateNode(runId, node.id, (n) => {
          n.status = live.controller.signal.aborted || isAbort(error) ? "aborted" : "failed";
          n.completedAt = new Date().toISOString();
          n.error = errorText(error);
        });
        this.emit("agentflow:task.failed", {
          runId,
          taskId: node.id,
          originTool: node.originTool ?? live.snapshot.originTool,
          semanticRole: node.semanticRole ?? live.snapshot.semanticRole,
          error: errorText(error),
        });
      }
      const snapshot = this.store.get(runId);
      return {
        ok: false,
        output: "",
        error: errorText(error),
        aborted: live.controller.signal.aborted || isAbort(error),
        sessionFile: snapshot?.nodes.find((candidate) => candidate.id === node.id)?.sessionFile,
        usage: snapshot?.nodes.find((candidate) => candidate.id === node.id)?.usage ?? emptyUsage(),
      };
    } finally {
      release();
    }
  }
  finish(
    runId: string,
    status: RunSnapshot["status"],
    result?: unknown,
    error?: string,
  ): RunResult {
    const settlement = this.store.settle(
      runId,
      (snapshot) => {
        snapshot.status = status;
        snapshot.completedAt = new Date().toISOString();
        if (result !== undefined) snapshot.resultPreview = preview(result);
        if (error) snapshot.error = error;
        for (const node of snapshot.nodes)
          if (node.status === "queued" || node.status === "running") {
            node.status = status === "aborted" ? "aborted" : "failed";
            node.completedAt = snapshot.completedAt;
            node.error ??= error ?? `Run settled as ${status}`;
          }
      },
      (snapshot) => ({ runId, status, result, error, snapshot }),
    );
    if (!settlement.settled) return settlement.result;

    const state = this.runtime.get(runId);
    if (state?.deadline) clearTimeout(state.deadline);
    this.runtime.delete(runId);
    const final = settlement.result;
    void this.artifacts
      .finish(final)
      .catch((artifactError) =>
        this.emit("agentflow:artifact.error", { runId, error: errorText(artifactError) }),
      );
    this.emit(`agentflow:run.${status}`, final.snapshot);
    const live = this.store.getLive(runId);
    if (live?.snapshot.background && !live.consumed)
      live.deliveryTimer = setTimeout(() => this.flushBackgroundDeliveries(), 100);
    return final;
  }
  flushBackgroundDeliveries(): void {
    if (!this.deliver || !this.isParentIdle()) return;
    for (const snapshot of this.store.list().reverse()) {
      const live = this.store.getLive(snapshot.runId);
      const result = live?.result;
      if (!live || !result || !snapshot.background || live.consumed) continue;
      // Claim before calling out: re-entrant idle events and delivery failures
      // must never publish the same result twice.
      live.consumed = true;
      if (live.deliveryTimer) clearTimeout(live.deliveryTimer);
      live.deliveryTimer = undefined;
      try {
        this.deliver(
          `[agentflow background run ${result.runId} ${result.status}]\n${result.error ?? (preview(result.result) || "(no output)")}\n${snapshot.artifactDir ? `Artifacts: ${snapshot.artifactDir}` : ""}`,
          result,
        );
      } catch (error) {
        this.emit("agentflow:delivery.error", {
          runId: result.runId,
          error: errorText(error),
        });
      }
    }
  }
  getRunAbortSignal(runId: string): AbortSignal {
    const live = this.store.getLive(runId);
    if (!live) throw new Error(`Unknown run: ${runId}`);
    return live.controller.signal;
  }
  isRunAborted(runId: string): boolean {
    return this.getRunAbortSignal(runId).aborted;
  }
  async launchAgent(
    node: AgentNodeSpec,
    ctx: ExtensionContext,
    options: { background: boolean; signal?: AbortSignal; onUpdate?: Update },
  ): Promise<RunResult | { runId: string; snapshot: RunSnapshot }> {
    const runId = this.startRun(
      {
        kind: "agent",
        name: node.label,
        originTool: node.originTool,
        semanticRole: node.semanticRole,
        limits: { maxAgents: 1, concurrency: 1 },
        background: options.background,
      },
      ctx,
      options.background ? undefined : options.signal,
      options.onUpdate,
    );
    const work = this.runTask(runId, node).then((result) =>
      result.ok
        ? this.finish(runId, "completed", result.structured ?? result.output)
        : this.finish(runId, result.aborted ? "aborted" : "failed", undefined, result.error),
    );
    if (options.background) {
      void work;
      return { runId, snapshot: this.getSnapshot(runId) as RunSnapshot };
    }
    return work;
  }
  addPhase(runId: string, title: string): void {
    this.store.update(runId, (s) => {
      if (!s.phases.includes(title)) s.phases.push(title);
      s.currentPhase = title;
    });
  }
  log(runId: string, message: string): void {
    this.store.update(runId, (s) => {
      s.logs.push(message.slice(0, 2000));
      s.logs = s.logs.slice(-100);
    });
  }
  getLimits(runId: string) {
    const r = this.runtime.get(runId);
    if (!r) throw new Error(`Run is no longer active: ${runId}`);
    return r.limits;
  }
  list(): RunSnapshot[] {
    return this.store.list();
  }
  get(runId: string): RunSnapshot | undefined {
    return this.store.get(runId);
  }
  listRuns(): RunSnapshot[] {
    return this.list();
  }
  getRun(runId: string): RunSnapshot {
    const snapshot = this.get(runId);
    if (!snapshot) throw new Error(`Unknown run: ${runId}`);
    return snapshot;
  }
  subscribe(listener: ListUpdate): () => void {
    this.subscribers.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(listener);
    };
  }
  subscribeRun(runId: string, listener: Update): () => void {
    let listeners = this.runSubscribers.get(runId);
    if (!listeners) {
      listeners = new Set();
      this.runSubscribers.set(runId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners!.delete(listener);
      if (!listeners!.size) this.runSubscribers.delete(runId);
    };
  }
  private publish(snapshot: RunSnapshot): void {
    for (const listener of this.subscribers) {
      try {
        listener(this.list());
      } catch {
        // Observers cannot interrupt run lifecycle transitions.
      }
    }
    for (const listener of this.runSubscribers.get(snapshot.runId) ?? []) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        // Observers cannot interrupt run lifecycle transitions.
      }
    }
  }
  getSnapshot(runId?: string): RunSnapshot | RunSnapshot[] {
    return runId ? this.getRun(runId) : this.listRuns();
  }
  getResult(runId: string): RunResult | undefined {
    if (!this.store.get(runId)) throw new Error(`Unknown run: ${runId}`);
    return this.store.getResult(runId);
  }
  async wait(ids: string[], signal?: AbortSignal): Promise<RunResult[]> {
    return Promise.all(ids.map((id) => this.store.wait(id, signal)));
  }
  observeCompletion(runId: string): Promise<RunResult> {
    return this.store.wait(runId, undefined, false);
  }
  async abortAndWait(runId: string): Promise<boolean> {
    const live = this.store.getLive(runId);
    if (!live) return false;
    if (live.result) return true;
    // abort() can itself wait forever for an abort-insensitive provider/tool to
    // become idle, so bound session abort and task settlement together.
    const abort = this.store.abort(runId);
    const tasks = [...(this.runtime.get(runId)?.tasks ?? [])];
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled([abort, ...tasks]).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), TASK_SETTLE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut)
      this.emit("agentflow:tasks.settle_timeout", {
        runId,
        pendingTasks: this.runtime.get(runId)?.tasks.size ?? 0,
        timeoutMs: TASK_SETTLE_TIMEOUT_MS,
      });
    return true;
  }
  async cancel(ids: string[], consume = true): Promise<RunSnapshot[]> {
    const out: RunSnapshot[] = [];
    for (const id of ids) {
      if (consume) this.store.consume(id);
      if (!(await this.abortAndWait(id))) throw new Error(`Unknown run: ${id}`);
      if (!this.store.getResult(id)) this.finish(id, "aborted", undefined, "Cancelled");
      out.push(this.getSnapshot(id) as RunSnapshot);
    }
    return out;
  }
  async steer(runId: string, nodeId: string | undefined, message: string) {
    const live = this.store.getLive(runId);
    if (!live) throw new Error(`Unknown run: ${runId}`);
    let target = nodeId;
    if (!target) {
      const running = live.snapshot.nodes.filter(
        (n) => n.status === "running" && live.sessions.has(n.id),
      );
      if (running.length !== 1)
        throw new Error(
          running.length ? "Multiple tasks running; nodeId required" : "No running task",
        );
      target = running[0].id;
    }
    const session = live.sessions.get(target);
    if (!session?.isStreaming) throw new Error(`Task is not streaming: ${target}`);
    await session.steer(message);
    this.log(runId, `Steered ${target}: ${message}`);
    return { runId, nodeId: target, accepted: true as const };
  }
  async shutdown(): Promise<void> {
    const active = [...this.runtime.keys()];
    for (const snapshot of this.store.list()) this.store.consume(snapshot.runId);
    await Promise.allSettled(active.map((runId) => this.abortAndWait(runId)));
    for (const runId of active)
      if (!this.store.getResult(runId))
        this.finish(runId, "aborted", undefined, "Pi shutting down");
    for (const snapshot of this.store.list()) this.store.consume(snapshot.runId);
  }
}
