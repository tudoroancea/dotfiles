import type { LiveEntry, PersistedEntry } from "../wire/protocol.ts";

export interface TranscriptRow {
  key: string;
  id: string;
  payload: unknown;
}

export interface ToolResults {
  get(toolCallId: string): Record<string, unknown> | undefined;
}

export type TranscriptIndexUpdateKind = "initial" | "append" | "prepend" | "rebuild" | "unchanged";

export interface TranscriptIndexStats {
  kind: TranscriptIndexUpdateKind;
  inspectedEntries: number;
}

export interface TranscriptIndexSnapshot {
  rows: readonly TranscriptRow[];
  toolResults: ToolResults;
  stats: TranscriptIndexStats;
}

export interface TranscriptIndexInstrumentation {
  inspect?: (entry: PersistedEntry | LiveEntry) => void;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// This must stay a superset of the non-null branches in Entry. Tool-result
// messages deliberately remain absent because they are folded into tool calls.
function rendersRow(payload: unknown, showSwitches: boolean): boolean {
  const entry = object(payload);
  switch (entry.type) {
    case "message": {
      const role = object(entry.message).role;
      return role === "user" || role === "assistant" || role === "bashExecution";
    }
    case "model_change":
    case "thinking_level_change":
      return showSwitches;
    case "compaction":
    case "branch_summary":
      return true;
    case "custom_message":
      return Boolean(entry.display);
    default:
      return false;
  }
}

function inspectEntries(
  entries: readonly (PersistedEntry | LiveEntry)[],
  prefix: "p" | "l",
  showSwitches: boolean,
  instrumentation: TranscriptIndexInstrumentation,
): { rows: TranscriptRow[]; toolResults: Map<string, Record<string, unknown>> } {
  const rows: TranscriptRow[] = [];
  const results = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    instrumentation.inspect?.(entry);
    const payload = object(entry.payload);
    const message = object(payload.message);
    if (
      payload.type === "message" &&
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      message.toolCallId
    ) {
      results.set(message.toolCallId, message);
    }
    if (rendersRow(entry.payload, showSwitches)) {
      rows.push({ key: `${prefix}:${entry.id}`, id: entry.id, payload: entry.payload });
    }
  }
  return { rows, toolResults: results };
}

/** Fully scans an independently bounded entry list, used for liveTail. */
export function indexBoundedTranscript(
  entries: readonly (PersistedEntry | LiveEntry)[],
  prefix: "p" | "l",
  showSwitches: boolean,
  instrumentation: TranscriptIndexInstrumentation = {},
): TranscriptIndexSnapshot {
  const indexed = inspectEntries(entries, prefix, showSwitches, instrumentation);
  return {
    rows: indexed.rows,
    toolResults: indexed.toolResults,
    stats: { kind: "rebuild", inspectedEntries: entries.length },
  };
}

/**
 * Incremental visible-row and tool-result index for persisted transcript entries.
 *
 * Session-state append/prepend reducers preserve retained entry object identities.
 * Checking both retained boundaries therefore distinguishes those two transitions
 * without walking retained history. Resets and replacements have new boundaries
 * and take the safe rebuild path.
 */
export class PersistedTranscriptIndex {
  readonly #instrumentation: TranscriptIndexInstrumentation;
  #entries: readonly PersistedEntry[] | undefined;
  #showSwitches = false;
  #rows: readonly TranscriptRow[] = [];
  #toolResults = new Map<string, Record<string, unknown>>();

  constructor(instrumentation: TranscriptIndexInstrumentation = {}) {
    this.#instrumentation = instrumentation;
  }

  update(
    entries: readonly PersistedEntry[],
    showSwitches: boolean,
    options: { reset?: boolean } = {},
  ): TranscriptIndexSnapshot {
    const previous = this.#entries;
    if (!options.reset && previous === entries && this.#showSwitches === showSwitches) {
      return this.#snapshot("unchanged", 0);
    }

    if (!options.reset && previous && this.#showSwitches === showSwitches) {
      const growth = entries.length - previous.length;
      if (
        growth > 0 &&
        previous.length > 0 &&
        entries[0] === previous[0] &&
        entries[previous.length - 1] === previous[previous.length - 1]
      ) {
        const delta = entries.slice(previous.length);
        const indexed = inspectEntries(delta, "p", showSwitches, this.#instrumentation);
        for (const [id, result] of indexed.toolResults) this.#toolResults.set(id, result);
        this.#rows = [...this.#rows, ...indexed.rows];
        this.#entries = entries;
        return this.#snapshot("append", delta.length);
      }
      if (
        growth > 0 &&
        previous.length > 0 &&
        entries[growth] === previous[0] &&
        entries[entries.length - 1] === previous[previous.length - 1]
      ) {
        const delta = entries.slice(0, growth);
        const indexed = inspectEntries(delta, "p", showSwitches, this.#instrumentation);
        // A newer retained result wins over an older result with the same call id.
        for (const [id, result] of indexed.toolResults) {
          if (!this.#toolResults.has(id)) this.#toolResults.set(id, result);
        }
        this.#rows = [...indexed.rows, ...this.#rows];
        this.#entries = entries;
        return this.#snapshot("prepend", delta.length);
      }
    }

    const indexed = inspectEntries(entries, "p", showSwitches, this.#instrumentation);
    const kind = previous === undefined ? "initial" : "rebuild";
    this.#entries = entries;
    this.#showSwitches = showSwitches;
    this.#rows = indexed.rows;
    this.#toolResults = indexed.toolResults;
    return this.#snapshot(kind, entries.length);
  }

  #snapshot(kind: TranscriptIndexUpdateKind, inspectedEntries: number): TranscriptIndexSnapshot {
    return {
      rows: this.#rows,
      // Return a fresh facade so mounted tool calls update when a result is appended.
      toolResults: { get: (toolCallId) => this.#toolResults.get(toolCallId) },
      stats: { kind, inspectedEntries },
    };
  }
}
