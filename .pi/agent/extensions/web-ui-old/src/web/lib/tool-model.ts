// Normalizes the wire ToolExecution (and persisted tool-result messages) into
// a single view model the renderer registry consumes. All accessors are
// defensive because arguments, results, and details are untrusted.
import { sanitizeText, textFromContent } from "./text.js";

export type ToolStatus = "running" | "completed" | "error";

export interface ToolView {
  readonly name: string;
  readonly status: ToolStatus;
  readonly isError: boolean;
  readonly isPartial: boolean;
  readonly args: Record<string, unknown>;
  readonly content: readonly unknown[];
  readonly text: string;
  readonly details: Record<string, unknown>;
}

export interface ToolExecutionLike {
  toolName: string;
  status?: ToolStatus;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? sanitizeText(value) : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeTool(execution: ToolExecutionLike): ToolView {
  const result = asRecord(execution.result);
  const content = asArray(result.content);
  const text = textFromContent(content.length > 0 ? content : result);
  const questionnaireError =
    execution.toolName === "questionnaire" && /^Error:/i.test(text.trimStart());
  const status: ToolStatus = questionnaireError
    ? "error"
    : (execution.status ??
      (execution.isError ? "error" : execution.result ? "completed" : "running"));
  return {
    name: execution.toolName,
    status,
    isError: questionnaireError || execution.isError === true || status === "error",
    isPartial: status === "running",
    args: asRecord(execution.args),
    content,
    text,
    details: asRecord(result.details),
  };
}
