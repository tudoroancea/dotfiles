// Client-side plain-text index over the bounded projected entries the browser
// has actually loaded. It records each logical rendered row once, keyed by the
// same virtual-row key the timeline uses, and grows only at the mutation
// boundaries the history store already owns (chronological prepends for older
// pages, tail appends for same-lineage snapshots). It never fetches pages,
// tracks progress, or drives navigation; those are separate later concerns.
//
// The corpus mirrors what a transcript row renders: message prose and thinking,
// tool-call argument values, tool-result output and details, custom-message
// details, and generic fallback payloads. A tool call and its result render as
// one logical panel keyed `tool:<toolCallId>`, so their text merges into one
// match anchored to the tool-result row whenever it is loaded. All text is
// untrusted and already bounded by server projection, so extraction reuses the
// shared sanitization helpers, bounds its recursion, and deliberately skips the
// base64 `data` of every image block at any nesting depth.

import type { PersistedEntry } from "../shared/wire.js";
import { isRenderableEntry, persistedRowKey } from "./components/timeline-model.js";
import { asArray, asRecord } from "./lib/tool-model.js";
import { sanitizeText } from "./lib/text.js";

/** Where a contribution's text renders, which fixes its role within a row. */
type ContributionRole = "self" | "call" | "result";

/** One entry's text contribution to a single logical rendered row. */
interface Contribution {
  readonly rowKey: string;
  readonly role: ContributionRole;
  readonly entryId: string;
  readonly text: string;
}

/** One source entry's slice of a logical row, retained for navigation anchoring. */
interface TargetPart {
  readonly text: string;
  readonly entryId: string;
  readonly order: number;
}

/** A single logical rendered row's merged searchable state. */
interface IndexedTarget {
  readonly rowKey: string;
  self?: TargetPart;
  call?: TargetPart;
  result?: TargetPart;
  haystack: string;
}

export interface SearchMatch {
  /** Stable persisted entry ID, for mounting the corresponding virtual row. */
  readonly entryId: string;
  /** Canonical virtual-row key shared with the timeline row model. */
  readonly rowKey: string;
  /** Number of times the query occurs in this row's merged plain text. */
  readonly count: number;
}

export interface SearchQueryResult {
  readonly query: string;
  /** Chronological matches across the loaded window. */
  readonly matches: readonly SearchMatch[];
  /** Total occurrences across all matched rows. */
  readonly totalMatches: number;
}

const EMPTY_RESULT: SearchQueryResult = { query: "", matches: [], totalMatches: 0 };

// Recursion and length bounds keep the collector cheap and prevent a pathological
// payload from retaining an unbounded amount of text (server projection already
// bounds each field, but nesting is untrusted).
const MAX_SCALAR_DEPTH = 8;
const MAX_SCALAR_CHARS = 20_000;

/**
 * Collects safe, useful plain text from every logical row an entry renders.
 * Non-renderable and internal entries yield nothing. A message's own prose maps
 * to its `entry:<id>` row, each tool-call block maps to its `tool:<id>` panel,
 * and a tool-result maps to the same `tool:<id>` panel so the two merge later.
 */
export function collectContributions(entry: PersistedEntry): Contribution[] {
  if (!isRenderableEntry(entry)) return [];
  const payload = asRecord(entry.payload);

  if (entry.entryType === "message") {
    return messageContributions(entry, asRecord(payload.message));
  }
  if (entry.entryType === "custom_message") {
    const text = customMessageText(payload);
    return text ? [{ rowKey: `entry:${entry.id}`, role: "self", entryId: entry.id, text }] : [];
  }
  // Unknown renderable entry types fall back to a JSON view of their payload.
  const text = collectScalarText(payload);
  return text ? [{ rowKey: `entry:${entry.id}`, role: "self", entryId: entry.id, text }] : [];
}

function messageContributions(
  entry: PersistedEntry,
  message: Record<string, unknown>,
): Contribution[] {
  const contributions: Contribution[] = [];
  const rowKey = persistedRowKey(entry);

  // A tool-result message renders as the `tool:<id>` panel: its output, details,
  // tool name, and any error prose merge with the call arguments.
  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    const text = toolResultText(message);
    if (text) contributions.push({ rowKey, role: "result", entryId: entry.id, text });
    return contributions;
  }

  // Every other message contributes its own prose to its `entry:<id>` row, while
  // each tool-call block it carries contributes to the matching `tool:<id>` panel.
  const self = messageProseText(message);
  if (self) contributions.push({ rowKey, role: "self", entryId: entry.id, text: self });
  for (const block of asArray(message.content)) {
    const record = asRecord(block);
    if (record.type !== "toolCall" || typeof record.id !== "string") continue;
    const text = toolCallText(record);
    if (text) {
      contributions.push({ rowKey: `tool:${record.id}`, role: "call", entryId: entry.id, text });
    }
  }
  return contributions;
}

/** Prose the message body renders: text and thinking blocks plus error text. */
function messageProseText(message: Record<string, unknown>): string {
  const parts = [proseFromContent(asArray(message.content))];
  if (typeof message.errorMessage === "string") parts.push(message.errorMessage);
  return sanitizeText(joinParts(parts));
}

/** The tool-call panel's title and arguments (commands, paths, prompts, text). */
function toolCallText(block: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof block.name === "string") parts.push(block.name);
  parts.push(collectScalarText(block.arguments));
  return joinParts(parts);
}

/** The tool-result panel's output, details, name, and error prose. */
function toolResultText(message: Record<string, unknown>): string {
  const parts = [proseFromContent(asArray(message.content))];
  if (typeof message.toolName === "string") parts.push(message.toolName);
  if (typeof message.errorMessage === "string") parts.push(message.errorMessage);
  parts.push(collectScalarText(message.details));
  return sanitizeText(joinParts(parts));
}

