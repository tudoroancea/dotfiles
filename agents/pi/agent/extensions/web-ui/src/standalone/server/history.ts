import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  HistoryPageEnvelope,
  HistoryRequest,
  PersistedEntry,
} from "@dotfiles/pi-web-ui-client/wire";

const PAGE_ENTRIES = 100;
const PAGE_BYTES = 512 * 1024;
const CURSOR_BYTES = 1024;
const OMITTED_REASON = "Entry omitted because its projected form exceeds the history page limit";

interface CursorPayload {
  lineage: string;
  index: number;
  boundary: string;
}

export interface PreparedHistory {
  initialWindow(maxEntries: number, maxBytes: number): HistoryWindow;
  commit(): void;
}

interface HistoryWindow {
  historyGeneration: string;
  entries: PersistedEntry[];
  beforeCursor: string | null;
  hasMore: boolean;
}

export class HistoryJournal {
  private readonly key = randomBytes(32);
  private lineage = randomBytes(18).toString("base64url");
  private entries: readonly PersistedEntry[] = [];
  private readonly entryBytes = new WeakMap<PersistedEntry, number>();
  private readonly boundedEntries = new WeakMap<PersistedEntry, PersistedEntry>();

  prepareReplace(entries: readonly PersistedEntry[]): PreparedHistory {
    const lineage = randomBytes(18).toString("base64url");
    return {
      initialWindow: (maxEntries, maxBytes) => this.window(entries, lineage, maxEntries, maxBytes),
      commit: () => {
        this.entries = entries;
        this.lineage = lineage;
      },
    };
  }

  replace(entries: readonly PersistedEntry[]): void {
    this.prepareReplace(entries).commit();
  }

  append(entries: readonly PersistedEntry[]): void {
    this.entries = entries;
  }

  initialWindow(maxEntries: number, maxBytes: number): HistoryWindow {
    return this.window(this.entries, this.lineage, maxEntries, maxBytes);
  }

  page(request: HistoryRequest, generation: string, revision: number): HistoryPageEnvelope {
    if (request.historyGeneration !== this.lineage) {
      throw new Error("History generation is invalid or stale; reconnect for a fresh snapshot");
    }
    const before = this.decode(request.beforeCursor);
    if (before >= this.entries.length || this.entries[before]?.id !== request.beforeId) {
      throw new Error("History cursor does not match the requested boundary");
    }

    let start = Math.max(0, before - Math.min(PAGE_ENTRIES, request.limit));
    let entries = this.entries.slice(start, before).map((entry) => this.boundedEntry(entry));
    let page = this.envelope(generation, revision, request.beforeId, entries, start);
    while (entries.length > 1 && Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES) {
      start += 1;
      entries = entries.slice(1);
      page = this.envelope(generation, revision, request.beforeId, entries, start);
    }
    if (Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES) {
      entries = [omission(entries[0] ?? this.entries[before - 1])];
      start = before - 1;
      page = this.envelope(generation, revision, request.beforeId, entries, start);
    }
    if (Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES) {
      throw new Error("Unable to construct a bounded history page");
    }
    return page;
  }

  private window(
    entries: readonly PersistedEntry[],
    lineage: string,
    maxEntries: number,
    maxBytes: number,
  ): HistoryWindow {
    let start = Math.max(0, entries.length - maxEntries);
    let selected = entries.slice(start).map((entry) => this.boundedEntry(entry));
    let selectedBytes = arrayBytes(selected.map((entry) => this.serializedBytes(entry)));
    while (selected.length > 1 && selectedBytes > maxBytes) {
      selectedBytes -= this.serializedBytes(selected[0]) + 1;
      start += 1;
      selected = selected.slice(1);
    }
    const hasMore = start > 0;
    return {
      historyGeneration: lineage,
      entries: selected,
      beforeCursor: hasMore ? this.encode(start, entries, lineage) : null,
      hasMore,
    };
  }

  private envelope(
    generation: string,
    revision: number,
    beforeId: string,
    entries: PersistedEntry[],
    start: number,
  ): HistoryPageEnvelope {
    return {
      version: 1,
      type: "history-page",
      generation,
      revision,
      historyGeneration: this.lineage,
      beforeId,
      entries,
      nextCursor: start > 0 ? this.encode(start, this.entries, this.lineage) : null,
      hasMore: start > 0,
    };
  }

  private boundedEntry(entry: PersistedEntry): PersistedEntry {
    if (this.serializedBytes(entry) <= PAGE_BYTES / 2) return entry;
    let bounded = this.boundedEntries.get(entry);
    if (!bounded) {
      bounded = omission(entry);
      this.boundedEntries.set(entry, bounded);
    }
    return bounded;
  }

  private serializedBytes(entry: PersistedEntry): number {
    let bytes = this.entryBytes.get(entry);
    if (bytes !== undefined) return bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(entry));
    } catch {
      bytes = PAGE_BYTES;
    }
    this.entryBytes.set(entry, bytes);
    return bytes;
  }

  private boundary(index: number, entries: readonly PersistedEntry[], lineage: string): string {
    const id = entries[index]?.id;
    if (!id) throw new Error("Invalid history boundary");
    return createHash("sha256")
      .update(lineage)
      .update("\0")
      .update(String(index))
      .update("\0")
      .update(id)
      .digest("base64url");
  }

  private encode(index: number, entries: readonly PersistedEntry[], lineage: string): string {
    const body = Buffer.from(
      JSON.stringify({
        lineage,
        index,
        boundary: this.boundary(index, entries, lineage),
      } satisfies CursorPayload),
    ).toString("base64url");
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    const cursor = `${body}.${signature}`;
    if (Buffer.byteLength(cursor) > CURSOR_BYTES) throw new Error("History cursor is too large");
    return cursor;
  }

  private decode(cursor: string): number {
    try {
      if (Buffer.byteLength(cursor) > CURSOR_BYTES) throw new Error();
      const [body, signature, extra] = cursor.split(".");
      if (!body || !signature || extra !== undefined) throw new Error();
      const expected = createHmac("sha256", this.key).update(body).digest();
      const supplied = Buffer.from(signature, "base64url");
      if (
        supplied.toString("base64url") !== signature ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new Error();
      const decoded = Buffer.from(body, "base64url");
      if (decoded.toString("base64url") !== body) throw new Error();
      const payload = JSON.parse(decoded.toString("utf8")) as CursorPayload;
      if (
        payload.lineage !== this.lineage ||
        !Number.isSafeInteger(payload.index) ||
        payload.index <= 0 ||
        payload.index >= this.entries.length ||
        payload.boundary !== this.boundary(payload.index, this.entries, this.lineage)
      )
        throw new Error();
      return payload.index;
    } catch {
      throw new Error("History cursor is invalid or stale; reconnect for a fresh snapshot");
    }
  }
}

function arrayBytes(entries: readonly number[]): number {
  return 2 + entries.reduce((total, bytes, index) => total + bytes + (index > 0 ? 1 : 0), 0);
}

function omission(entry: PersistedEntry | undefined): PersistedEntry {
  return {
    id: entry?.id ?? "omitted-entry",
    payload: { omitted: true, reason: OMITTED_REASON },
  };
}
