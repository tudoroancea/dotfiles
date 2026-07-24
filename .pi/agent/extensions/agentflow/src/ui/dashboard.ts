import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { withHerdrBlocked } from "../../../lib/herdr-blocked.ts";
import type { RunEngine } from "../runtime/run-engine.ts";
import type { RunResult, RunSnapshot, UsageSnapshot } from "../types.ts";
import {
  boundedLines,
  formatElapsed,
  formatPrompt,
  formatStatus,
  formatStyledToolCall,
  formatUsage,
  MAX_DETAIL_OUTPUT_LINES,
  MAX_DETAIL_PROMPT_LINES,
  sanitizeRenderedValue,
} from "./formatters.ts";

const ZERO_USAGE: UsageSnapshot = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
};

function runUsage(snapshot: RunSnapshot): UsageSnapshot {
  return snapshot.nodes.reduce(
    (total, node) => ({
      input: total.input + node.usage.input,
      output: total.output + node.usage.output,
      cacheRead: total.cacheRead + node.usage.cacheRead,
      cacheWrite: total.cacheWrite + node.usage.cacheWrite,
      total: total.total + node.usage.total,
      cost: total.cost + node.usage.cost,
    }),
    ZERO_USAGE,
  );
}

function initialPrompt(snapshot: RunSnapshot): string {
  return formatPrompt(snapshot.nodes[0]?.prompt);
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function valueText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[Value is not serializable]";
  }
}

const sanitizedLine = sanitizeRenderedValue;

function boundedWrapped(text: string | undefined, maxLines: number, width: number): string[] {
  const safe = boundedLines(text, maxLines).map(sanitizedLine);
  return safe.flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""])).slice(0, maxLines);
}

function completedNodes(snapshot: RunSnapshot): number {
  return snapshot.nodes.filter((node) => node.status === "completed").length;
}

/** Plain dashboard rows, exported to keep width-sensitive formatting focused and testable. */
export function renderRunList(
  snapshots: RunSnapshot[],
  selectedRunId: string | undefined,
  width: number,
  now = Date.now(),
): string[] {
  const lines: string[] = [];
  for (const snapshot of snapshots) {
    const selected = snapshot.runId === selectedRunId;
    const role = snapshot.semanticRole ?? snapshot.nodes[0]?.semanticRole ?? snapshot.kind;
    const marker = selected ? ">" : " ";
    const heading = `${marker} ${formatStatus(snapshot.status)} · ${role}`;
    const identity = width >= 100 ? ` · ${snapshot.name ?? snapshot.kind} · ${snapshot.runId}` : "";
    lines.push(truncateToWidth(sanitizedLine(`${heading}${identity}`), width));

    const prompt = singleLine(initialPrompt(snapshot));
    lines.push(truncateToWidth(`  ${prompt}`, width));

    const usage = runUsage(snapshot);
    const elapsed = formatElapsed(snapshot.createdAt, snapshot.completedAt, now);
    const progress =
      snapshot.kind === "workflow" && width >= 72
        ? ` · ${completedNodes(snapshot)}/${snapshot.nodes.length} completed`
        : "";
    lines.push(truncateToWidth(`  ${elapsed} · ${formatUsage(usage)}${progress}`, width));
  }
  return lines;
}

