import type { NodeSnapshot } from "../types.ts";

export const MAX_TOOL_CALL_SNAPSHOTS = 32;
const bounded = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
const stringify = (value: unknown, max: number): string => {
  try {
    return bounded(typeof value === "string" ? value : (JSON.stringify(value) ?? ""), max);
  } catch {
    return "[unserializable]";
  }
};

export function summarizeToolArguments(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return stringify(args, 240);
  const value = args as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : undefined;
  if (name === "read" && path) {
    const range = value.offset
      ? `:${value.offset}${value.limit ? `-${Number(value.offset) + Number(value.limit) - 1}` : ""}`
      : "";
    return bounded(`${path}${range}`, 240);
  }
  if (name === "bash" && typeof value.command === "string")
    return bounded(value.command.split("\n", 1)[0], 240);
  const query = [value.query, value.pattern].find((item) => typeof item === "string") as
    | string
    | undefined;
  if (query) return bounded(`${JSON.stringify(query)}${path ? ` ${path}` : ""}`, 240);
  if (path) return bounded(path, 240);
  const useful = ["url", "runId", "message", "label"]
    .map((key) => value[key])
    .find((item) => typeof item === "string");
  return stringify(useful ?? args, 240);
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return stringify(result, 1000);
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return stringify(result, 1000);
  return bounded(
    content
      .filter(
        (item): item is { type: "text"; text: string } =>
          !!item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
      )
      .map((item) => item.text)
      .join("\n"),
    1000,
  );
}

export function startToolCallSnapshot(
  node: NodeSnapshot,
  input: { id: string; name: string; args: unknown; at?: string },
): void {
  node.tools++;
  node.toolCalls.push({
    id: input.id,
    name: input.name,
    status: "running",
    startedAt: input.at ?? new Date().toISOString(),
    argumentSummary: summarizeToolArguments(input.name, input.args),
    argumentsPreview: stringify(input.args, 500),
  });
  while (node.toolCalls.length > MAX_TOOL_CALL_SNAPSHOTS) {
    const settled = node.toolCalls.findIndex((call) => call.status !== "running");
    node.toolCalls.splice(settled >= 0 ? settled : 0, 1);
  }
}

export function finishToolCallSnapshot(
  node: NodeSnapshot,
  input: { id: string; result: unknown; isError: boolean; at?: string },
): void {
  const call = node.toolCalls.find((candidate) => candidate.id === input.id);
  if (!call) return;
  call.status = input.isError ? "failed" : "completed";
  call.completedAt = input.at ?? new Date().toISOString();
  call.resultPreview = resultText(input.result);
  if (input.isError) call.error = call.resultPreview || "Tool failed";
}
