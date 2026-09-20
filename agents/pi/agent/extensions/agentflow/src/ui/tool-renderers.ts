// Tool-call renderers for agentflow's thirteen tools and its delivered result message.
//
// Mirrors `packages/pi-web-ui-client/src/client/tools/agentflow.tsx`. Nine tools launch a run
// and render its card; `status`/`wait`/`cancel` observe runs they did not launch, so they list
// run states and only open the full cards when expanded; `steer` reports an acknowledgement.
//
// A launching tool's header names the run and its prompt, so its card omits both.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { shortenPath } from "../../../lib/tools/format.ts";
import { liveRedraw } from "../../../lib/tools/live.ts";
import { details, expandHint, invalidArg, summary, toolName } from "../../../lib/tools/render.ts";
import {
  defineRenderer,
  optionalNumber,
  optionalText,
  requiredText,
  textList,
  type Renderer,
  type ResultView,
} from "../../../lib/tools/types.ts";
import type { RunResult, RunSnapshot } from "../types.ts";
import { boundedLines, formatPrompt, pluralize, sanitizeRenderedValue } from "./formatters.ts";
import {
  COLLAPSED_CHILD_ROWS,
  isRunTicking,
  renderRunCard,
  runStateRow,
  type RunCardOptions,
  type RunSection,
} from "./run-card.ts";
import type { Fact } from "../../../lib/tools/render.ts";

/** How much of the prompt a collapsed header shows. */
const COLLAPSED_PROMPT_CHARS = 120;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** A snapshot plus the exact structured result when its result shape retained one. */
interface RunEntry {
  snapshot: RunSnapshot;
  result?: unknown;
}

/** The run snapshots in a result, whichever shape the tool used to carry them. */
function runsOf(details: unknown): RunEntry[] {
  const payload = asRecord(details);
  const candidates: Array<{ snapshot: unknown; result?: unknown; error?: unknown }> = [];
  if (Array.isArray(payload.snapshot))
    candidates.push(...payload.snapshot.map((snapshot) => ({ snapshot })));
  else if (payload.snapshot)
    candidates.push({ snapshot: payload.snapshot, result: payload.result, error: payload.error });
  if (Array.isArray(payload.snapshots))
    candidates.push(...payload.snapshots.map((snapshot) => ({ snapshot })));
  if (Array.isArray(payload.results))
    for (const entry of payload.results as RunResult[]) {
      if (!entry?.snapshot) continue;
      candidates.push({ snapshot: entry.snapshot, result: entry.result, error: entry.error });
    }
  return candidates.flatMap((candidate) => {
    const snapshot = asRecord(candidate.snapshot);
    if (typeof snapshot.runId !== "string" || !Array.isArray(snapshot.nodes)) return [];
    return [
      {
        snapshot: {
          ...(candidate.snapshot as RunSnapshot),
          error:
            typeof candidate.error === "string"
              ? candidate.error
              : (candidate.snapshot as RunSnapshot).error,
        },
        result: candidate.result,
      },
    ];
  });
}

/**
 * The "now" a run's elapsed time is measured against.
 *
 * A control tool records the moment it observed the runs, so its rows stay put across
 * redraws — pinning that in `state` keeps a re-render from silently re-dating an old
 * observation. A launching tool records nothing, and its run may still be going, so its
 * elapsed time must be measured at render time: pinning the first render froze the clock
 * even when a later update redrew the row.
 */
function observedAt(result: ResultView, state: Record<string, unknown>): number {
  const recorded = asRecord(result.details).observedAt;
  if (typeof recorded === "number") {
    state.observedAt = recorded;
    return recorded;
  }
  return Date.now();
}

/** The tool's own text, all the model got when no snapshot could be read. */
function resultText(result: ResultView, theme: Theme, expanded: boolean): string {
  if (!result.text) return "";
  const text = sanitizeRenderedValue(result.text);
  return expanded
    ? `\n${theme.fg(result.isError ? "error" : "muted", boundedLines(text, 24).join("\n"))}`
    : summary(theme, oneLine(text).slice(0, 160), result.isError ? "error" : "dim");
}