/** Dashboard detail view in information priority order. */
export function renderRunDetail(
  snapshot: RunSnapshot,
  width: number,
  theme: Theme,
  result?: RunResult,
  now = Date.now(),
): string[] {
  const usage = runUsage(snapshot);
  const lines = [
    truncateToWidth(
      `${formatStatus(snapshot.status)} · ${formatElapsed(snapshot.createdAt, snapshot.completedAt, now)} · ${formatUsage(usage)}`,
      width,
    ),
    "",
    "Prompt",
    ...boundedWrapped(initialPrompt(snapshot), MAX_DETAIL_PROMPT_LINES, width),
    "",
  ];

  if (snapshot.kind === "workflow") {
    lines.push(
      "Workflow",
      `${completedNodes(snapshot)}/${snapshot.nodes.length} completed${snapshot.currentPhase ? ` · phase ${sanitizedLine(snapshot.currentPhase)}` : ""}`,
      ...(snapshot.description ? boundedWrapped(snapshot.description, 4, width) : []),
      "",
    );
  }

  lines.push("Nodes");
  if (!snapshot.nodes.length) lines.push("(none)");
  for (const node of snapshot.nodes) {
    const role = node.semanticRole ? ` · ${sanitizedLine(node.semanticRole)}` : "";
    lines.push(
      `${formatStatus(node.status)} ${sanitizedLine(node.label)}${role} · ${formatElapsed(node.startedAt ?? node.queuedAt, node.completedAt, now)} · ${formatUsage(node.usage)}`,
    );
    if (node.phase) lines.push(`  phase: ${sanitizedLine(node.phase)}`);
    if (node.dependsOn?.length)
      lines.push(`  depends on: ${sanitizedLine(node.dependsOn.join(", "))}`);
    for (const call of node.toolCalls)
      lines.push(...formatStyledToolCall(call, theme, true).map((line) => `  ${line}`));
  }

  const output = valueText(result?.result) ?? snapshot.resultPreview;
  lines.push("", "Output / result", ...boundedWrapped(output, MAX_DETAIL_OUTPUT_LINES, width));

  const errors = [
    snapshot.error,
    result?.error,
    ...snapshot.nodes.map((node) => node.error),
    ...snapshot.nodes.flatMap((node) => node.toolCalls.map((call) => call.error)),
  ]
    .filter((error): error is string => Boolean(error))
    .map(sanitizedLine);
  const sessions = snapshot.nodes.flatMap((node) =>
    node.sessionFile ? [`${sanitizedLine(node.label)}: ${sanitizedLine(node.sessionFile)}`] : [],
  );
  lines.push(
    "",
    "Errors",
    ...(errors.length ? errors : ["(none)"]),
    "",
    "Sessions",
    ...(sessions.length ? sessions : ["(none)"]),
    "",
    "Artifacts",
    snapshot.artifactDir ? sanitizedLine(snapshot.artifactDir) : "(none)",
  );
  return lines.map((line) => truncateToWidth(line, width));
}

interface DashboardOptions {
  initialRunId?: string;
  results?: Map<string, RunResult | undefined>;
  resolveResult?: (runId: string) => RunResult | undefined;
  subscribe?: (listener: (snapshots: RunSnapshot[]) => void) => () => void;
  onClose: () => void;
  onCancel: (runId: string) => void;
  requestRender: () => void;
}

const DETAIL_VIEWPORT_HEIGHT = 40;
const UPDATE_DELAY_MS = 50;

export class AgentflowDashboard {
  private selectedRunId: string | undefined;
  private detailRunId: string | undefined;
  private detailOffset = 0;
  private pendingSnapshots: RunSnapshot[] | undefined;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private detailCache:
    | {
        snapshot: RunSnapshot;
        result: RunResult | undefined;
        width: number;
        second: number;
        lines: string[];
      }
    | undefined;

  constructor(
    private snapshots: RunSnapshot[],
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: DashboardOptions,
  ) {
    this.selectedRunId =
      snapshots.find((snapshot) => snapshot.runId === options.initialRunId)?.runId ??
      snapshots[0]?.runId;
    this.detailRunId = options.initialRunId ? this.selectedRunId : undefined;
    if (options.subscribe) {
      this.unsubscribe = options.subscribe((snapshots) => this.queueSnapshots(snapshots));
      this.elapsedTimer = setInterval(() => {
        if (!this.disposed) this.options.requestRender();
      }, 1_000);
    }
  }

  replaceSnapshot(snapshot: RunSnapshot): void {
    if (this.disposed) return;
    const index = this.snapshots.findIndex((candidate) => candidate.runId === snapshot.runId);
    if (index >= 0) this.snapshots[index] = snapshot;
    else this.snapshots.unshift(snapshot);
    this.detailCache = undefined;
    this.options.requestRender();
  }

