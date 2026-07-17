import type { NodeStatus, ToolCallSnapshot, UsageSnapshot } from "../types.ts";
import { boundInitialPrompt } from "../runtime/snapshot-fields.ts";

export const MAX_DETAIL_PROMPT_LINES = 24;
export const MAX_DETAIL_OUTPUT_LINES = 24;

export function sanitizeRenderedValue(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || code === 0x9b || code === 0x9d) {
      const introducer = code === 0x1b ? value[index + 1] : code === 0x9b ? "[" : "]";
      if (code === 0x1b && (introducer === "[" || introducer === "]")) index += 1;
      if (introducer === "[") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(++index);
          if (next >= 0x40 && next <= 0x7e) break;
        }
      } else if (introducer === "]") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(++index);
          if (next === 0x07 || next === 0x9c) break;
          if (next === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
        }
      }
      continue;
    }
    safe += code === 0x0a || code === 0x09 || code >= 0x20 ? value[index] : " ";
  }
  return safe;
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

export function formatElapsed(
  startedAt: string | undefined,
  completedAt?: string,
  now = Date.now(),
): string {
  if (!startedAt) return "0s";
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "0s";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export const statusIcon = (status: NodeStatus | ToolCallSnapshot["status"]): string => {
  if (status === "queued") return "·";
  if (status === "running") return "◆";
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "◇";
};

export const formatStatus = (status: NodeStatus | ToolCallSnapshot["status"]): string =>
  `${statusIcon(status)} ${status}`;

export const formatUsage = (usage: UsageSnapshot): string =>
  `${formatTokens(usage.total)} tokens · ${formatCost(usage.cost)}`;

export const formatPrompt = (prompt: string | undefined): string =>
  sanitizeRenderedValue(boundInitialPrompt(prompt?.trim() || "(prompt unavailable)"));

const oneLine = (value: string): string =>
  sanitizeRenderedValue(value).replaceAll(/\s+/g, " ").trim();

export function formatToolCall(call: ToolCallSnapshot, expanded = false): string[] {
  const lines = [`${formatStatus(call.status)} ${call.name}  ${oneLine(call.argumentSummary)}`];
  if (!expanded) return lines;
  if (call.argumentsPreview) lines.push(`args: ${oneLine(call.argumentsPreview)}`);
  if (call.error) lines.push(`error: ${oneLine(call.error)}`);
  else if (call.resultPreview) lines.push(`result: ${oneLine(call.resultPreview)}`);
  return lines;
}

export function boundedLines(text: string | undefined, maxLines: number): string[] {
  if (!text) return ["(none)"];
  const source = sanitizeRenderedValue(text)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  if (source.length <= maxLines) return source;
  return [...source.slice(0, maxLines - 1), `… ${source.length - maxLines + 1} more lines`];
}
