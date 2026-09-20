// One run, rendered the way the browser's `RunCard` renders it.
//
// Mirrors `packages/pi-web-ui-client/src/client/tools/agentflow.tsx`. Collapsed is the last
// few child rows closed by a status line; expanded adds the run's facts, whatever sections
// the launching tool contributes, the child list in full, the output and the logs.
//
// A workflow is described by its nodes and an agent run by its tool calls, so one card
// renders both: the child list is the only part that differs.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { facts, sectionTitle, statusLine, type Fact } from "../../../lib/tools/render.ts";
import type { NodeSnapshot, NodeStatus, RunSnapshot, SemanticRole } from "../types.ts";
import { decodeStructuredOutput, renderStructuredOutput } from "./structured-output.ts";
import {
  boundedLines,
  formatCost,
  formatDurationMs,
  formatElapsed,
  formatPrompt,
  formatStyledToolCall,
  formatTokens,
  formatUsage,
  MAX_DETAIL_OUTPUT_LINES,
  MAX_DETAIL_PROMPT_LINES,
  pluralize,
  sanitizeRenderedValue,
  statusIcon,
} from "./formatters.ts";

/** Child rows kept visible on a collapsed run, matching the browser's bound. */
export const COLLAPSED_CHILD_ROWS = 8;
/** Log lines an expanded card shows. */
const MAX_LOG_LINES = 5;
/** Exact string results share the browser decoder's raw-output character budget. */
const MAX_OUTPUT_CHARS = 32 * 1024;

function boundedOutputText(value: string): { text: string; notice?: string } {
  if (value.length <= MAX_OUTPUT_CHARS) return { text: value };
  let end = MAX_OUTPUT_CHARS;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), notice: `… ${value.length - end} more characters` };
}

/** A multi-line section a launching tool contributes to the expanded card. */
export interface RunSection {
  title: string;
  items: readonly string[];
}

export interface RunCardOptions {
  role?: SemanticRole | "agent" | "workflow";
  expanded?: boolean;
  /** Show the prompt in the collapsed status line, for a header that omits it. */
  collapsedPrompt?: boolean;
  /**
   * Render the prompt as its own section when expanded. Tool calls leave this off: their own
   * header carries the prompt (in full once expanded), so a section would duplicate it.
   * Callers without a header of their own — the background-result message, the dashboard —
   * turn it on.
   */
  promptSection?: boolean;
  /** Call-specific facts and sections the launching tool contributes. */
  facts?: readonly Fact[];
  sections?: readonly RunSection[];
  maxCollapsedCalls?: number;
  observedAt?: number;
  /** Exact semantic result retained by foreground/wait payloads; previews remain the fallback. */
  structuredResult?: unknown;
}

/** Role-specific result count read from the child's (possibly partial) JSON preview. */
export function runOutcome(role: string, preview: string | undefined): string {
  if (!preview) return "";
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(preview) as Record<string, unknown>;
  } catch {
    // Bounded streaming previews are often incomplete JSON.
    return "";
  }
  const plural = (items: unknown, noun: string) =>
    Array.isArray(items) ? pluralize(items.length, noun) : "";
  if (role === "finder" || role === "review") return plural(value.findings, "finding");
  if (role === "librarian") return plural(value.sources, "source");
  if (role === "look_at") return plural(value.observations, "observation");
  if (role === "delegate") return plural(value.filesChanged, "file");
  if (role === "oracle") return typeof value.recommendation === "string" ? "recommendation" : "";
  return "";
}

/**
 * The run's usage tail, as the browser assembles it: outcome · tools · tokens · cost. A
 * background run that is still going does not stream its usage, so the numbers would sit
 * there stale — it reports its mode in the status word instead.
 */