  private queueSnapshots(snapshots: RunSnapshot[]): void {
    if (this.disposed) return;
    this.pendingSnapshots = snapshots;
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      const pending = this.pendingSnapshots;
      this.pendingSnapshots = undefined;
      if (!pending || this.disposed) return;
      this.snapshots = pending;
      for (const fresh of pending)
        this.options.results?.set(fresh.runId, this.options.resolveResult?.(fresh.runId));
      if (!pending.some((snapshot) => snapshot.runId === this.selectedRunId))
        this.selectedRunId = pending[0]?.runId;
      if (!pending.some((snapshot) => snapshot.runId === this.detailRunId)) {
        this.detailRunId = undefined;
        this.detailOffset = 0;
      }
      this.detailCache = undefined;
      this.options.requestRender();
    }, UPDATE_DELAY_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.updateTimer = undefined;
    this.elapsedTimer = undefined;
    this.pendingSnapshots = undefined;
  }

  private move(delta: number): void {
    if (!this.snapshots.length) return;
    if (this.detailRunId) {
      this.detailOffset = Math.max(0, this.detailOffset + delta);
      return;
    }
    const current = this.snapshots.findIndex((run) => run.runId === this.selectedRunId);
    const index = Math.max(0, Math.min(this.snapshots.length - 1, current + delta));
    this.selectedRunId = this.snapshots[index]?.runId;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.detailRunId) {
        this.detailRunId = undefined;
        this.detailOffset = 0;
      } else {
        this.dispose();
        this.options.onClose();
      }
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (!this.detailRunId) {
        this.detailRunId = this.selectedRunId;
        this.detailOffset = 0;
      }
    } else if (matchesKey(data, "k")) {
      this.move(-1);
    } else if (matchesKey(data, "j")) {
      this.move(1);
    } else if (this.detailRunId && this.keybindings.matches(data, "tui.select.pageUp")) {
      this.move(-DETAIL_VIEWPORT_HEIGHT);
    } else if (this.detailRunId && this.keybindings.matches(data, "tui.select.pageDown")) {
      this.move(DETAIL_VIEWPORT_HEIGHT);
    } else if (this.detailRunId && matchesKey(data, "g")) {
      this.detailOffset = 0;
    } else if (this.detailRunId && matchesKey(data, "shift+g")) {
      this.detailOffset = Number.MAX_SAFE_INTEGER;
    } else if (matchesKey(data, "x")) {
      const runId = this.detailRunId ?? this.selectedRunId;
      if (runId) this.options.onCancel(runId);
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const snapshot = this.snapshots.find((run) => run.runId === this.detailRunId);
    const title = snapshot
      ? `Agentflow · ${snapshot.name ?? snapshot.kind}`
      : `Agentflow runs · ${this.snapshots.length}`;
    let content: string[];
    if (snapshot) {
      const result = this.options.results?.get(snapshot.runId);
      const second = Math.floor(Date.now() / 1_000);
      if (
        !this.detailCache ||
        this.detailCache.snapshot !== snapshot ||
        this.detailCache.result !== result ||
        this.detailCache.width !== contentWidth ||
        this.detailCache.second !== second
      ) {
        this.detailCache = {
          snapshot,
          result,
          width: contentWidth,
          second,
          lines: renderRunDetail(snapshot, contentWidth, this.theme, result),
        };
      }
      const maximumOffset = Math.max(0, this.detailCache.lines.length - DETAIL_VIEWPORT_HEIGHT);
      this.detailOffset = Math.min(this.detailOffset, maximumOffset);
      content = this.detailCache.lines.slice(
        this.detailOffset,
        this.detailOffset + DETAIL_VIEWPORT_HEIGHT,
      );
      while (content.length < DETAIL_VIEWPORT_HEIGHT) content.push("");
    } else {
      content = renderRunList(this.snapshots, this.selectedRunId, contentWidth);
    }
    const key = (binding: "tui.select.confirm" | "tui.select.cancel") =>
      this.keybindings.getKeys(binding).join("/") || "unbound";
    const help = snapshot
      ? `j/k scroll · ${this.keybindings.getKeys("tui.select.pageUp").join("/") || "unbound"}/${this.keybindings.getKeys("tui.select.pageDown").join("/") || "unbound"} page · g/G ends · ${key("tui.select.cancel")} back · x cancel run`
      : `j/k navigate · ${key("tui.select.confirm")} inspect · ${key("tui.select.cancel")} close · x cancel run`;
    if (width < 6) {
      return [
        truncateToWidth(this.theme.fg("accent", this.theme.bold(title)), width),
        ...content.map((line) => truncateToWidth(line, width)),
        truncateToWidth(this.theme.fg("dim", help), width),
      ];
    }

    const topLabel = truncateToWidth(` ${title} `, width - 4, "…");
    const topFill = "─".repeat(Math.max(0, width - visibleWidth(topLabel) - 4));
    const helpLabel = truncateToWidth(` ${help} `, width - 4, "…");
    const helpFill = "─".repeat(Math.max(0, width - visibleWidth(helpLabel) - 4));
    const lines = [
      `${this.theme.fg("dim", "╭─")}${this.theme.fg("accent", this.theme.bold(topLabel))}${this.theme.fg("dim", `${topFill}─╮`)}`,
    ];
    for (const line of content) {
      const bounded = truncateToWidth(line, contentWidth, "…");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(bounded)));
      lines.push(`${this.theme.fg("dim", "│ ")}${bounded}${padding}${this.theme.fg("dim", " │")}`);
    }
    lines.push(
      `${this.theme.fg("dim", `╰─${helpFill}`)}${this.theme.fg("dim", helpLabel)}${this.theme.fg("dim", "─╯")}`,
    );
    return lines;
  }

  invalidate(): void {
    this.detailCache = undefined;
  }
}

