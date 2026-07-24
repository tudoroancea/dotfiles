import { Buffer } from "node:buffer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "../shared/limits.js";
import type {
  PersistedEntry,
  PersistedState,
  ProjectedMessage,
  SessionMetadata,
} from "../shared/wire.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_DEPTH = 10;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const INTERNAL_ENTRY_TYPE = "web-ui-startup";
const SENSITIVE_KEY = /^(?:api[-_]?key|authorization|cookie|credential|password|secret|token)$/i;
const PROJECTED_VALUE_BYTES = 32 * 1024;
const PROJECTED_MESSAGE_BYTES = 128 * 1024;
const PROJECTED_TOOL_RESULT_BYTES = 1536 * 1024;
const PERSISTED_STATE_BYTES = Math.floor(LIMITS.snapshotBytes / 2);
const TRUNCATED = "…[truncated]";

interface ProjectionBudget {
  remaining: number;
}

function consume(budget: ProjectionBudget, bytes: number): boolean {
  if (bytes > budget.remaining) return false;
  budget.remaining -= bytes;
  return true;
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

function boundedUtf8(
  value: string,
  budget: ProjectionBudget,
  maximumBytes = LIMITS.toolTextUtf8Bytes,
): string {
  const allowed = Math.max(0, Math.min(maximumBytes, budget.remaining));
  const candidate = value.slice(0, allowed);
  const sanitized = candidate.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  const fullBytes = jsonStringBytes(sanitized);
  if (fullBytes <= allowed && candidate.length === value.length) {
    consume(budget, fullBytes);
    return sanitized;
  }
  const suffixBytes = jsonStringBytes(TRUNCATED);
  if (allowed <= suffixBytes) {
    const result = ".".repeat(allowed);
    consume(budget, jsonStringBytes(result));
    return result;
  }
  let low = 0;
  let high = sanitized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const result = `${sanitized.slice(0, middle)}${TRUNCATED}`;
    if (jsonStringBytes(result) <= allowed) low = middle;
    else high = middle - 1;
  }
  const result = `${sanitized.slice(0, low)}${TRUNCATED}`;
  consume(budget, jsonStringBytes(result));
  return result;
}

function projectUnknown(
  input: unknown,
  seen: WeakSet<object>,
  depth: number,
  budget: ProjectionBudget,
): JsonValue {
  if (budget.remaining < 32) return "[budget exhausted]";
  if (input === null) {
    consume(budget, 4);
    return null;
  }
  if (typeof input === "string") return boundedUtf8(input, budget);
  if (typeof input === "boolean") {
    consume(budget, 5);
    return input;
  }
  if (typeof input === "number") {
    consume(budget, 24);
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === "bigint") return boundedUtf8(input.toString(), budget);
  if (typeof input !== "object") {
    consume(budget, 4);
    return null;
  }
  if (depth >= MAX_DEPTH) return boundedUtf8("[depth limit]", budget);
  if (seen.has(input)) return boundedUtf8("[circular]", budget);
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      const projected: JsonValue[] = [];
      consume(budget, 2);
      for (const value of input.slice(0, MAX_ARRAY_ITEMS)) {
        if (!consume(budget, 1)) break;
        projected.push(projectUnknown(value, seen, depth + 1, budget));
        if (budget.remaining < 32) break;
      }
      if (projected.length < input.length) {
        projected.push(boundedUtf8(`[${input.length - projected.length} items omitted]`, budget));
      }
      return projected;
    }
    const output: Record<string, JsonValue> = {};
    consume(budget, 2);
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    let projectedKeys = 0;
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      if (!consume(budget, 4)) break;
      const projectedKey = boundedUtf8(key, budget, 256);
      if (SENSITIVE_KEY.test(key)) {
        output[projectedKey] = boundedUtf8("[redacted]", budget);
      } else {
        let value: unknown;
        try {
          value = record[key];
        } catch {
          value = "[unprojectable]";
        }
        output[projectedKey] = projectUnknown(value, seen, depth + 1, budget);
      }
      projectedKeys += 1;
      if (budget.remaining < 32) break;
    }
    if (projectedKeys < keys.length && budget.remaining >= 32) {
      output.__omittedKeys = keys.length - projectedKeys;
      consume(budget, 24);
    }
    return output;
  } catch {
    return boundedUtf8("[unprojectable]", budget);
  } finally {
    seen.delete(input);
  }
}

function budget(maximumBytes: number): ProjectionBudget {
  return { remaining: maximumBytes };
}

export function projectJson(input: unknown, maximumBytes = PROJECTED_VALUE_BYTES): JsonValue {
  return projectUnknown(input, new WeakSet(), 0, budget(maximumBytes));
}

