import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { NodeSnapshot, RunSnapshot, SemanticRole, ToolCallSnapshot } from "../types.ts";

const statusIcon = (status: ToolCallSnapshot["status"] | NodeSnapshot["status"]): string => {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "aborted") return "✗";
  return "◆";
};

const colorStatus = (
  theme: Theme,
  status: ToolCallSnapshot["status"] | NodeSnapshot["status"],
  text: string,
): string => {
  if (status === "completed") return theme.fg("success", text);
  if (status === "failed" || status === "aborted") return theme.fg("error", text);
  return theme.fg("accent", text);
};

export function semanticResultSummary(
  role: SemanticRole | "agent",
  preview: string | undefined,
  tools: number,
  tokens: number,
): string {
  if (preview) {
    try {
      const value = JSON.parse(preview) as Record<string, unknown>;
      if ((role === "finder" || role === "review") && Array.isArray(value.findings))
        return `${value.findings.length} findings · ${tools} tools · ${tokens} tokens`;
      if (role === "librarian" && Array.isArray(value.sources))
        return `${value.sources.length} sources · ${tools} tools · ${tokens} tokens`;
      if (role === "delegate" && Array.isArray(value.filesChanged))
        return `${value.filesChanged.length} files · ${tools} tools · ${tokens} tokens`;
      if (role === "oracle" && typeof value.recommendation === "string")
        return `recommendation · ${tools} tools · ${tokens} tokens`;
    } catch {
      // Bounded streaming previews are often incomplete JSON.
    }
  }
  return `${tools} tools · ${tokens} tokens`;
}

export interface SemanticRenderOptions {
  role?: SemanticRole;
  expanded?: boolean;
  maxCollapsedCalls?: number;
}

/** Shared compact renderer used by all semantic profile tools. */
export function renderSemanticSnapshot(
  snapshot: RunSnapshot,
  options: SemanticRenderOptions,
  theme: Theme,
): Component {
  const node = snapshot.nodes[0];
  const role = options.role ?? snapshot.semanticRole ?? node?.semanticRole ?? "agent";
  const expanded = options.expanded ?? false;
  const calls = node?.toolCalls ?? [];
  const visibleCalls = expanded ? calls : calls.slice(-Math.max(1, options.maxCollapsedCalls ?? 8));
  const omitted = calls.length - visibleCalls.length;
  const lines: string[] = [];
  const status = node?.status ?? snapshot.status;
  lines.push(
    `${colorStatus(theme, status, statusIcon(status))} ${theme.fg("accent", role)}  ${theme.fg("muted", node?.label ?? snapshot.name ?? "agent")}`,
  );
  if (omitted > 0) lines.push(theme.fg("dim", `  … ${omitted} earlier tool calls`));
  for (const call of visibleCalls) {
    lines.push(
      `  ${colorStatus(theme, call.status, statusIcon(call.status))} ${theme.fg("toolTitle", call.name.padEnd(10))} ${theme.fg("dim", call.argumentSummary)}`,
    );
    if (expanded && call.argumentsPreview)
      lines.push(`    ${theme.fg("dim", `args: ${call.argumentsPreview.replaceAll("\n", " ")}`)}`);
    if (expanded && call.error) lines.push(`    ${theme.fg("error", call.error)}`);
    else if (expanded && call.resultPreview)
      lines.push(`    ${theme.fg("muted", call.resultPreview.replaceAll("\n", " "))}`);
  }
  const tokens = node?.usage.total ?? 0;
  const summary = semanticResultSummary(role, node?.resultPreview, node?.tools ?? 0, tokens);
  lines.push(
    `${colorStatus(theme, status, statusIcon(status))} ${theme.fg("accent", role)}  ${theme.fg("dim", summary)}`,
  );
  if (expanded && node?.error) lines.push(theme.fg("error", node.error));
  if (expanded && node?.sessionFile) lines.push(theme.fg("dim", `Session: ${node.sessionFile}`));
  if (expanded && snapshot.artifactDir)
    lines.push(theme.fg("dim", `Artifacts: ${snapshot.artifactDir}`));

  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      return lines.map((line) => truncateToWidth(line, width, "…"));
    },
    invalidate() {},
  };
}
