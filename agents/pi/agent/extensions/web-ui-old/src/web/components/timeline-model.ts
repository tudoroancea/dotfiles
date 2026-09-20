import type { PersistedEntry, ProjectedMessage, ToolExecution } from "../../shared/wire.js";
import { asArray, asRecord } from "../lib/tool-model.js";

const INTERNAL_CUSTOM_TYPE = "web-ui-startup";

export interface PersistedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Indexes derived in one pass whenever the persisted history version changes. */
export interface PersistedTimelineIndex {
  /** BrowserHistoryStore indexes for rows that actually render. */
  visibleIndexes: number[];
  messages: Set<string>;
  toolResults: Set<string>;
  toolCalls: Map<string, PersistedToolCall>;
}

/** A single logical live-overlay row: a message, a tool panel, or the partial tail. */
export interface LiveRow {
  key: string;
  message?: ProjectedMessage;
  partial?: boolean;
  tool?: ToolExecution;
}

/** Stable identity for a projected message, matching the server's message key. */
export function messageIdentity(message: ProjectedMessage): string {
  return [
    message.role,
    message.timestamp ?? "",
    message.toolCallId ?? "",
    message.customType ?? "",
  ].join(":");
}

/** Whether an entry contributes a visible transcript row. */
export function isRenderableEntry(entry: PersistedEntry): boolean {
  const payload = asRecord(entry.payload);
  if (entry.entryType === "custom" || entry.entryType === "web-ui-startup") return false;
  if (payload.customType === INTERNAL_CUSTOM_TYPE || payload.display === false) return false;
  return true;
}

/** The canonical virtual-row identity shared by live and persisted tool results. */
export function persistedRowKey(entry: PersistedEntry): string {
  if (entry.entryType === "message") {
    const message = asRecord(asRecord(entry.payload).message);
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      return `tool:${message.toolCallId}`;
    }
  }
  return `entry:${entry.id}`;
}

function messageToolIds(message: ProjectedMessage): string[] {
  return asArray(message.content)
    .map(asRecord)
    .filter((block) => block.type === "toolCall" && typeof block.id === "string")
    .map((block) => block.id as string);
}

/**
 * Builds all persisted-history indexes in one pass. This scan is intentionally
 * tied to history version changes, never live token updates.
 */
export function indexPersistedTimeline(entries: Iterable<PersistedEntry>): PersistedTimelineIndex {
  const visibleIndexes: number[] = [];
  const messages = new Set<string>();
  const toolResults = new Set<string>();
  const toolCalls = new Map<string, PersistedToolCall>();
  let index = 0;

  for (const entry of entries) {
    if (isRenderableEntry(entry)) visibleIndexes.push(index);
    index += 1;
    if (entry.entryType !== "message") continue;

    const message = asRecord(asRecord(entry.payload).message) as ProjectedMessage;
    messages.add(messageIdentity(message));
    if (message.role === "toolResult" && message.toolCallId) toolResults.add(message.toolCallId);
    if (message.role !== "assistant") continue;
    for (const block of asArray(message.content)) {
      const call = asRecord(block);
      if (call.type !== "toolCall" || typeof call.id !== "string") continue;
      toolCalls.set(call.id, {
        name: typeof call.name === "string" ? call.name : "tool",
        args: asRecord(call.arguments),
      });
    }
  }
  return { visibleIndexes, messages, toolResults, toolCalls };
}

/** Builds only the persisted tool-call index for non-timeline callers/tests. */
export function indexToolCalls(entries: Iterable<PersistedEntry>): Map<string, PersistedToolCall> {
  return indexPersistedTimeline(entries).toolCalls;
}

/** Collects persisted identities (retained as a compatibility helper). */
export function persistedTailState(entries: readonly PersistedEntry[]): {
  messages: Set<string>;
  toolResults: Set<string>;
} {
  const { messages, toolResults } = indexPersistedTimeline(entries);
  return { messages, toolResults };
}

/**
 * Flattens the live overlay into ordered rows with deterministic keys. Message
 * rows follow their assistant/user text, tool rows follow the message that
 * invoked them, and any orphaned tools trail the partial tail.
 */
export function buildLiveRows(
  messages: readonly ProjectedMessage[],
  partial: ProjectedMessage | undefined,
  tools: readonly ToolExecution[],
): LiveRow[] {
  const byId = new Map(tools.map((tool) => [tool.toolCallId, tool]));
  const rendered = new Set<string>();
  const rows: LiveRow[] = [];
  const seen = new Map<string, number>();

  const messageKey = (message: ProjectedMessage): string => {
    const base = `live-message:${messageIdentity(message)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  };
  const emitTools = (message: ProjectedMessage): void => {
    for (const id of messageToolIds(message)) {
      const tool = byId.get(id);
      if (!tool) continue;
      rendered.add(tool.toolCallId);
      rows.push({ key: `tool:${tool.toolCallId}`, tool });
    }
  };

  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId && byId.has(message.toolCallId)) {
      continue;
    }
    rows.push({ key: messageKey(message), message });
    emitTools(message);
  }
  if (partial) {
    rows.push({ key: "partial-assistant", message: partial, partial: true });
    emitTools(partial);
  }
  for (const tool of tools) {
    if (rendered.has(tool.toolCallId)) continue;
    rows.push({ key: `tool:${tool.toolCallId}`, tool });
  }
  return rows;
}

// ---- Scroll anchoring helpers ----------------------------------------------

export interface RowSpan {
  key: string | number | bigint;
  start: number;
  end: number;
}

export interface TopAnchor {
  key: string;
  /** Offset of the anchor row's top relative to the viewport top (may be < 0). */
  delta: number;
}

/**
 * Captures the first row crossing the top edge of the viewport so it can be
 * restored to the same visual position after older entries are prepended.
 */
export function captureTopAnchor(
  items: readonly RowSpan[],
  scrollOffset: number,
): TopAnchor | undefined {
  const transcript = items.filter((item) => item.key !== "load" && item.key !== "intro");
  for (const item of transcript) {
    if (item.end > scrollOffset) return { key: String(item.key), delta: item.start - scrollOffset };
  }
  const last = transcript.at(-1);
  return last ? { key: String(last.key), delta: last.start - scrollOffset } : undefined;
}

/** Finds the measured top offset of a row by its stable key, if present. */
export function findRowStart(measurements: readonly RowSpan[], key: string): number | undefined {
  for (const measurement of measurements) {
    if (String(measurement.key) === key) return measurement.start;
  }
  return undefined;
}

/** The scroll offset that keeps the anchor row at its captured viewport position. */
export function anchorScrollOffset(start: number, delta: number): number {
  return Math.max(0, start - delta);
}

/** Pixels between the current scroll position and the bottom of the content. */
export function distanceFromBottom(element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}