function projectContent(input: unknown, projectionBudget: ProjectionBudget): JsonValue[] {
  const blocks = typeof input === "string" ? [{ type: "text", text: input }] : input;
  if (!Array.isArray(blocks)) return [];
  const result: JsonValue[] = [];
  const markerReserve = Math.min(256, projectionBudget.remaining);
  const contentBudget = budget(Math.max(0, projectionBudget.remaining - markerReserve));
  let imageCount = 0;
  const selected = blocks.slice(0, MAX_ARRAY_ITEMS);
  for (let index = 0; index < selected.length; index += 1) {
    const block = selected[index];
    if (contentBudget.remaining < 32) {
      const omittedImages = selected
        .slice(index)
        .filter(
          (candidate) =>
            candidate !== null &&
            typeof candidate === "object" &&
            (candidate as Record<string, unknown>).type === "image",
        ).length;
      if (omittedImages > 0) {
        result.push({ type: "image", omitted: true, count: omittedImages });
      }
      break;
    }
    if (!block || typeof block !== "object") {
      result.push(projectUnknown(block, new WeakSet(), 0, contentBudget));
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "image") {
      result.push(projectUnknown(record, new WeakSet(), 0, contentBudget));
      continue;
    }
    imageCount += 1;
    const data = typeof record.data === "string" ? record.data : "";
    const sourceBytes = Math.max(
      0,
      Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0),
    );
    const validBase64 =
      sourceBytes <= LIMITS.projectedImageSourceBytes &&
      data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(data);
    const encodedBytes = validBase64 ? jsonStringBytes(data) : 0;
    const mimeType = boundedUtf8(
      String(record.mimeType ?? "application/octet-stream"),
      contentBudget,
      128,
    );
    if (
      imageCount > LIMITS.projectedImagesPerMessage ||
      !validBase64 ||
      encodedBytes + 64 > contentBudget.remaining
    ) {
      result.push({ type: "image", mimeType, omitted: true });
      consume(contentBudget, 64);
      continue;
    }
    consume(contentBudget, encodedBytes + 64);
    result.push({ type: "image", mimeType, data });
  }
  const used = Math.max(0, projectionBudget.remaining - markerReserve - contentBudget.remaining);
  consume(
    projectionBudget,
    used +
      (result.some((item) => typeof item === "object" && item !== null && "count" in item)
        ? markerReserve
        : 0),
  );
  return result;
}

function projectMessageWithBudget(
  input: unknown,
  projectionBudget: ProjectionBudget,
): ProjectedMessage {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const role = boundedUtf8(
    typeof record.role === "string" ? record.role : "unknown",
    projectionBudget,
    64,
  );
  const content = projectContent(record.content, projectionBudget);
  const details =
    record.details === undefined
      ? undefined
      : projectUnknown(record.details, new WeakSet(), 0, projectionBudget);
  const usage =
    record.usage === undefined
      ? undefined
      : projectUnknown(record.usage, new WeakSet(), 0, projectionBudget);
  return {
    role,
    content,
    ...(typeof record.timestamp === "number" ? { timestamp: record.timestamp } : {}),
    ...(typeof record.provider === "string"
      ? { provider: boundedUtf8(record.provider, projectionBudget, 128) }
      : {}),
    ...(typeof record.model === "string"
      ? { model: boundedUtf8(record.model, projectionBudget, 256) }
      : {}),
    ...(typeof record.stopReason === "string"
      ? { stopReason: boundedUtf8(record.stopReason, projectionBudget, 64) }
      : {}),
    ...(typeof record.errorMessage === "string"
      ? { errorMessage: boundedUtf8(record.errorMessage, projectionBudget) }
      : {}),
    ...(typeof record.toolCallId === "string"
      ? { toolCallId: boundedUtf8(record.toolCallId, projectionBudget, 256) }
      : {}),
    ...(typeof record.toolName === "string"
      ? { toolName: boundedUtf8(record.toolName, projectionBudget, 256) }
      : {}),
    ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
    ...(details === undefined ? {} : { details }),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof record.customType === "string"
      ? { customType: boundedUtf8(record.customType, projectionBudget, 256) }
      : {}),
    ...(typeof record.display === "boolean" ? { display: record.display } : {}),
  };
}

export function projectMessage(input: unknown): ProjectedMessage {
  return projectMessageWithBudget(input, budget(PROJECTED_MESSAGE_BYTES));
}

export function projectToolResult(input: unknown): JsonValue {
  if (!input || typeof input !== "object") return projectJson(input);
  const record = input as Record<string, unknown>;
  const projectionBudget = budget(PROJECTED_TOOL_RESULT_BYTES);
  const output: Record<string, JsonValue> = {};
  if (record.content !== undefined)
    output.content = projectContent(record.content, projectionBudget);
  for (const [key, value] of Object.entries(record).slice(0, MAX_OBJECT_KEYS)) {
    if (key === "content") continue;
    if (projectionBudget.remaining < 32) break;
    const projectedKey = boundedUtf8(key, projectionBudget, 256);
    if (SENSITIVE_KEY.test(key)) output[projectedKey] = "[redacted]";
    else output[projectedKey] = projectUnknown(value, new WeakSet(), 0, projectionBudget);
  }
  return output;
}