const oneLine = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

/** A component whose lines are laid out already; each row is clipped, never wrapped. */
const rows = (lines: readonly string[]): Component => ({
  render: (width) => (width <= 0 ? [] : lines.map((line) => truncateToWidth(line, width, "…"))),
  invalidate() {},
});

// ---------------------------------------------------------------------------
// The nine run-launching tools
// ---------------------------------------------------------------------------

/** What a launching tool contributes beyond its run. */
interface LaunchArgs {
  /** Short accent shown right after the role label. */
  accent: string;
  background: boolean;
  /** The task, question or prompt this run was launched with. */
  prompt: string;
  facts: readonly Fact[];
  sections: readonly RunSection[];
}

function launchRenderer(
  name: string,
  label: string,
  decode: (raw: Readonly<Record<string, unknown>>) => LaunchArgs,
): Renderer {
  return defineRenderer<LaunchArgs>({
    names: [name],
    decode,
    header: (args, { theme, expanded }) => {
      const prompt = args.prompt
        ? expanded
          ? formatPrompt(args.prompt)
          : oneLine(formatPrompt(args.prompt)).slice(0, COLLAPSED_PROMPT_CHARS)
        : undefined;
      return `${toolName(theme, label)}${
        args.accent ? ` ${theme.fg("accent", sanitizeRenderedValue(args.accent))}` : ""
      }${details(theme, [args.background ? "background" : undefined, prompt])}`;
    },
    body: (args, result, ctx) => {
      const runs = runsOf(result.details);
      if (!runs.length) return resultText(result, ctx.theme, ctx.expanded);
      // A foreground run that is still going advances its own elapsed time; a background one
      // never hears from the engine again, so its card stays where the call left it. Control
      // tools do not tick either: their rows are observations, which `observedAt` pins.
      liveRedraw(
        ctx,
        runs.some((entry) => isRunTicking(entry.snapshot)),
      );
      const options: RunCardOptions = {
        expanded: ctx.expanded,
        facts: args.facts,
        sections: args.sections,
        observedAt: observedAt(result, ctx.state),
      };
      return cards(runs, options, ctx.theme);
    },
  });
}

/** The cards for one or more runs, separated when there is more than one. */
function cards(runs: readonly RunEntry[], options: RunCardOptions, theme: Theme): Component {
  const components = runs.map(({ snapshot, result }) =>
    renderRunCard(snapshot, { ...options, structuredResult: result }, theme),
  );
  return {
    render(width) {
      if (width <= 0) return [];
      const lines: string[] = [];
      for (const component of components) {
        if (lines.length) lines.push("", theme.fg("dim", "────────"));
        lines.push(...component.render(width));
      }
      return lines;
    },
    invalidate() {},
  };
}

const isBackground = (raw: Readonly<Record<string, unknown>>) => raw.mode === "background";

/** `paths`/`files` scope a read-only run; they are worth naming when present. */
function scopeFact(label: string, paths: readonly string[]): Fact[] {
  return paths.length ? [{ label, value: paths.map(shortenPath).join(", ") }] : [];
}

const finder = launchRenderer("agentflow_finder", "finder", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.task),
  facts: scopeFact("Paths", textList(raw.paths)),
  sections: [],
}));

const oracle = launchRenderer("agentflow_oracle", "oracle", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.question),
  facts: scopeFact("Files", textList(raw.files)),
  sections: [],
}));

const librarian = launchRenderer("agentflow_librarian", "librarian", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.question),
  facts: [],
  sections: [],
}));

// `look_at` is the one role whose target, not its prompt, identifies the call.
const lookAt = launchRenderer("agentflow_look_at", "look_at", (raw) => {
  const references = textList(raw.referenceFiles);
  return {
    accent: shortenPath(optionalText(raw.path)),
    background: isBackground(raw),
    prompt: optionalText(raw.objective),
    facts: [
      ...(references.length
        ? [{ label: "References", value: references.map(shortenPath).join(", ") }]
        : []),
      ...(raw.context ? [{ label: "Context", value: optionalText(raw.context) }] : []),
    ],
    sections: [],
  };
});

