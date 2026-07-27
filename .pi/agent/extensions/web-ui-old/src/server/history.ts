import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "../shared/limits.js";
import { PROTOCOL_VERSION } from "../shared/wire.js";
import type {
  HistoryPageCommand,
  HistoryPageMessage,
  PersistedEntry,
  PersistedState,
} from "../shared/wire.js";
import { projectPersistedEntry } from "./projection.js";

interface CursorPayload {
  g: string;
  i: number;
  b: string;
}

export interface HistoryPageCore {
  historyGeneration: string;
  entries: PersistedEntry[];
  hasOlder: boolean;
  olderCursor?: string;
}

export type HistoryPageByteMeasure = (page: HistoryPageCore) => number;

const INVALID_CURSOR = "History cursor is invalid or stale; request a fresh snapshot";
const OMITTED_REASON = "Entry omitted because its projected form exceeds the history page limit";

function rawId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function rawParentId(value: unknown): string | null | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parentId = (value as { parentId?: unknown }).parentId;
  return typeof parentId === "string" ? parentId : parentId === null ? null : undefined;
}

function omission(value: unknown): PersistedEntry {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: String(record.id ?? "unprojectable").slice(0, 256),
    parentId: typeof record.parentId === "string" ? record.parentId.slice(0, 256) : null,
    timestamp: typeof record.timestamp === "string" ? record.timestamp.slice(0, 128) : "",
    entryType: typeof record.type === "string" ? record.type.slice(0, 128) : "unknown",
    payload: { omitted: true, reason: OMITTED_REASON },
  };
}

export class HistoryManager {
  private readonly key = randomBytes(32);
  private branch: readonly unknown[] = [];
  private ids: readonly (string | undefined)[] = [];
  private sessionId = "";
  private leafId: string | null = null;
  private historyGenerationValue = "";

  constructor(
    private readonly context: ExtensionContext,
    private readonly generation: string,
  ) {
    this.refresh(true);
  }

  get historyGeneration(): string {
    return this.historyGenerationValue;
  }

  rotate(): void {
    this.refresh(true);
  }

  refresh(forceRotate = false): void {
    const branch = this.context.sessionManager.getBranch();
    const sessionId = String(this.context.sessionManager.getSessionId()).slice(0, 256);
    const leafId = this.context.sessionManager.getLeafId();

    if (!forceRotate && this.isUnchanged(branch, sessionId, leafId)) return;
    if (!forceRotate && this.tryAppend(branch, sessionId, leafId)) return;

    this.historyGenerationValue = randomBytes(18).toString("base64url");
    this.branch = branch;
    this.ids = branch.map(rawId);
    this.sessionId = sessionId;
    this.leafId = leafId;
  }

  buildInitialPage(measureBytes: HistoryPageByteMeasure): HistoryPageCore {
    return this.collect(this.branch.length, measureBytes);
  }

  buildOlderPage(
    historyGeneration: string,
    cursor: string,
    measureBytes: HistoryPageByteMeasure,
  ): HistoryPageCore {
    if (historyGeneration !== this.historyGenerationValue) throw new Error(INVALID_CURSOR);
    return this.collect(this.decodeCursor(cursor), measureBytes);
  }

  window(): PersistedState {
    const result = this.buildInitialPage((page) =>
      Buffer.byteLength(
        JSON.stringify({
          sessionId: this.sessionId,
          leafId: this.leafId,
          ...page,
        }),
      ),
    );
    return {
      sessionId: this.sessionId,
      leafId: this.leafId,
      ...result,
    };
  }

  page(command: HistoryPageCommand, revision: number): HistoryPageMessage {
    const result = this.buildOlderPage(command.historyGeneration, command.cursor, (page) =>
      Buffer.byteLength(
        JSON.stringify({
          type: "history_page",
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          generation: this.generation,
          revision,
          ...page,
        }),
      ),
    );
    const message: HistoryPageMessage = {
      type: "history_page",
      protocolVersion: PROTOCOL_VERSION,
      commandId: command.commandId,
      generation: this.generation,
      historyGeneration: this.historyGenerationValue,
      revision,
      entries: result.entries,
      hasOlder: result.hasOlder,
      ...(result.olderCursor ? { olderCursor: result.olderCursor } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(message)) > LIMITS.historyPageBytes) {
      throw new Error("Unable to construct a bounded history page");
    }
    return message;
  }

