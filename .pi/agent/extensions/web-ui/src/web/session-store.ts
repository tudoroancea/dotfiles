import { useSyncExternalStore } from "preact/compat";
import type { ServerMessage, SessionState, StatePatch } from "../shared/wire.js";

export interface BrowserSessionSnapshot {
  generation?: string;
  revision: number;
  state?: SessionState;
  needsResync: boolean;
}

function applyPatch(state: SessionState, patch: StatePatch): SessionState {
  return {
    persisted: patch.persisted ?? state.persisted,
    live: patch.live ?? state.live,
    metadata: patch.metadata ?? state.metadata,
  };
}

export class BrowserSessionStore {
  private snapshotValue: BrowserSessionSnapshot = { revision: 0, needsResync: false };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): BrowserSessionSnapshot => this.snapshotValue;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  apply(message: ServerMessage): "applied" | "ignored" | "resync" {
    if (message.type === "ready") {
      if (this.snapshotValue.generation && this.snapshotValue.generation !== message.generation) {
        this.replace({ generation: message.generation, revision: 0, needsResync: true });
        return "resync";
      }
      return "ignored";
    }
    if (message.type === "snapshot") {
      this.replace({
        generation: message.generation,
        revision: message.revision,
        state: message.state,
        needsResync: false,
      });
      return "applied";
    }
    if (message.type === "state_update") {
      if (this.snapshotValue.needsResync) return "ignored";
      if (
        !this.snapshotValue.state ||
        this.snapshotValue.generation !== message.generation ||
        this.snapshotValue.revision !== message.baseRevision
      ) {
        this.replace({ ...this.snapshotValue, needsResync: true });
        return "resync";
      }
      this.replace({
        generation: message.generation,
        revision: message.revision,
        state: applyPatch(this.snapshotValue.state, message.patch),
        needsResync: false,
      });
      return "applied";
    }
    if (message.type === "resync_required") {
      if (this.snapshotValue.needsResync) return "ignored";
      this.replace({ ...this.snapshotValue, needsResync: true });
      return "resync";
    }
    return "ignored";
  }

  private replace(snapshot: BrowserSessionSnapshot): void {
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function useBrowserSession(store: BrowserSessionStore): BrowserSessionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