function projectEntry(
  input: unknown,
  projectionBudget: ProjectionBudget,
): PersistedEntry | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.timestamp !== "string") return undefined;
  const entryType = typeof record.type === "string" ? record.type : "unknown";
  const payload: Record<string, JsonValue> = {};
  consume(projectionBudget, 2);
  if (entryType === "custom" && record.customType === INTERNAL_ENTRY_TYPE) {
    return {
      id: boundedUtf8(record.id, projectionBudget, 256),
      parentId:
        typeof record.parentId === "string"
          ? boundedUtf8(record.parentId, projectionBudget, 256)
          : null,
      timestamp: boundedUtf8(record.timestamp, projectionBudget, 128),
      entryType,
      payload: { customType: INTERNAL_ENTRY_TYPE },
    };
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "id" || key === "parentId" || key === "timestamp" || key === "type") continue;
    if (projectionBudget.remaining < 32) break;
    const projectedKey = boundedUtf8(key, projectionBudget, 256);
    consume(projectionBudget, 4);
    if (key === "message") {
      payload[projectedKey] = projectMessageWithBudget(value, projectionBudget) as JsonValue;
    } else if (key === "content" && entryType === "custom_message") {
      payload[projectedKey] = projectContent(value, projectionBudget);
    } else if (SENSITIVE_KEY.test(key)) {
      payload[projectedKey] = boundedUtf8("[redacted]", projectionBudget);
    } else {
      payload[projectedKey] = projectUnknown(value, new WeakSet(), 0, projectionBudget);
    }
  }
  return {
    id: boundedUtf8(record.id, projectionBudget, 256),
    parentId:
      typeof record.parentId === "string"
        ? boundedUtf8(record.parentId, projectionBudget, 256)
        : null,
    timestamp: boundedUtf8(record.timestamp, projectionBudget, 128),
    entryType: boundedUtf8(entryType, projectionBudget, 128),
    payload,
  };
}

export function projectPersistedState(context: ExtensionContext): PersistedState {
  const branch = context.sessionManager.getBranch();
  const selected: PersistedEntry[] = [];
  const projectionBudget = budget(PERSISTED_STATE_BYTES);
  let index = branch.length - 1;
  for (; index >= 0 && projectionBudget.remaining > 1024; index -= 1) {
    const entry = projectEntry(branch[index], projectionBudget);
    if (entry) selected.push(entry);
  }
  const entriesTruncated = index >= 0;
  selected.reverse();
  return {
    sessionId: String(context.sessionManager.getSessionId()).slice(0, 256),
    leafId: context.sessionManager.getLeafId(),
    entries: selected,
    entriesTruncated,
  };
}

function sessionCost(context: ExtensionContext): number {
  const unkeyed = { total: 0 };
  const keyed = new Map<string, number>();
  const addDetails = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const details = value as { cost?: unknown; costId?: unknown; costs?: unknown };
    if (typeof details.cost === "number" && Number.isFinite(details.cost) && details.cost >= 0) {
      if (typeof details.costId === "string") {
        keyed.set(details.costId, Math.max(keyed.get(details.costId) ?? 0, details.cost));
      } else unkeyed.total += details.cost;
    }
    if (!Array.isArray(details.costs)) return;
    for (const item of details.costs) {
      if (!item || typeof item !== "object") continue;
      const record = item as { costId?: unknown; cost?: unknown };
      if (
        typeof record.costId === "string" &&
        typeof record.cost === "number" &&
        Number.isFinite(record.cost) &&
        record.cost >= 0
      ) {
        keyed.set(record.costId, Math.max(keyed.get(record.costId) ?? 0, record.cost));
      }
    }
  };

  for (const candidate of context.sessionManager.getBranch()) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as unknown as Record<string, unknown>;
    if (entry.type === "custom" && entry.customType === "agentflow-cost") {
      addDetails(entry.data);
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "agentflow-result") {
      addDetails(entry.details);
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === "assistant") {
      const usage = message.usage as { cost?: { total?: unknown } } | undefined;
      const cost = usage?.cost?.total;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) unkeyed.total += cost;
    } else if (message.role === "toolResult" || message.role === "custom") {
      addDetails(message.details);
    }
  }
  return unkeyed.total + [...keyed.values()].reduce((sum, cost) => sum + cost, 0);
}

export function projectMetadata(
  context: ExtensionContext,
  activeTools: readonly string[] = [],
): SessionMetadata {
  const usage = context.getContextUsage();
  const cost = sessionCost(context);
  return {
    cwd: String(context.cwd).slice(0, 4_096),
    isIdle: context.isIdle(),
    ...(context.model
      ? {
          model: {
            provider: String(context.model.provider).slice(0, 128),
            id: String(context.model.id).slice(0, 256),
            name: String(context.model.name).slice(0, 256),
          },
        }
      : {}),
    ...(context.thinkingLevel ? { thinkingLevel: context.thinkingLevel } : {}),
    ...(usage
      ? {
          contextUsage: {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
          },
        }
      : {}),
    activeTools: activeTools.slice(0, 256).map((name) => String(name).slice(0, 256)),
    sessionCost: cost,
  };
}