// A delegate run is defined by its contract, which is the whole point of the tool.
const delegate = launchRenderer("agentflow_delegate", "delegate", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.task),
  facts: raw.continuationSessionFile
    ? [{ label: "Continues", value: shortenPath(optionalText(raw.continuationSessionFile)) }]
    : [],
  sections: [
    { title: "Ownership", items: textList(raw.ownership).map(shortenPath) },
    { title: "Acceptance criteria", items: textList(raw.acceptanceCriteria) },
    { title: "Verification", items: textList(raw.verificationCommands) },
  ],
}));

const review = launchRenderer("agentflow_review", "review", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.task) || "Review the integrated diff",
  facts: [
    ...(raw.base ? [{ label: "Base", value: optionalText(raw.base) }] : []),
    ...scopeFact("Paths", textList(raw.paths)),
  ],
  sections: [],
}));

const claude = launchRenderer("agentflow_claude", "claude", (raw) => ({
  // The model is the choice being made here; `opus` is the tool's own default.
  accent: optionalText(raw.model) || "opus",
  background: isBackground(raw),
  prompt: optionalText(raw.task),
  facts: [],
  sections: [],
}));

const agent = launchRenderer("agentflow_agent", "agentflow_agent", (raw) => ({
  accent: optionalText(raw.label),
  background: isBackground(raw),
  prompt: optionalText(raw.prompt),
  facts: [
    ...(raw.model ? [{ label: "Model", value: optionalText(raw.model) }] : []),
    ...(raw.thinking ? [{ label: "Thinking", value: optionalText(raw.thinking) }] : []),
    ...(raw.cwd ? [{ label: "Cwd", value: shortenPath(optionalText(raw.cwd)) }] : []),
  ],
  sections: [],
}));

/**
 * A workflow script is not readable as a header line, but it must open with a static
 * `export const meta = { name, description }`, so name the workflow by that.
 */
