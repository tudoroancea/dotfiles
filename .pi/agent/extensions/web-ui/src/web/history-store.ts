import type {
  HistoryPageCommand,
  HistoryPageMessage,
  PersistedEntry,
  PersistedState,
} from "../shared/wire.js";

export interface BrowserHistorySnapshot {
  historyGeneration?: string | undefined;
  length: number;
  version: number;
  hasOlder: boolean;
  olderCursor?: string | undefined;
  loadingOlder: boolean;
  error?: string | undefined;
}

interface PendingHistoryRequest {
  commandId: string;
  generation: string;
  historyGeneration: string;
  cursor: string;
}

export class BrowserHistoryStore {
  private chunks: readonly (readonly PersistedEntry[])[] = [];
  private prefixEnds: readonly number[] = [];
  private entryIds = new Set<string>();
  private loadedOlder = false;
  private snapshotValue: BrowserHistorySnapshot = {
    length: 0,
    version: 0,
    hasOlder: false,
    loadingOlder: false,
  };
  private pending: PendingHistoryRequest | undefined;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): BrowserHistorySnapshot => this.snapshotValue;

  get length(): number {
    return this.snapshotValue.length;
  }

  at(index: number): PersistedEntry | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    let low = 0;
    let high = this.prefixEnds.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (index < this.prefixEnds[middle]!) high = middle;
      else low = middle + 1;
    }
    const start = low === 0 ? 0 : this.prefixEnds[low - 1]!;
    return this.chunks[low]?.[index - start];
  }

  toArray(): PersistedEntry[] {
    return this.chunks.flatMap((chunk) => [...chunk]);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.chunks = [];
    this.prefixEnds = [];
    this.entryIds = new Set();
    this.loadedOlder = false;
    this.pending = undefined;
    this.publish({
      length: 0,
      version: this.snapshotValue.version + 1,
      hasOlder: false,
      loadingOlder: false,
    });
  }

  cancelPending(): boolean {
    if (!this.pending) return false;
    this.pending = undefined;
    this.publish({
      ...this.snapshotValue,
      loadingOlder: false,
      ...(this.snapshotValue.error ? { error: undefined } : {}),
    });
    return true;
  }

  installTail(persisted: PersistedState): "reset" | "merged" | "unchanged" {
    if (this.snapshotValue.historyGeneration !== persisted.historyGeneration) {
      this.reset(persisted);
      return "reset";
    }

    const additions = this.unique(persisted.entries);
    if (additions.length > 0) {
      this.chunks = [...this.chunks, additions];
      this.reindex();
    }

    const hasPagingState = this.loadedOlder || this.pending !== undefined;
    const hasOlder = hasPagingState ? this.snapshotValue.hasOlder : persisted.hasOlder;
    const olderCursor = hasPagingState ? this.snapshotValue.olderCursor : persisted.olderCursor;
    if (
      additions.length === 0 &&
      hasOlder === this.snapshotValue.hasOlder &&
      olderCursor === this.snapshotValue.olderCursor
    ) {
      return "unchanged";
    }
    this.publish({
      ...this.snapshotValue,
      length: this.totalLength(),
      version: this.snapshotValue.version + 1,
      hasOlder,
      ...(olderCursor ? { olderCursor } : { olderCursor: undefined }),
    });
    return "merged";
  }

  beginOlderRequest(commandId: string, generation: string): HistoryPageCommand | undefined {
    const { historyGeneration, olderCursor, hasOlder } = this.snapshotValue;
    if (this.pending || !hasOlder || !historyGeneration || !olderCursor) return undefined;
    this.pending = { commandId, generation, historyGeneration, cursor: olderCursor };
    this.publish({
      ...this.snapshotValue,
      loadingOlder: true,
      ...(this.snapshotValue.error ? { error: undefined } : {}),
    });
    return {
      type: "history_page",
      commandId,
      generation,
      historyGeneration,
      cursor: olderCursor,
    };
  }

  failOlderRequest(commandId: string, generation: string, error: string): boolean {
    if (
      !this.pending ||
      this.pending.commandId !== commandId ||
      this.pending.generation !== generation
    ) {
      return false;
    }
    this.pending = undefined;
    this.publish({ ...this.snapshotValue, loadingOlder: false, error });
    return true;
  }

  applyPage(message: HistoryPageMessage): "applied" | "ignored" {
    const pending = this.pending;
    if (
      !pending ||
      message.commandId !== pending.commandId ||
      message.generation !== pending.generation ||
      message.historyGeneration !== pending.historyGeneration ||
      message.historyGeneration !== this.snapshotValue.historyGeneration ||
      pending.cursor !== this.snapshotValue.olderCursor
    ) {
      return "ignored";
    }

    this.pending = undefined;
    this.loadedOlder = true;
    const older = this.unique(message.entries);
    if (older.length > 0) {
      this.chunks = [older, ...this.chunks];
      this.reindex();
    }
    this.publish({
      historyGeneration: message.historyGeneration,
      length: this.totalLength(),
      version: this.snapshotValue.version + 1,
      hasOlder: message.hasOlder,
      ...(message.olderCursor ? { olderCursor: message.olderCursor } : {}),
      loadingOlder: false,
    });
    return "applied";
  }

  reset(persisted: PersistedState): void {
    const tail = this.deduplicate(persisted.entries);
    this.chunks = tail.length > 0 ? [tail] : [];
    this.reindex();
    this.entryIds = new Set(tail.map((entry) => entry.id));
    this.loadedOlder = false;
    this.pending = undefined;
    this.publish({
      historyGeneration: persisted.historyGeneration,
      length: tail.length,
      version: this.snapshotValue.version + 1,
      hasOlder: persisted.hasOlder,
      ...(persisted.olderCursor ? { olderCursor: persisted.olderCursor } : {}),
      loadingOlder: false,
    });
  }

  private totalLength(): number {
    return this.prefixEnds.at(-1) ?? 0;
  }

  private reindex(): void {
    let total = 0;
    this.prefixEnds = this.chunks.map((chunk) => (total += chunk.length));
  }

  private deduplicate(entries: readonly PersistedEntry[]): PersistedEntry[] {
    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }

  private unique(entries: readonly PersistedEntry[]): PersistedEntry[] {
    const additions: PersistedEntry[] = [];
    for (const entry of entries) {
      if (this.entryIds.has(entry.id)) continue;
      this.entryIds.add(entry.id);
      additions.push(entry);
    }
    return additions;
  }

  private publish(snapshot: BrowserHistorySnapshot): void {
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) listener();
  }
}
