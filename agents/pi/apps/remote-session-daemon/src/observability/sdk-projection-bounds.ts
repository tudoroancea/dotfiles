import { Buffer } from "node:buffer";

export const SDK_PROJECTION_LIMITS = Object.freeze({
  sessionBytes: 64 * 1024 * 1024,
  sessionLineBytes: 8 * 1024 * 1024,
  sessionEntries: 100_000,
  historyPageEntries: 100,
  historyPageBytes: 1024 * 1024,
  projectedEntryBytes: 256 * 1024,
  imageBytes: 5 * 1024 * 1024,
  imagesPerEntry: 8,
  toolResultBytes: 256 * 1024,
});
export type DegradedHistoryReason =
  | "session_bytes"
  | "session_entries"
  | "page_bytes"
  | "entry_bytes"
  | "image_bytes"
  | "image_count"
  | "tool_result_bytes";
export interface SdkProjectionMeasurement {
  sourceBytes: number;
  projectedBytes: number;
  entryCount: number;
  imageCount: number;
  imageBytes: number;
  toolResultBytes: number;
}
export interface BoundedHistoryMeasurement {
  entries: unknown[];
  measurement: SdkProjectionMeasurement;
  degraded: boolean;
  reasons: DegradedHistoryReason[];
  omittedEntries: number;
}
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function encodedImageBytes(value: unknown): number {
  if (typeof value !== "string") return 0;
  const comma = value.indexOf(",");
  const encoded = comma >= 0 ? value.slice(comma + 1) : value;
  return Math.ceil((encoded.length * 3) / 4);
}
function inspect(value: unknown, result: SdkProjectionMeasurement): void {
  if (Array.isArray(value)) {
    for (const child of value) inspect(child, result);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (object.type === "image") {
    result.imageCount += 1;
    result.imageBytes += encodedImageBytes(object.data ?? object.url);
  }
  if (object.role === "toolResult" || object.type === "tool_result")
    result.toolResultBytes += byteLength(object.content ?? object.output ?? object.result ?? "");
  for (const child of Object.values(object)) inspect(child, result);
}
export function measureSdkProjection(entries: readonly unknown[]): SdkProjectionMeasurement {
  const result = {
    sourceBytes: byteLength(entries),
    projectedBytes: byteLength(entries),
    entryCount: entries.length,
    imageCount: 0,
    imageBytes: 0,
    toolResultBytes: 0,
  };
  inspect(entries, result);
  return result;
}
/** Measurement-only SDK values; deliberately not a browser wire contract. */
export function measureBoundedHistory(
  allEntries: readonly unknown[],
  sessionBytes: number,
  start = 0,
): BoundedHistoryMeasurement {
  const reasons = new Set<DegradedHistoryReason>();
  if (sessionBytes > SDK_PROJECTION_LIMITS.sessionBytes) reasons.add("session_bytes");
  if (allEntries.length > SDK_PROJECTION_LIMITS.sessionEntries) reasons.add("session_entries");
  const entries: unknown[] = [];
  let pageBytes = 2;
  const end = Math.min(allEntries.length, start + SDK_PROJECTION_LIMITS.historyPageEntries);
  for (let index = start; index < end; index += 1) {
    const entry = allEntries[index];
    const m = measureSdkProjection([entry]);
    let rejected = false;
    if (m.projectedBytes > SDK_PROJECTION_LIMITS.projectedEntryBytes) {
      reasons.add("entry_bytes");
      rejected = true;
    }
    if (m.imageBytes > SDK_PROJECTION_LIMITS.imageBytes) {
      reasons.add("image_bytes");
      rejected = true;
    }
    if (m.imageCount > SDK_PROJECTION_LIMITS.imagesPerEntry) {
      reasons.add("image_count");
      rejected = true;
    }
    if (m.toolResultBytes > SDK_PROJECTION_LIMITS.toolResultBytes) {
      reasons.add("tool_result_bytes");
      rejected = true;
    }
    if (rejected) continue;
    const next = pageBytes + byteLength(entry) + (entries.length === 0 ? 0 : 1);
    if (next > SDK_PROJECTION_LIMITS.historyPageBytes) {
      reasons.add("page_bytes");
      break;
    }
    entries.push(entry);
    pageBytes = next;
  }
  return {
    entries,
    measurement: measureSdkProjection(entries),
    degraded: reasons.size > 0,
    reasons: [...reasons],
    omittedEntries: allEntries.length - entries.length,
  };
}
export function classifySdkContent(entries: readonly unknown[]): Set<string> {
  const classes = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const o = value as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    const role = typeof o.role === "string" ? o.role : "";
    if (type === "message") classes.add("messages");
    if (type === "thinking" || type === "thinking_delta") classes.add("thinking");
    if (type === "toolCall" || role === "toolResult") classes.add("tools");
    if (type === "custom" || type === "custom_message") classes.add("custom entries");
    if (type === "image") classes.add("images");
    if (type === "compaction") classes.add("compaction");
    if (type === "branch_summary" || o.parentId !== undefined) classes.add("branches");
    if (type === "model_change" || type === "thinking_level_change") classes.add("model changes");
    if (type.includes("retry")) classes.add("retries");
    if (type.includes("queue") || o.queue !== undefined) classes.add("queues");
    if (o.customType === "agentflow" || o.provider === "agentflow") classes.add("Agentflow output");
    if (o.customType === "background-process" || o.provider === "background-process")
      classes.add("background output");
    for (const child of Object.values(o)) visit(child);
  };
  visit(entries);
  return classes;
}
