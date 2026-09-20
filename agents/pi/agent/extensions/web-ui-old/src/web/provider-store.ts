import { useSyncExternalStore } from "preact/compat";
import type { ProviderMessage } from "../shared/wire.js";

export interface ProviderState {
  agentflow?: { generation: string; revision: number; data: unknown };
  background?: { generation: string; revision: number; data: unknown };
}

function mergeBackgroundTails(current: unknown, next: unknown): unknown {
  if (!current || !next || typeof current !== "object" || typeof next !== "object") return next;
  const oldJobs = Array.isArray((current as { jobs?: unknown }).jobs)
    ? (current as { jobs: unknown[] }).jobs
    : [];
  const nextRecord = next as { jobs?: unknown[] };
  if (!Array.isArray(nextRecord.jobs)) return next;
  const byId = new Map(
    oldJobs
      .filter((job): job is Record<string, unknown> => Boolean(job) && typeof job === "object")
      .map((job) => [job.jobId, job]),
  );
  return {
    ...(next as Record<string, unknown>),
    jobs: nextRecord.jobs.map((candidate) => {
      if (!candidate || typeof candidate !== "object") return candidate;
      const job = candidate as Record<string, unknown>;
      const previous = byId.get(job.jobId);
      if (!previous || job.tail !== undefined) return job;
      return {
        ...job,
        ...(previous.tail !== undefined ? { tail: previous.tail } : {}),
        ...(previous.tailTruncated !== undefined ? { tailTruncated: previous.tailTruncated } : {}),
      };
    }),
  };
}

export class BrowserProviderStore {
  private state: ProviderState = {};
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  apply(message: ProviderMessage): void {
    const current = this.state[message.provider];
    if (current && current.generation === message.generation && message.revision < current.revision)
      return;
    const data =
      message.provider === "background" && current?.generation === message.generation
        ? mergeBackgroundTails(current.data, message.data)
        : message.data;
    const next = { generation: message.generation, revision: message.revision, data };
    this.state = { ...this.state, [message.provider]: next };
    for (const listener of this.listeners) listener();
  }
}

export function useProviders(store: BrowserProviderStore): ProviderState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