export function runSummary(snapshot: RunSnapshot, role: string): string {
  const node = snapshot.nodes[0];
  // Aggregated across nodes, as the browser's decoder does: a workflow's cost is the sum of
  // its children's, and one child with unknown cost makes the total unknown.
  const usage = snapshot.nodes.reduce(
    (total, item) => ({
      input: total.input + item.usage.input,
      output: total.output + item.usage.output,
      cacheRead: total.cacheRead + item.usage.cacheRead,
      cacheWrite: total.cacheWrite + item.usage.cacheWrite,
      total: total.total + item.usage.total,
      cost: total.cost + item.usage.cost,
      costKnown: total.costKnown !== false && item.usage.costKnown !== false,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, costKnown: true },
  );
  const tools = snapshot.nodes.reduce((count, item) => count + item.tools, 0);
  const outcome = runOutcome(role, snapshot.resultPreview ?? node?.resultPreview);
  return [outcome, `${tools} tools`, formatUsage(usage)].filter(Boolean).join(" · ");
}

/** A workflow's own status is authoritative; a single-node run reports the node's. */
const runStatus = (snapshot: RunSnapshot): string =>
  snapshot.kind === "workflow" ? snapshot.status : (snapshot.nodes[0]?.status ?? snapshot.status);

/** Whether this run is still going, which is what makes its card read as pending. */
export const isRunLive = (snapshot: RunSnapshot): boolean => {
  const status = runStatus(snapshot);
  return status === "queued" || status === "running";
};

/**
 * Whether this card's elapsed time is worth advancing — see `lib/tools/live.ts`.
 *
 * A background run is launched and then left: the engine writes its snapshot once and delivers
 * the settled run as a message of its own, so the launch card can never learn that the run
 * finished. A clock on it would still be counting hours later, next to a card that says
 * "running" because that is what was true when the call returned. So it stays put, and the
 * delivered result is where the real duration is.
 */
export const isRunTicking = (snapshot: RunSnapshot): boolean =>
  isRunLive(snapshot) && snapshot.background !== true;

const executionLabel = (node: NodeSnapshot | undefined): string | undefined =>
  node?.backend ? `${node.backend}/${node.model ?? "default"}` : undefined;

const colorStatus = (theme: Theme, status: string, text: string): string => {
  if (status === "completed") return theme.fg("success", text);
  if (status === "failed") return theme.fg("error", text);
  if (status === "aborted") return theme.fg("muted", text);
  if (status === "running") return theme.fg("accent", text);
  return theme.fg("dim", text);
};

/** Node rows preview the same bounded prompt beginning as a collapsed launch header. */
const MAX_NODE_PROMPT_CHARS = 120;
/** A workflow node previews only its most recent tool calls, like a collapsed subagent. */
const MAX_NODE_TOOL_CALLS = 4;

const earlierToolCalls = (count: number): string => `… ${count} earlier tool calls`;
const omittedToolCalls = (total: number, retained: number, displayed: number): number =>
  Math.max(0, total - displayed, retained - displayed);

const oneLinePrompt = (prompt: string | undefined): string =>
  prompt
    ? sanitizeRenderedValue(prompt).replaceAll(/\s+/g, " ").trim().slice(0, MAX_NODE_PROMPT_CHARS)
    : "";

const nodeStart = (node: NodeSnapshot): number | undefined => {
  const legacyCreatedAt = (node as NodeSnapshot & { createdAt?: string }).createdAt;
  const start = Date.parse(node.startedAt ?? node.queuedAt ?? legacyCreatedAt ?? "");
  return Number.isFinite(start) ? start : undefined;
};

const nodeEnd = (node: NodeSnapshot, now: number, allowOpenTiming: boolean): number | undefined => {
  if (node.completedAt) {
    const end = Date.parse(node.completedAt);
    return Number.isFinite(end) ? end : undefined;
  }
  return allowOpenTiming && (node.status === "running" || node.status === "queued")
    ? now
    : undefined;
};

/** A node's elapsed time, or "" when its span cannot be established (see the run's own rule). */
function nodeElapsed(node: NodeSnapshot, now: number, allowOpenTiming: boolean): string {
  const start = nodeStart(node);
  const end = nodeEnd(node, now, allowOpenTiming);
  return start !== undefined && end !== undefined ? formatDurationMs(Math.max(0, end - start)) : "";
}

/** A workflow phase, derived from its nodes: title, status, elapsed span, and its members. */
interface PhaseGroup {
  title: string;
  status: NodeStatus;
  elapsedMs: number;
  nodes: NodeSnapshot[];
}

/**
 * A phase's status, derived from its nodes: a failure anywhere fails it, anything running (or a
 * mix of queued and completed) leaves it running, all-queued is queued, and only once every
 * node has settled without failing is it completed (or aborted).
 */
function derivePhaseStatus(statuses: readonly NodeStatus[]): NodeStatus {
  if (statuses.some((value) => value === "failed")) return "failed";
  if (statuses.some((value) => value === "running")) return "running";
  const queued = statuses.some((value) => value === "queued");
  const completed = statuses.some((value) => value === "completed");
  if (queued) return completed ? "running" : "queued";
  if (statuses.some((value) => value === "aborted")) return "aborted";
  return "completed";
}

/** A phase's elapsed time: its earliest node start to its latest node end. */
function phaseElapsed(
  nodes: readonly NodeSnapshot[],
  now: number,
  allowOpenTiming: boolean,
): number {
  const starts = nodes
    .map((node) => nodeStart(node))
    .filter((value): value is number => value !== undefined);
  const ends = nodes
    .map((node) => nodeEnd(node, now, allowOpenTiming))
    .filter((value): value is number => value !== undefined);
  if (!starts.length || !ends.length) return 0;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

/**
 * Group a workflow's nodes by declared phase. Phase order follows the run's declared `phases`
 * when it has them, otherwise the order the phases first appear on the nodes; a node whose phase
 * is empty or not among those titles falls into the trailing ungrouped bucket (title "").
 */
function groupNodesByPhase(
  snapshot: RunSnapshot,
  nodes: readonly NodeSnapshot[],
  now: number,
  allowOpenTiming: boolean,
): PhaseGroup[] {
  const declared = [...new Set(snapshot.phases.filter(Boolean))].slice(0, 64);
  const titles = declared.length
    ? declared
    : [
        ...new Set(
          nodes.map((node) => node.phase).filter((phase): phase is string => Boolean(phase)),
        ),
      ];
  const titleSet = new Set(titles);
  const grouped = new Map<string, NodeSnapshot[]>(titles.map((title) => [title, []]));
  grouped.set("", []);
  for (const node of nodes) {
    const key = node.phase && titleSet.has(node.phase) ? node.phase : "";
    grouped.get(key)?.push(node);
  }
  const groups: PhaseGroup[] = [];
  for (const title of [...titles, ""]) {
    const members = grouped.get(title) ?? [];
    if (!members.length) continue;
    groups.push({
      title,
      status: derivePhaseStatus(members.map((node) => node.status)),
      elapsedMs: phaseElapsed(members, now, allowOpenTiming),
      nodes: members,
    });
  }
  return groups;
}

/** A phase heading: its title, derived status, and elapsed time. */
function phaseHeading(group: PhaseGroup, theme: Theme): string {
  const title = colorStatus(
    theme,
    group.status,
    `${statusIcon(group.status)} ${theme.bold(sanitizeRenderedValue(group.title))}`,
  );
  return group.elapsedMs
    ? `${title}${theme.fg("dim", ` · ${formatDurationMs(group.elapsedMs)}`)}`
    : title;
}

/** A node's closing status line: status · elapsed · N tools · tokens · cost. No expand hint. */
function nodeStatusLine(
  node: NodeSnapshot,
  theme: Theme,
  now: number,
  allowOpenTiming: boolean,
): string {
  const parts = [
    nodeElapsed(node, now, allowOpenTiming),
    pluralize(node.tools, "tool"),
    `${formatTokens(node.usage.total)} tokens`,
    node.usage.costKnown === false ? "cost unavailable" : formatCost(node.usage.cost),
  ].filter(Boolean);
  const head = colorStatus(theme, node.status, `${statusIcon(node.status)} ${node.status}`);
  return [head, ...parts.map((part) => theme.fg("dim", part))].join(theme.fg("dim", " · "));
}

/** Workflow labels use the same bounded column as the browser at narrow widths. */
const nodeLabel = (node: NodeSnapshot): string =>
  truncateToWidth(sanitizeRenderedValue(node.label), 16, "…");

/** A concise collapsed node row: status, label, and a short tail. */
function collapsedNodeRow(node: NodeSnapshot, theme: Theme): string {
  const head = `${colorStatus(theme, node.status, statusIcon(node.status))} ${theme.fg(
    "toolTitle",
    nodeLabel(node),
  )}`;
  return node.tools ? `${head} ${theme.fg("dim", `· ${pluralize(node.tools, "tool")}`)}` : head;
}

/**
 * An expanded workflow node, rendered like a collapsed standalone subagent: its label and the
 * start of its prompt, its most recent tool calls (without the per-tool args/results a top-level
 * call shows), then its status line.
 */
function expandedNodeLines(
  node: NodeSnapshot,
  theme: Theme,
  now: number,
  allowOpenTiming: boolean,
): string[] {
  const prompt = oneLinePrompt(node.prompt);
  const head = [
    theme.fg("toolTitle", nodeLabel(node)),
    prompt ? theme.fg("dim", `· ${prompt}`) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [head];
  const all = node.toolCalls ?? [];
  const calls = all.slice(-MAX_NODE_TOOL_CALLS);
  const omitted = omittedToolCalls(node.tools, all.length, calls.length);
  if (omitted > 0) lines.push(`  ${theme.fg("dim", earlierToolCalls(omitted))}`);
  for (const call of calls)
    for (const row of formatStyledToolCall(call, theme)) lines.push(`  ${row}`);
  lines.push(nodeStatusLine(node, theme, now, allowOpenTiming));
  return lines;
}

/**
 * A workflow's nodes, grouped by declared phase. Phase headings sit at the card's left; nodes
 * indent under them, and the ungrouped bucket renders last without a heading.
 */
function workflowNodeLines(
  snapshot: RunSnapshot,
  nodes: readonly NodeSnapshot[],
  theme: Theme,
  now: number,
  expanded: boolean,
  allowOpenTiming: boolean,
): string[] {
  const lines: string[] = [];
  const visible = new Set(nodes);
  for (const group of groupNodesByPhase(snapshot, snapshot.nodes, now, allowOpenTiming)) {
    const displayedNodes = group.nodes.filter((node) => visible.has(node));
    if (!displayedNodes.length) continue;
    if (group.title) lines.push(phaseHeading(group, theme));
    for (const node of displayedNodes)
      if (expanded)
        lines.push(
          ...expandedNodeLines(node, theme, now, allowOpenTiming).map((line) => `  ${line}`),
        );
      else lines.push(`  ${collapsedNodeRow(node, theme)}`);
  }
  return lines;
}

/** Lines of a section, wrapped to the available width. */
function wrapped(lines: readonly string[], width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const line of lines) out.push(...(line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
  if (out.length <= maxLines) return out;
  return [...out.slice(0, maxLines - 1), "…"];
}

export function renderRunCard(
  snapshot: RunSnapshot,
  options: RunCardOptions,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      const node = snapshot.nodes[0];
      const workflow = snapshot.kind === "workflow";
      const role =
        options.role ??
        snapshot.semanticRole ??
        (workflow ? "workflow" : (node?.semanticRole ?? "agent"));
      const status = runStatus(snapshot);
      const live = isRunLive(snapshot);
      const pending = snapshot.background === true && live;
      const summary = runSummary(snapshot, role);
      const execution = executionLabel(node);
      // A card the engine will never update again cannot report a duration: measuring it
      // against the clock at render time makes it grow on every unrelated redraw, long after
      // the run ended. So a background run's launch card reports its mode and nothing else,
      // exactly as it already omits the usage it would have to make up. The finished run
      // arrives as its own message, with the duration it really took.
      const elapsed = pending
        ? undefined
        : formatElapsed(
            node?.startedAt ?? node?.queuedAt ?? snapshot.createdAt,
            node?.completedAt ?? snapshot.completedAt,
            options.observedAt ?? Date.now(),
          );
      // Elapsed opens the tail in both states, as it does in the browser.
      const closing = (expanded: boolean): string =>
        statusLine(theme, status, {
          // The mode belongs to the status word ("running in the background") rather than to
          // a separate segment, which would just repeat the status.
          state: `${status}${pending ? " in the background" : ""}`,
          parts: [
            elapsed,
            options.collapsedPrompt && !expanded ? formatPrompt(node?.prompt) : undefined,
            execution,
            pending ? undefined : summary,
          ],
          expanded,
        });

      const now = options.observedAt ?? Date.now();
      const allowOpenTiming = !(snapshot.background === true && live);
      const toolCalls = node?.toolCalls ?? [];
      const lines: string[] = [];

      if (!options.expanded) {
        if (workflow) {
          const limit = Math.max(1, options.maxCollapsedCalls ?? COLLAPSED_CHILD_ROWS);
          const visible = snapshot.nodes.slice(-limit);
          const omitted = snapshot.nodes.length - visible.length;
          if (omitted > 0) lines.push(theme.fg("dim", `  … ${pluralize(omitted, "earlier node")}`));
          lines.push(...workflowNodeLines(snapshot, visible, theme, now, false, allowOpenTiming));
        } else {
          const visible = toolCalls.slice(
            -Math.max(1, options.maxCollapsedCalls ?? COLLAPSED_CHILD_ROWS),
          );
          const omitted = omittedToolCalls(
            node?.tools ?? toolCalls.length,
            toolCalls.length,
            visible.length,
          );
          if (omitted > 0) lines.push(theme.fg("dim", `  ${earlierToolCalls(omitted)}`));
          for (const child of visible)
            lines.push(...formatStyledToolCall(child, theme).map((line) => `  ${line}`));
        }
        lines.push(closing(false));
        return lines.map((line) => truncateToWidth(line, width, "…"));
      }

      // Expanded: run metadata first, then what the launching call asked for, then what the
      // child did, then its output. Sections without content are left out.
      lines.push("");
      lines.push(
        ...facts(theme, [
          { label: "Run", value: snapshot.runId },
          { label: "Cwd", value: node?.cwd ?? "" },
          { label: "Backend", value: node?.backend ?? "" },
          { label: "Model", value: node?.model ?? "" },
          { label: "Phases", value: snapshot.phases.join(" → ") },
          { label: "Session", value: node?.sessionFile ?? "" },
          { label: "Artifacts", value: snapshot.artifactDir ?? "" },
          ...(options.facts ?? []),
        ]),
      );
      for (const section of options.sections ?? []) {
        if (!section.items.length) continue;
        lines.push("", sectionTitle(theme, section.title));
        for (const item of section.items)
          lines.push(...wrapped([theme.fg("muted", sanitizeRenderedValue(item))], width, 8));
      }
      if (options.promptSection) {
        lines.push("", sectionTitle(theme, "Prompt"));
        lines.push(
          ...wrapped(
            boundedLines(formatPrompt(node?.prompt), MAX_DETAIL_PROMPT_LINES).map((line) =>
              theme.fg("muted", line),
            ),
            width,
            MAX_DETAIL_PROMPT_LINES,
          ),
        );
      }
      if (workflow) {
        if (snapshot.nodes.length) {
          lines.push("", sectionTitle(theme, "Nodes"));
          lines.push(
            ...workflowNodeLines(snapshot, snapshot.nodes, theme, now, true, allowOpenTiming),
          );
        }
      } else if (toolCalls.length || (node?.tools ?? 0) > 0) {
        lines.push("", sectionTitle(theme, "Tool calls"));
        const omitted = omittedToolCalls(
          node?.tools ?? toolCalls.length,
          toolCalls.length,
          toolCalls.length,
        );
        if (omitted > 0) lines.push(theme.fg("dim", earlierToolCalls(omitted)));
        for (const child of toolCalls) lines.push(...formatStyledToolCall(child, theme, true));
      }
      const errorOutput = node?.error ?? snapshot.error;
      const preview = snapshot.resultPreview ?? node?.resultPreview;
      const exactOutput =
        typeof options.structuredResult === "string"
          ? boundedOutputText(options.structuredResult)
          : undefined;
      const output = errorOutput ?? exactOutput?.text ?? preview;
      const isError = Boolean(errorOutput);
      const structured = isError
        ? undefined
        : decodeStructuredOutput(role, options.structuredResult ?? preview);
      if (output || structured) {
        lines.push("", sectionTitle(theme, isError ? "Error" : "Output"));
        if (structured)
          lines.push(
            ...renderStructuredOutput(structured, theme, MAX_DETAIL_OUTPUT_LINES).render(width),
          );
        else {
          const contentLines = exactOutput?.notice
            ? MAX_DETAIL_OUTPUT_LINES - 1
            : MAX_DETAIL_OUTPUT_LINES;
          lines.push(
            ...wrapped(
              boundedLines(output, contentLines).map((line) =>
                theme.fg(isError ? "error" : "muted", line),
              ),
              width,
              contentLines,
            ),
          );
          if (exactOutput?.notice) lines.push(theme.fg("dim", exactOutput.notice));
        }
      }
      if (snapshot.logs.length) {
        lines.push("", sectionTitle(theme, "Logs"));
        lines.push(
          ...wrapped(
            boundedLines(snapshot.logs.join("\n"), MAX_LOG_LINES).map((line) =>
              theme.fg("dim", line),
            ),
            width,
            MAX_LOG_LINES,
          ),
        );
      }
      lines.push("", closing(true));
      return lines.map((line) => truncateToWidth(line, width, "…"));
    },
    invalidate() {},
  };
}

/**
 * What a control tool reports for each run it touched: which run, in what state. Full detail
 * belongs to the run's own card, or to the `/agentflow` dashboard.
 */
export function runStateRow(snapshot: RunSnapshot, theme: Theme, observedAt: number): string {
  const node = snapshot.nodes[0];
  const role =
    snapshot.semanticRole ??
    (snapshot.kind === "workflow"
      ? "workflow"
      : (node?.semanticRole ?? snapshot.name ?? snapshot.kind));
  const live = snapshot.status === "queued" || snapshot.status === "running";
  const state = `${snapshot.status}${snapshot.background && live ? " in the background" : ""}`;
  const parts = [
    role,
    state,
    formatElapsed(snapshot.createdAt, snapshot.completedAt, observedAt),
    runOutcome(role, snapshot.resultPreview ?? node?.resultPreview),
  ].filter(Boolean);
  return `${colorStatus(theme, snapshot.status, statusIcon(snapshot.status))} ${theme.fg(
    "toolTitle",
    sanitizeRenderedValue(snapshot.runId),
  )} ${theme.fg("dim", parts.join(" · "))}`;
}
