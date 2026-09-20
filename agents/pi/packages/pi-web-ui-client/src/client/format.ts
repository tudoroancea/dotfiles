// Pure formatting and projection helpers ported verbatim from the standalone
// browser entry. They contain no Preact, DOM, or transport dependencies so they
// can be unit-tested without a browser and reused by every host adapter.
//
// Transcript payloads are untrusted, so the shared narrowing helpers (`record`,
// `array`, `str`, `number`) accept `unknown` and coerce defensively. The renderers
// build on them instead of reaching into raw entry shapes directly.

import { LIMITS } from "../wire/limits.ts";
import { isImageOmission, isImageReference } from "../wire/schema.ts";
import type { ContextUsage, RemoteImageBlock, SessionMetadata, Snapshot } from "../wire/types.ts";

/** A plain object decoded from an untrusted transcript payload. */
export type JsonRecord = Record<string, unknown>;

/** An `@`-completion span resolved from the composer textarea. */
export interface CompletionTarget {
  token: string;
  start: number;
  end: number;
}

/** A parsed `<skill …>` invocation block extracted from a user message. */
export interface ParsedSkillBlock {
  name: string;
  content: string;
  userMessage: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function shortenPath(p: unknown): string {
  if (typeof p !== "string") return "";
  for (const prefix of ["/Users/", "/home/"]) {
    if (p.startsWith(prefix)) {
      const parts = p.split("/");
      if (parts.length > 2) return "~" + p.slice((prefix + parts[2]).length);
    }
  }
  return p;
}

export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function formatTimestamp(ts: unknown): string {
  if (!ts) return "";
  if (typeof ts !== "string" && typeof ts !== "number") return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const c = record(block);
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n");
}

export function images(content: unknown): RemoteImageBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: RemoteImageBlock[] = [];
  let taggedCount = 0;
  for (const value of content) {
    const type = record(value).type;
    if (type !== "image" && type !== "image-reference" && type !== "image-omission") continue;
    taggedCount += 1;
    if (taggedCount > LIMITS.maxImagesPerEntry) {
      if (taggedCount === LIMITS.maxImagesPerEntry + 1)
        blocks.push({ type: "image-omission", reason: "count-exceeded" });
      continue;
    }
    if (isImageReference(value) || isImageOmission(value)) blocks.push(value);
    else blocks.push({ type: "image-omission", reason: "invalid-data" });
  }
  return blocks;
}

/** Remove resource identifiers and source bytes before generic JSON display. */
export function redactImageResources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactImageResources);
  if (!isRecord(value)) return value;
  if (value.type === "image-reference" || value.type === "image") return "[image]";
  if (value.type === "image-omission")
    return isImageOmission(value) ? `[image unavailable: ${value.reason}]` : "[image unavailable]";
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactImageResources(nested)]),
  );
}

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = text.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) return null;
  return {
    name: match[1],
    content: match[3],
    userMessage: match[4]?.trim() || "",
  };
}

export function resultText(result: unknown): string {
  const content = record(result).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => record(block).type === "text")
    .map((block) => record(block).text)
    .join("\n");
}

export function truncate(value: unknown, max = 80): string {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function compactCommand(value: unknown): string {
  if (typeof value !== "string" || !value) return "...";
  const oneLineValue = value.replace(/\s*\n\s*/g, " ↵ ");
  return oneLineValue.length > 100 ? `${oneLineValue.slice(0, 97)}...` : oneLineValue;
}

export function compactLineCount(text: string): number {
  if (!text || text === "(no output)") return 0;
  return text.split("\n").length;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}

export function readTruncationNotice(result: unknown): string {
  const truncation = record(record(result).details).truncation;
  const info = record(truncation);
  if (!info.truncated) return "";
  if (info.firstLineExceedsLimit) {
    return `[First line exceeds ${formatSize(number(info.maxBytes) ?? 50 * 1024)} limit]`;
  }
  if (info.truncatedBy === "lines") {
    return `[Truncated: showing ${info.outputLines} of ${info.totalLines} lines (${info.maxLines ?? 2000} line limit)]`;
  }
  return `[Truncated: ${info.outputLines} lines shown (${formatSize(number(info.maxBytes) ?? 50 * 1024)} limit)]`;
}

export function pluralize(count: number, noun: string): string {
  if (count === 1) return `${count.toLocaleString()} ${noun}`;
  // A consonant before a final "y" takes "-ies" ("entry", "query"); a vowel keeps
  // the plain "-s" ("day", "key").
  const plural = /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${count.toLocaleString()} ${plural}`;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "";
  const elapsed = Math.max(0, milliseconds);
  const roundedMilliseconds = Math.round(elapsed);
  if (roundedMilliseconds < 1_000) return `${roundedMilliseconds}ms`;

  const tenths = Math.round(elapsed / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const seconds = Math.round(elapsed / 1_000);
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const hours = Math.floor(minutes / 60);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

export function statusIcon(status: unknown): string {
  // Not "·": these lines are separated by "·", so a queued run would open with
  // what reads as a leading separator.
  if (status === "queued") return "◌";
  if (status === "running") return "◆";
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "◇";
}

export function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function resolveSessionTitle(snapshot: Snapshot): string {
  const sessionName = typeof snapshot.sessionName === "string" ? snapshot.sessionName.trim() : "";
  if (sessionName) return sessionName;
  const headerId = record(snapshot.header).id;
  const sessionId = typeof headerId === "string" ? headerId.trim() : "";
  return sessionId || "Pi session";
}

export function contextLabel(usage: ContextUsage | undefined): string {
  if (!usage) return "context —";
  const percent =
    usage.percent ??
    (usage.tokens !== null && usage.contextWindow > 0
      ? (usage.tokens / usage.contextWindow) * 100
      : null);
  if (percent === null) return "context —";
  return `${Math.round(percent)}% of ${(usage.contextWindow / 1000).toFixed(1)}k`;
}

export function cwdLabel(metadata: SessionMetadata | undefined): string {
  const cwd = metadata?.cwd || "";
  const home = metadata?.home;
  return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

export function costLabel(cost: number): string {
  if (!Number.isFinite(cost)) return "$—";
  const cents = cost * 100;
  const nearest = Math.round(cents);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(cents)) * 4;
  const rounded = Math.abs(cents - nearest) <= tolerance ? nearest : Math.ceil(cents);
  return `$${(rounded / 100).toFixed(2)}`;
}

export function completionTarget(value: string, cursor: number): CompletionTarget | undefined {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)(@(?:"[^"]*|[^\s@]*))$/);
  if (!match) return undefined;
  return { token: match[1], start: cursor - match[1].length, end: cursor };
}

export const completionTargetKey = (target: CompletionTarget | undefined): string =>
  target ? `${target.start}:${target.end}:${target.token}` : "";