async function showDashboard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  engine: RunEngine,
  initialRunId?: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "/agentflow requires interactive TUI mode; use agentflow_status in RPC mode.",
      "error",
    );
    return;
  }

  let snapshots: RunSnapshot[];
  try {
    snapshots = engine.listRuns();
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  if (!snapshots.length) {
    ctx.ui.notify("No Agentflow runs yet.", "info");
    return;
  }
  if (initialRunId && !snapshots.some((snapshot) => snapshot.runId === initialRunId)) {
    ctx.ui.notify(`Unknown run: ${initialRunId}`, "error");
    return;
  }
  const results = new Map(
    snapshots.map((snapshot) => [snapshot.runId, engine.getResult(snapshot.runId)]),
  );

  let dashboard: AgentflowDashboard | undefined;
  try {
    await withHerdrBlocked(pi.events, "Waiting for Agentflow dashboard input", () =>
      ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        let activeDashboard: AgentflowDashboard;
        const cancel = async (runId: string): Promise<void> => {
          try {
            const fresh = engine.getSnapshot(runId) as RunSnapshot;
            if (fresh.status !== "running" && fresh.status !== "queued") {
              activeDashboard.replaceSnapshot(fresh);
              ctx.ui.notify(`${runId} is no longer active.`, "info");
              return;
            }
            const confirmed = await ctx.ui.confirm(
              "Cancel Agentflow run?",
              `${runId} · ${fresh.name ?? fresh.kind}`,
            );
            if (!confirmed) return;
            await engine.cancel([runId]);
            const cancelled = engine.getSnapshot(runId) as RunSnapshot;
            activeDashboard.replaceSnapshot(cancelled);
            results.set(runId, engine.getResult(runId));
            ctx.ui.notify(`Cancellation requested for ${runId}.`, "info");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
        };
        activeDashboard = new AgentflowDashboard(snapshots, theme, keybindings, {
          initialRunId,
          results,
          resolveResult: (runId) => engine.getResult(runId),
          subscribe: (listener) => engine.subscribe(listener),
          onClose: () => done(undefined),
          onCancel: (runId) => void cancel(runId),
          requestRender: () => tui.requestRender(),
        });
        dashboard = activeDashboard;
        return activeDashboard;
      }),
    );
  } finally {
    dashboard?.dispose();
  }
}

export function registerDashboard(pi: ExtensionAPI, engine: RunEngine): void {
  pi.registerCommand("agentflow", {
    description: "Open the Agentflow run dashboard: /agentflow [runId]",
    handler: async (args, ctx) => showDashboard(pi, ctx, engine, args.trim() || undefined),
  });
}