  private collect(before: number, measureBytes: HistoryPageByteMeasure): HistoryPageCore {
    const newestFirst: PersistedEntry[] = [];
    const measuredSize = (entries: PersistedEntry[], hasOlder: boolean, olderCursor?: string) => {
      const size = measureBytes({
        historyGeneration: this.historyGenerationValue,
        entries,
        hasOlder,
        ...(olderCursor ? { olderCursor } : {}),
      });
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("History page byte measure must return a non-negative safe integer");
      }
      return size;
    };
    let index = before - 1;
    while (index >= 0 && newestFirst.length < LIMITS.historyPageEntries) {
      const projected = projectPersistedEntry(this.branch[index]) ?? omission(this.branch[index]);
      const candidate = [projected, ...newestFirst];
      const nextIndex = index;
      const candidateCursor = nextIndex > 0 ? this.encodeCursor(nextIndex) : undefined;
      if (measuredSize(candidate, nextIndex > 0, candidateCursor) <= LIMITS.historyPageBytes) {
        newestFirst.unshift(projected);
        index -= 1;
        continue;
      }
      if (newestFirst.length > 0) break;
      const boundedOmission = omission(this.branch[index]);
      const omissionCursor = nextIndex > 0 ? this.encodeCursor(nextIndex) : undefined;
      if (
        measuredSize([boundedOmission], nextIndex > 0, omissionCursor) > LIMITS.historyPageBytes
      ) {
        throw new Error("Unable to construct a bounded history omission");
      }
      newestFirst.unshift(boundedOmission);
      index -= 1;
      break;
    }
    const hasOlder = index >= 0;
    const olderCursor = hasOlder ? this.encodeCursor(index + 1) : undefined;
    return {
      historyGeneration: this.historyGenerationValue,
      entries: newestFirst,
      hasOlder,
      ...(olderCursor ? { olderCursor } : {}),
    };
  }

  private isUnchanged(
    branch: readonly unknown[],
    sessionId: string,
    leafId: string | null,
  ): boolean {
    if (!this.historyGenerationValue || sessionId !== this.sessionId || leafId !== this.leafId) {
      return false;
    }
    if (branch.length !== this.branch.length) return false;
    if (branch.length === 0) return true;
    // SessionManager.getBranch() returns a fresh path array containing the same
    // immutable entry objects. Tree navigation and compaction explicitly call
    // rotate(), so an identical tail object proves the active path is unchanged.
    return branch.at(-1) === this.branch.at(-1);
  }

  private tryAppend(branch: readonly unknown[], sessionId: string, leafId: string | null): boolean {
    if (
      !this.historyGenerationValue ||
      sessionId !== this.sessionId ||
      branch.length <= this.branch.length ||
      (this.branch.length > 0 && branch[this.branch.length - 1] !== this.branch.at(-1))
    ) {
      return false;
    }

    const suffixIds: string[] = [];
    let parent = this.branch.length === 0 ? null : (this.ids.at(-1) ?? null);
    for (let index = this.branch.length; index < branch.length; index += 1) {
      const id = rawId(branch[index]);
      const parentId = rawParentId(branch[index]);
      if (!id || parentId !== parent) return false;
      suffixIds.push(id);
      parent = id;
    }
    if (leafId !== parent) return false;

    this.branch = branch;
    this.ids = [...this.ids, ...suffixIds];
    this.leafId = leafId;
    return true;
  }

  private boundary(index: number): string | undefined {
    const id = this.ids[index - 1];
    return id
      ? createHash("sha256").update(String(index)).update("\0").update(id).digest("base64url")
      : undefined;
  }

  private encodeCursor(index: number): string {
    const boundary = this.boundary(index);
    if (!boundary) throw new Error("Cannot create a cursor for an invalid history boundary");
    const body = Buffer.from(
      JSON.stringify({
        g: this.historyGenerationValue,
        i: index,
        b: boundary,
      } satisfies CursorPayload),
    ).toString("base64url");
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    const cursor = `${body}.${signature}`;
    if (Buffer.byteLength(cursor) > LIMITS.historyCursorBytes) {
      throw new Error("History cursor exceeds its byte limit");
    }
    return cursor;
  }

  private decodeCursor(cursor: string): number {
    try {
      if (Buffer.byteLength(cursor) > LIMITS.historyCursorBytes) throw new Error();
      const [body, signature, extra] = cursor.split(".");
      if (!body || !signature || extra !== undefined) throw new Error();
      const decodedBody = Buffer.from(body, "base64url");
      if (decodedBody.toString("base64url") !== body) throw new Error();
      const expected = createHmac("sha256", this.key).update(body).digest();
      const supplied = Buffer.from(signature, "base64url");
      if (
        supplied.toString("base64url") !== signature ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        throw new Error();
      }
      const payload = JSON.parse(decodedBody.toString("utf8")) as CursorPayload;
      if (
        !payload ||
        payload.g !== this.historyGenerationValue ||
        !Number.isSafeInteger(payload.i) ||
        payload.i <= 0 ||
        payload.i > this.branch.length ||
        typeof payload.b !== "string" ||
        this.boundary(payload.i) !== payload.b
      ) {
        throw new Error();
      }
      return payload.i;
    } catch {
      throw new Error(INVALID_CURSOR);
    }
  }
}
