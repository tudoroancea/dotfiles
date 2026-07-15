import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LiveRun, NodeSnapshot, RunResult, RunSnapshot } from "../types.ts";

const clone = <T>(value: T): T => structuredClone(value);

export class RunStore {
  private readonly runs = new Map<string, LiveRun>();
  private sequence = 0;
  constructor(private readonly retention = 50) {}

  allocateId(): string {
    return `af_${Date.now().toString(36)}_${(++this.sequence).toString(36)}`;
  }
  add(run: LiveRun): void {
    this.runs.set(run.snapshot.runId, run);
    this.prune();
  }
  getLive(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }
  get(runId: string): RunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? clone(run.snapshot) : undefined;
  }
  getResult(runId: string): RunResult | undefined {
    const result = this.runs.get(runId)?.result;
    return result ? clone(result) : undefined;
  }
  list(): RunSnapshot[] {
    return [...this.runs.values()].map((run) => clone(run.snapshot)).reverse();
  }
  update(runId: string, mutate: (snapshot: RunSnapshot) => void): RunSnapshot {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    // Terminal snapshots are immutable. Abort-insensitive providers may emit
    // late events after bounded cancellation has returned.
    if (run.result) return clone(run.snapshot);
    mutate(run.snapshot);
    const snapshot = clone(run.snapshot);
    try {
      run.notify?.(snapshot);
    } catch {
      // Observation must not break run lifecycle transitions.
    }
    return snapshot;
  }
  updateNode(runId: string, nodeId: string, mutate: (node: NodeSnapshot) => void): RunSnapshot {
    return this.update(runId, (snapshot) => {
      const node = snapshot.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`Unknown node ${nodeId} in run ${runId}`);
      mutate(node);
    });
  }
  attachSession(runId: string, nodeId: string, session: AgentSession): boolean {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.result) return false;
    run.sessions.set(nodeId, session);
    return true;
  }
  detachSession(runId: string, nodeId: string): void {
    this.runs.get(runId)?.sessions.delete(nodeId);
  }
  settle(
    runId: string,
    mutate: (snapshot: RunSnapshot) => void,
    createResult: (snapshot: RunSnapshot) => RunResult,
  ): { result: RunResult; settled: boolean } {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.result) return { result: clone(run.result), settled: false };

    // Publish the terminal result before notifying observers. This makes
    // settlement first-writer-wins even if a notification synchronously
    // re-enters RunEngine.finish().
    mutate(run.snapshot);
    const snapshot = clone(run.snapshot);
    const result = createResult(snapshot);
    run.result = result;
    run.context = undefined;
    run.sessions.clear();
    run.resolveCompletion(result);
    try {
      run.notify?.(snapshot);
    } catch {
      // The terminal result is already published; observer failures are isolated.
    }
    this.prune();
    return { result: clone(result), settled: true };
  }
  consume(runId: string): void {
    const run = this.runs.get(runId);
    if (run) {
      run.consumed = true;
      if (run.deliveryTimer) clearTimeout(run.deliveryTimer);
    }
  }
  async wait(runId: string, signal?: AbortSignal, consume = true): Promise<RunResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (consume) this.consume(runId);
    if (run.result) return run.result;
    if (!signal) return run.completion;
    if (signal.aborted) throw new DOMException("Wait aborted", "AbortError");
    return Promise.race([
      run.completion,
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Wait aborted", "AbortError")),
          { once: true },
        ),
      ),
    ]);
  }
  async abort(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.controller.abort();
    await Promise.allSettled([...run.sessions.values()].map((session) => session.abort()));
    return true;
  }
  async abortAll(): Promise<void> {
    await Promise.allSettled([...this.runs.keys()].map((id) => this.abort(id)));
  }
  private prune(): void {
    const settled = [...this.runs.values()]
      .filter((r) => r.result)
      .sort((a, b) => a.snapshot.createdAt.localeCompare(b.snapshot.createdAt));
    while (this.runs.size > this.retention && settled.length)
      this.runs.delete(settled.shift()!.snapshot.runId);
  }
}
