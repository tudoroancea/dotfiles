import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { RunResult, RunSnapshot, RunStatus, UsageSnapshot } from "../types.ts";
import {
  boundedLines,
  formatElapsed,
  formatPrompt,
  formatStatus,
  sanitizeRenderedValue,
} from "./formatters.ts";
import { renderSemanticSnapshot, semanticResultSummary } from "./semantic-renderer.ts";

const ZERO_USAGE: UsageSnapshot = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
};

const expandHint = (): string | undefined => {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return undefined;
  }
};

const statusColor = (theme: Theme, status: RunStatus, text: string): string => {
  if (status === "completed") return theme.fg("success", text);
  if (status === "failed") return theme.fg("error", text);
  if (status === "running") return theme.fg("accent", text);
  if (status === "aborted") return theme.fg("muted", text);
  return theme.fg("dim", text);
};

const runUsage = (snapshot: RunSnapshot): UsageSnapshot =>
  snapshot.nodes.reduce(
    (total, node) => ({
      input: total.input + node.usage.input,
      output: total.output + node.usage.output,
      cacheRead: total.cacheRead + node.usage.cacheRead,
      cacheWrite: total.cacheWrite + node.usage.cacheWrite,
      total: total.total + node.usage.total,
      cost: total.cost + node.usage.cost,
    }),
    { ...ZERO_USAGE },
  );

const roleFor = (snapshot: RunSnapshot): string =>
  snapshot.semanticRole ?? snapshot.nodes[0]?.semanticRole ?? snapshot.name ?? snapshot.kind;

const runSummary = (snapshot: RunSnapshot): string => {
  const usage = runUsage(snapshot);
  const node = snapshot.nodes[0];
  const tools = snapshot.nodes.reduce((count, item) => count + item.tools, 0);
  return semanticResultSummary(
    snapshot.semanticRole ?? node?.semanticRole ?? "agent",
    snapshot.resultPreview ?? node?.resultPreview,
    tools,
    usage.total,
    usage.cost,
  );
};

const component = (renderLines: (width: number) => string[]): Component => ({
  render: (width) =>
    width <= 0 ? [] : renderLines(width).map((line) => truncateToWidth(line, width, "…")),
  invalidate() {},
});

const runHeading = (snapshot: RunSnapshot, theme: Theme, observedAt: number): string => {
  const elapsed = formatElapsed(snapshot.createdAt, snapshot.completedAt, observedAt);
  return `${statusColor(theme, snapshot.status, formatStatus(snapshot.status))} ${theme.fg("toolTitle", roleFor(snapshot))} ${theme.fg("dim", `${sanitizeRenderedValue(snapshot.runId)} · ${elapsed}`)}`;
};

export function renderRunSnapshots(
  snapshots: RunSnapshot[],
  expanded: boolean,
  theme: Theme,
  observedAt = Date.now(),
): Component {
  if (expanded && snapshots.length === 1) {
    const snapshot = snapshots[0]!;
    const detail = renderSemanticSnapshot(
      snapshot,
      { expanded: true, role: snapshot.semanticRole ?? "agent", observedAt },
      theme,
    );
    return component((width) => [
      runHeading(snapshot, theme, observedAt),
      "",
      ...detail.render(width),
    ]);
  }

  return component((_width) => {
    if (!snapshots.length) return [theme.fg("muted", "No agentflow runs")];
    if (!expanded) {
      const shown = snapshots.slice(0, 3);
      const lines = shown.map(
        (snapshot) =>
          `${runHeading(snapshot, theme, observedAt)} · ${theme.fg("dim", runSummary(snapshot))}`,
      );
      if (snapshots.length > shown.length)
        lines.push(theme.fg("dim", `… ${snapshots.length - shown.length} more runs`));
      const hint = expandHint();
      if (hint) lines.push(theme.fg("dim", hint));
      return lines;
    }

    const lines: string[] = [];
    for (const snapshot of snapshots) {
      if (lines.length) lines.push("", theme.fg("dim", "────────"), "");
      lines.push(runHeading(snapshot, theme, observedAt));
      lines.push(theme.fg("dim", runSummary(snapshot)));
      lines.push(theme.fg("muted", `Prompt: ${formatPrompt(snapshot.nodes[0]?.prompt)}`));
      const output = snapshot.error ?? snapshot.resultPreview ?? snapshot.nodes[0]?.resultPreview;
      if (output)
        lines.push(
          ...boundedLines(output, 4).map((line, index) =>
            theme.fg("muted", `${index === 0 ? "Output: " : "        "}${line}`),
          ),
        );
      if (snapshot.artifactDir)
        lines.push(theme.fg("dim", `Artifacts: ${sanitizeRenderedValue(snapshot.artifactDir)}`));
    }
    return lines;
  });
}

export function renderWaitResults(
  results: RunResult[],
  expanded: boolean,
  theme: Theme,
  observedAt = Date.now(),
): Component {
  return renderRunSnapshots(
    results.map((result) => ({
      ...result.snapshot,
      error: result.error ?? result.snapshot.error,
      resultPreview:
        typeof result.result === "string" ? result.result : result.snapshot.resultPreview,
    })),
    expanded,
    theme,
    observedAt,
  );
}

export function renderCancellation(
  snapshots: RunSnapshot[],
  expanded: boolean,
  theme: Theme,
  observedAt = Date.now(),
): Component {
  if (expanded) return renderRunSnapshots(snapshots, true, theme, observedAt);
  return component(() => {
    if (!snapshots.length) return [theme.fg("muted", "No runs cancelled")];
    const aborted = snapshots.filter((snapshot) => snapshot.status === "aborted").length;
    const terminal = snapshots.length - aborted;
    const suffix = terminal ? ` · ${terminal} already terminal` : "";
    return [theme.fg("muted", `◇ ${aborted} cancelled${suffix}`)];
  });
}

export function formatRunIds(runIds: string[]): string {
  const shown = runIds
    .slice(0, 3)
    .map((runId) => sanitizeRenderedValue(runId).replaceAll(/\s+/g, " ").slice(0, 40))
    .join(", ");
  return runIds.length > 3 ? `${shown}, +${runIds.length - 3} more` : shown;
}