function workflowMeta(script: string): { name: string; description: string } {
  const head = script.slice(0, 4_096);
  return {
    name: /\bname\s*:\s*["'`]([^"'`]{1,64})["'`]/.exec(head)?.[1] ?? "",
    description: /\bdescription\s*:\s*["'`]([^"'`]{1,256})["'`]/.exec(head)?.[1] ?? "",
  };
}

const workflow = launchRenderer("agentflow_workflow", "agentflow_workflow", (raw) => {
  const meta = workflowMeta(optionalText(raw.script));
  const limits = asRecord(raw.limits);
  const limit = (key: string) => optionalNumber(limits[key])?.toLocaleString() ?? "";
  return {
    accent: meta.name,
    background: isBackground(raw),
    prompt: meta.description,
    facts: [
      { label: "Max agents", value: limit("maxAgents") },
      { label: "Concurrency", value: limit("concurrency") },
      { label: "Token budget", value: limit("tokenBudget") },
    ],
    sections: [],
  };
});

// ---------------------------------------------------------------------------
// The four control tools
// ---------------------------------------------------------------------------

/**
 * `status`, `wait` and `cancel` observe runs they did not launch. Collapsed, they report which
 * runs they touched and what state each is in — repeating a launching card's detail there
 * would make a status check read like a launch. Expanded, the full cards are what the terminal
 * has always shown, and the `/agentflow` dashboard is one keystroke away for more.
 */
function controlRenderer(
  name: string,
  decode: (raw: Readonly<Record<string, unknown>>) => { target: string },
): Renderer {
  return defineRenderer({
    names: [name],
    decode,
    header: (args, { theme }) =>
      `${toolName(theme, name)}${details(theme, [args.target || undefined])}`,
    body: (_args, result, ctx) => {
      const runs = runsOf(result.details);
      if (!runs.length) return resultText(result, ctx.theme, ctx.expanded);
      if (ctx.expanded)
        return cards(
          runs,
          { expanded: true, promptSection: true, observedAt: observedAt(result, ctx.state) },
          ctx.theme,
        );
      const visible = runs.slice(0, COLLAPSED_CHILD_ROWS);
      const lines = visible.map(({ snapshot }) =>
        runStateRow(snapshot, ctx.theme, observedAt(result, ctx.state)),
      );
      if (runs.length > visible.length)
        lines.push(ctx.theme.fg("dim", `… ${pluralize(runs.length - visible.length, "more run")}`));
      const hint = expandHint(ctx.theme, false);
      if (hint) lines.push(hint);
      return rows(lines);
    },
  });
}

/** Run ids as the engine lists them: the first few, then a count. */
function runIdList(value: unknown): string {
  const ids = textList(value).map((id) =>
    sanitizeRenderedValue(id).replaceAll(/\s+/g, " ").slice(0, 40),
  );
  if (!ids.length) return "";
  const shown = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${shown}, +${ids.length - 3} more` : shown;
}

const statusTool = controlRenderer("agentflow_status", (raw) => ({
  target: optionalText(raw.runId) || "recent runs",
}));
const waitTool = controlRenderer("agentflow_wait", (raw) => ({ target: runIdList(raw.runIds) }));
const cancelTool = controlRenderer("agentflow_cancel", (raw) => ({
  target: runIdList(raw.runIds),
}));

const steerTool = defineRenderer({
  names: ["agentflow_steer"],
  decode: (raw) => ({
    runId: requiredText(raw.runId),
    nodeId: optionalText(raw.nodeId),
    message: optionalText(raw.message),
  }),
  header: (args, { theme, expanded }) => {
    const target = `${args.runId === null ? "" : sanitizeRenderedValue(args.runId)}${
      args.nodeId ? ` / ${sanitizeRenderedValue(args.nodeId)}` : ""
    }`;
    const message = args.message
      ? expanded
        ? sanitizeRenderedValue(args.message)
        : oneLine(sanitizeRenderedValue(args.message)).slice(0, COLLAPSED_PROMPT_CHARS)
      : undefined;
    return `${toolName(theme, "agentflow_steer")}${
      args.runId === null ? ` ${invalidArg(theme)}` : ""
    }${details(theme, [target || undefined, message])}`;
  },
  // Steering is acknowledged with the node it reached, not with a run snapshot.
  body: (_args, result, { theme, expanded }) => {
    const nodeId = asRecord(result.details).nodeId;
    if (result.isError || typeof nodeId !== "string") return resultText(result, theme, expanded);
    return summary(
      theme,
      nodeId ? `steering accepted for ${sanitizeRenderedValue(nodeId)}` : "steering accepted",
      "success",
    );
  },
});

export const AGENTFLOW_RENDERERS: readonly Renderer[] = [
  finder,
  oracle,
  librarian,
  lookAt,
  delegate,
  review,
  claude,
  agent,
  workflow,
  statusTool,
  waitTool,
  cancelTool,
  steerTool,
];

export function agentflowRenderer(name: string): Renderer {
  const renderer = AGENTFLOW_RENDERERS.find((entry) => entry.names.includes(name));
  if (!renderer) throw new Error(`no agentflow renderer for ${name}`);
  return renderer;
}

/**
 * A background run delivering its result as a follow-up message. It has no tool call to hang
 * off, so the card carries the prompt as its own section.
 */
export function renderResultMessage(
  detailsValue: unknown,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const entry = runsOf(detailsValue)[0];
  if (!entry) return rows([theme.fg("muted", "Agentflow result")]);
  const { snapshot, result } = entry;
  const role =
    snapshot.semanticRole ??
    (snapshot.kind === "workflow" ? "workflow" : (snapshot.nodes[0]?.semanticRole ?? "agent"));
  const card = renderRunCard(
    snapshot,
    { expanded: options.expanded, promptSection: true, role, structuredResult: result },
    theme,
  );
  return {
    render(width) {
      if (width <= 0) return [];
      return [
        truncateToWidth(`${toolName(theme, role)}${theme.fg("dim", " · result")}`, width, "…"),
        ...card.render(width),
      ];
    },
    invalidate() {},
  };
}

/** The renderer slots for one tool, spread into its `registerTool` call. */
export function slots(name: string) {
  const renderer = agentflowRenderer(name);
  return { renderCall: renderer.renderCall, renderResult: renderer.renderResult };
}
