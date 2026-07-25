import { useSyncExternalStore } from "preact/compat";
import type {
  HistoryPageCommand,
  ServerMessage,
  SessionState,
  StatePatch,
} from "../shared/wire.js";
import { BrowserHistoryStore, type BrowserHistorySnapshot } from "./history-store.js";

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
  readonly history = new BrowserHistoryStore();

  getSnapshot = (): BrowserSessionSnapshot => this.snapshotValue;
  getHistorySnapshot = (): BrowserHistorySnapshot => this.history.getSnapshot();
  subscribeHistory = (listener: () => void): (() => void) => this.history.subscribe(listener);

  requestOlderHistory(commandId: string): HistoryPageCommand | undefined {
    const generation = this.snapshotValue.generation;
    if (!generation || this.snapshotValue.needsResync) return undefined;
    return this.history.beginOlderRequest(commandId, generation);
  }

  failOlderHistory(commandId: string, error: string): boolean {
    const generation = this.snapshotValue.generation;
    return generation ? this.history.failOlderRequest(commandId, generation, error) : false;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  apply(message: ServerMessage): "applied" | "ignored" | "resync" {
    if (message.type === "ready") {
      if (this.snapshotValue.generation && this.snapshotValue.generation !== message.generation) {
        this.history.clear();
        this.replace({ generation: message.generation, revision: 0, needsResync: true });
        return "resync";
      }
      return this.history.cancelPending() ? "applied" : "ignored";
    }
    if (message.type === "snapshot") {
      if (
        this.snapshotValue.needsResync &&
        this.snapshotValue.generation &&
        this.snapshotValue.generation !== message.generation
      ) {
        return "ignored";
      }
      if (this.snapshotValue.generation && this.snapshotValue.generation !== message.generation) {
        this.history.reset(message.state.persisted);
      } else {
        this.history.installTail(message.state.persisted);
      }
      this.replace({
        generation: message.generation,
        revision: message.revision,
        state: message.state,
        needsResync: false,
      });
      return "applied";
    }
    if (message.type === "history_page") {
      return this.history.applyPage(message);
    }
    if (
      message.type === "command_response" &&
      message.command === "history_page" &&
      message.commandId &&
      !message.accepted
    ) {
      return this.history.failOlderRequest(
        message.commandId,
        message.generation,
        message.error ?? "Unable to load earlier history",
      )
        ? "applied"
        : "ignored";
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
      if (message.patch.persisted) this.history.installTail(message.patch.persisted);
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

export function useBrowserHistory(store: BrowserSessionStore): BrowserHistorySnapshot {
  return useSyncExternalStore(store.subscribeHistory, store.getHistorySnapshot);
}