/** A custom_message's normalized type, rendered content, and details facts. */
function customMessageText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof payload.customType === "string") parts.push(payload.customType.replace(/[-_]/g, " "));
  parts.push(proseFromContent(asArray(payload.content)));
  parts.push(collectScalarText(payload.details));
  return sanitizeText(joinParts(parts));
}

/**
 * Extracts the prose a `ContentBlocks` render shows: bare strings, text blocks,
 * and thinking/reasoning. Tool-call blocks are indexed separately and image
 * blocks intentionally contribute nothing so base64 is never retained.
 */
function proseFromContent(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const record = asRecord(block);
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "thinking" || record.type === "reasoning") {
      if (typeof record.thinking === "string") parts.push(record.thinking);
      else if (typeof record.text === "string") parts.push(record.text);
    }
  }
  return joinParts(parts);
}

/**
 * Safe, bounded, recursive scalar-text collector over already projected JSON.
 * It gathers strings and finite numbers plus the visible object keys the JSON
 * and facts renderers show, and skips the `data` field of any image block at any
 * nesting depth so base64 payloads are never indexed.
 */
function collectScalarText(value: unknown): string {
  const parts: string[] = [];
  let budget = MAX_SCALAR_CHARS;

  const push = (text: string): void => {
    const separatorLength = parts.length > 0 ? 1 : 0;
    if (!text || budget <= separatorLength) return;
    const bounded = sanitizeText(text).slice(0, budget - separatorLength);
    if (!bounded) return;
    parts.push(bounded);
    budget -= bounded.length + separatorLength;
  };

  const visit = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_SCALAR_DEPTH) return;
    if (typeof node === "string") {
      push(node);
      return;
    }
    if (typeof node === "number" && Number.isFinite(node)) {
      push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (budget <= 0) break;
        visit(item, depth + 1);
      }
      return;
    }
    const record = node && typeof node === "object" ? (node as Record<string, unknown>) : undefined;
    if (!record) return;
    const isImage = record.type === "image";
    for (const [key, child] of Object.entries(record)) {
      if (budget <= 0) break;
      // Never index an image block's base64 payload, however deeply nested.
      if (isImage && key === "data") continue;
      push(key);
      visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return joinParts(parts);
}

function joinParts(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

/**
 * The whole searchable text of an entry, merged across the logical rows it
 * contributes to. Useful for corpus-completeness checks; the index itself keeps
 * contributions separated by their logical row key.
 */
export function extractSearchText(entry: PersistedEntry): string {
  return joinParts(collectContributions(entry).map((contribution) => contribution.text));
}

/**
 * Incremental plain-text index over the loaded window. Ordering mirrors the
 * history store: `prepend` grows the older head, `append` grows the live tail,
 * and `reset` atomically discards everything for a new lineage/generation. Each
 * mutation only extracts the newly arrived entries; loaded history is never
 * rescanned, and a tool call and its result merge into one keyed row regardless
 * of which side loads first.
 */
export class LoadedEntrySearchIndex {
  private readonly targets = new Map<string, IndexedTarget>();
  private readonly seen = new Set<string>();
  private tailOrder = 0;
  private headOrder = 0;

  /** Number of logical rows that produced indexable text. */
  get size(): number {
    return this.targets.size;
  }

  /** Discards the whole index; called on a lineage/generation reset. */
  reset(): void {
    this.targets.clear();
    this.seen.clear();
    this.tailOrder = 0;
    this.headOrder = 0;
  }

  /** Indexes a newly loaded older page ahead of the current head. */
  prepend(entries: readonly PersistedEntry[]): void {
    // Walk oldest-last so each earlier entry gets a strictly smaller order,
    // keeping the whole prepended batch chronologically ahead of the window.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (this.seen.has(entry.id)) continue;
      this.seen.add(entry.id);
      this.ingest(entry, (this.headOrder -= 1));
    }
  }

  /** Indexes newly loaded tail entries after the current window. */
  append(entries: readonly PersistedEntry[]): void {
    for (const entry of entries) {
      if (this.seen.has(entry.id)) continue;
      this.seen.add(entry.id);
      this.ingest(entry, this.tailOrder++);
    }
  }

  /** Runs a case-insensitive plain-text query over the loaded window. */
  query(term: string): SearchQueryResult {
    if (term.trim().length === 0) return EMPTY_RESULT;
    const needle = term.toLowerCase();
    const ordered: { match: SearchMatch; order: number }[] = [];
    let totalMatches = 0;
    for (const target of this.targets.values()) {
      const count = countOccurrences(target.haystack, needle);
      if (count === 0) continue;
      const anchor = target.result ?? target.call ?? target.self;
      if (!anchor) continue;
      ordered.push({
        match: { entryId: anchor.entryId, rowKey: target.rowKey, count },
        order: anchor.order,
      });
      totalMatches += count;
    }
    ordered.sort((left, right) => left.order - right.order);
    return { query: term, matches: ordered.map((item) => item.match), totalMatches };
  }

  private ingest(entry: PersistedEntry, order: number): void {
    for (const contribution of collectContributions(entry)) {
      let target = this.targets.get(contribution.rowKey);
      if (!target) {
        target = { rowKey: contribution.rowKey, haystack: "" };
        this.targets.set(contribution.rowKey, target);
      }
      const part: TargetPart = { text: contribution.text, entryId: contribution.entryId, order };
      target[contribution.role] = part;
      target.haystack = joinParts([
        target.self?.text ?? "",
        target.call?.text ?? "",
        target.result?.text ?? "",
      ]).toLowerCase();
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}
