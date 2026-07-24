import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { NodeSnapshot, RunSnapshot, SemanticRole, ToolCallSnapshot } from "../types.ts";
import {
  boundedLines,
  formatCost,
  formatElapsed,
  formatPrompt,
  formatStatus,
  formatStyledToolCall,
  formatTokens,
  sanitizeRenderedValue,
} from "./formatters.ts";

const expandHint = (): string | undefined => {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return undefined;
  }
};

const colorStatus = (
  theme: Theme,
  status: ToolCallSnapshot["status"] | NodeSnapshot["status"],
  text: string,
): string => {
  if (status === "completed") return theme.fg("success", text);
  if (status === "failed") return theme.fg("error", text);
  if (status === "aborted") return theme.fg("muted", text);
  if (status === "running") return theme.fg("accent", text);
  return theme.fg("dim", text);
};

export function semanticResultSummary(
  role: SemanticRole | "agent",
  preview: string | undefined,
  tools: number,
  tokens: number,
  cost: number,
): string {
  const usage = `${tools} tools · ${formatTokens(tokens)} tokens · ${formatCost(cost)}`;
  if (preview) {
    try {
      const value = JSON.parse(preview) as Record<string, unknown>;
      if ((role === "finder" || role === "review") && Array.isArray(value.findings))
        return `${value.findings.length} findings · ${usage}`;
      if (role === "librarian" && Array.isArray(value.sources))
        return `${value.sources.length} sources · ${usage}`;
      if (role === "look_at" && Array.isArray(value.observations))
        return `${value.observations.length} observations · ${usage}`;
      if (role === "delegate" && Array.isArray(value.filesChanged))
        return `${value.filesChanged.length} files · ${usage}`;
      if (role === "oracle" && typeof value.recommendation === "string")
        return `recommendation · ${usage}`;
    } catch {
      // Bounded streaming previews are often incomplete JSON.
    }
  }
  return usage;
}

export interface SemanticRenderOptions {
  role?: SemanticRole | "agent";
  expanded?: boolean;
  collapsedPrompt?: boolean;
  maxCollapsedCalls?: number;
  observedAt?: number;
}

const executionLabel = (node: NodeSnapshot | undefined): string | undefined =>
  node?.backend ? `${node.backend}/${node.model ?? "default"}` : undefined;

const wrapPlainLine = (line: string, width: number): string[] => {
  if (!line) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < line.length; offset += width)
    chunks.push(line.slice(offset, offset + width));
  return chunks;
};

const wrapPlain = (lines: string[], width: number, maxLines: number): string[] => {
  const wrapped = lines.flatMap((line) => wrapPlainLine(line, Math.max(1, width)));
  if (wrapped.length <= maxLines) return wrapped;
  return [...wrapped.slice(0, maxLines - 1), "…"];
};

/** Shared bounded renderer used by raw agents and all semantic profile tools. */
export function renderSemanticSnapshot(
  snapshot: RunSnapshot,
  options: SemanticRenderOptions,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      const node = snapshot.nodes[0];
      const role = options.role ?? snapshot.semanticRole ?? node?.semanticRole ?? "agent";
      const status = node?.status ?? snapshot.status;
      const usage = node?.usage ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
      };
      const summary = semanticResultSummary(
        role,
        node?.resultPreview,
        node?.tools ?? 0,
        usage.total,
        usage.cost,
      );
      if (!options.expanded) {
        const calls = node?.toolCalls ?? [];
        const visibleCalls = calls.slice(-Math.max(1, options.maxCollapsedCalls ?? 8));
        const omitted = calls.length - visibleCalls.length;
        const lines: string[] = [];
        if (omitted > 0) lines.push(theme.fg("dim", `  … ${omitted} earlier tool calls`));
        for (const call of visibleCalls)
          lines.push(...formatStyledToolCall(call, theme).map((line) => `  ${line}`));
        const prompt = options.collapsedPrompt ? ` · ${formatPrompt(node?.prompt)}` : "";
        const execution = executionLabel(node);
        const backend = execution ? theme.fg("dim", ` · ${execution}`) : "";
        const configuredHint = expandHint();
        const hint = configuredHint ? theme.fg("dim", ` · ${configuredHint}`) : "";
        lines.push(
          `${colorStatus(theme, status, formatStatus(status))}${prompt}${backend} · ${summary}${hint}`,
        );
        return lines.map((line) => truncateToWidth(line, width, "…"));
      }

      const lines: string[] = [theme.fg("toolTitle", theme.bold("Prompt"))];
      lines.push(
        ...wrapPlain(boundedLines(formatPrompt(node?.prompt), 24), width, 24).map((line) =>
          theme.fg("muted", line),
        ),
      );
      const elapsed = formatElapsed(
        node?.startedAt ?? node?.queuedAt ?? snapshot.createdAt,
        node?.completedAt ?? snapshot.completedAt,
        options.observedAt ?? Date.now(),
      );
      const execution = executionLabel(node);
      lines.push(
        "",
        `${colorStatus(theme, status, formatStatus(status))} · ${theme.fg("dim", `${elapsed}${execution ? ` · ${execution}` : ""} · ${formatTokens(usage.total)} tokens · ${formatCost(usage.cost)}`)}`,
        "",
        theme.fg("toolTitle", theme.bold("Tool calls")),
      );
      const calls = node?.toolCalls ?? [];
      if (!calls.length) lines.push(theme.fg("dim", "(none)"));
      for (const call of calls) lines.push(...formatStyledToolCall(call, theme, true));
      lines.push("", theme.fg("toolTitle", theme.bold("Output")));
      const output = node?.error ? `Error: ${node.error}` : node?.resultPreview;
      lines.push(
        ...wrapPlain(boundedLines(output, 24), width, 24).map((line) => theme.fg("muted", line)),
      );
      lines.push("", theme.fg("toolTitle", theme.bold("Metadata")));
      lines.push(theme.fg("dim", `Cwd: ${sanitizeRenderedValue(node?.cwd ?? "(unknown)")}`));
      if (node?.backend)
        lines.push(theme.fg("dim", `Backend: ${sanitizeRenderedValue(node.backend)}`));
      if (node?.model) lines.push(theme.fg("dim", `Model: ${sanitizeRenderedValue(node.model)}`));
      if (node?.sessionFile)
        lines.push(theme.fg("dim", `Session: ${sanitizeRenderedValue(node.sessionFile)}`));
      if (snapshot.artifactDir)
        lines.push(theme.fg("dim", `Artifacts: ${sanitizeRenderedValue(snapshot.artifactDir)}`));
      return lines.map((line) => truncateToWidth(line, width, "…"));
    },
    invalidate() {},
  };
}
