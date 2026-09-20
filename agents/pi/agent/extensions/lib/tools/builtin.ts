// pi-coding-agent's built-in tools: bash, read, write, edit, ls, grep, find.
//
// Mirrors `packages/pi-web-ui-client/src/client/tools/builtin.tsx`. Collapsed follows the
// browser — one line naming the call and one line summarizing the result, never a window of
// raw output. Expanded is the union of both surfaces, which is why `read`/`ls`/`grep`/`find`
// hand their expanded body back to Pi's own renderer: it already produces syntax
// highlighting and the `[Truncated: …]` warnings the browser has no equivalent for.
//
// Argument keys come from the tool schemas in
// `@earendil-works/pi-coding-agent/dist/core/tools/*.js`; every one of them names its file
// argument `path`.

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  compactCommand,
  counted,
  lineCount,
  listResult,
  pluralize,
  shortenPath,
  splitNotice,
} from "./format.ts";
import {
  argument,
  block,
  boundedOutput,
  details,
  invalidArg,
  output,
  resultNotice,
  searchHeader,
  summary,
  toolName,
} from "./render.ts";
import {
  defineRenderer,
  flag,
  listLength,
  optionalNumber,
  optionalText,
  requiredText,
  type Renderer,
  type ResultView,
} from "./types.ts";

/** A built-in tool with the renderer slots we replace; an omitted slot is inherited. */
export interface BuiltinRegistration {
  /** Pi's own definition, schema types erased so one list can hold all seven. */
  definition: ToolDefinition<any, any, any>;
  renderer: Renderer;
}

/** How much output an expanded diff or long argument is worth showing inline. */
const MAX_DIFF_LINES = 400;
const MAX_CONTENT_LINES = 200;

/**
 * The file argument, accepting the `file_path` alias Pi's own renderers still read: a resumed
 * older session can carry tool calls recorded under that key.
 */
function toolPath(raw: Readonly<Record<string, unknown>>): string | null {
  return requiredText(raw.path ?? raw.file_path);
}

/** The first line of a failure, which is what a collapsed box has room for. */
const firstLine = (text: string): string => text.split("\n")[0] ?? "";

/**
 * A listing or search tool's collapsed body: the count of what the tool actually returned,
 * so it agrees with the content the expanded view shows, plus the notice it appended.
 */
function listSummary(
  result: ResultView,
  theme: Theme,
  summarize: (lines: readonly string[]) => string,
): string {
  const { lines, notice } = listResult(result.text);
  return block([
    result.isError
      ? summary(theme, firstLine(result.text) || "failed", "error")
      : summary(theme, summarize(lines)),
    // Shown while collapsed because a truncated result is worth knowing about at a glance;
    // when expanded the notice is already part of the delegated output.
    resultNotice(theme, notice),
  ]);
}

/**
 * The tool options Pi derives from settings when it builds its own definitions
 * (`agent-session.js` `_buildRuntime`). Overriding a built-in replaces its `execute` too, so
 * a re-created definition must carry them or the setting silently stops applying.
 */
export interface BuiltinToolOptions {
  autoResizeImages?: boolean;
  shellCommandPrefix?: string;
  shellPath?: string;
}

export function builtinRegistrations(
  cwd: string,
  options: BuiltinToolOptions = {},
): BuiltinRegistration[] {
  const bash = createBashToolDefinition(cwd, {
    commandPrefix: options.shellCommandPrefix,
    shellPath: options.shellPath,
  });
  const read = createReadToolDefinition(cwd, { autoResizeImages: options.autoResizeImages });
  const write = createWriteToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const ls = createLsToolDefinition(cwd);
  const grep = createGrepToolDefinition(cwd);
  const find = createFindToolDefinition(cwd);

  /** Pi's own body for this tool, used for the expanded state where it is richer. */
  const inherited = (
    definition: ToolDefinition<any, any, any>,
  ): NonNullable<Renderer["renderResult"]> => {
    const slot = definition.renderResult;
    if (!slot) throw new Error(`${definition.name} has no built-in renderResult to inherit`);
    return slot;
  };

  const bashRenderer = defineRenderer({
    names: ["bash"],
    decode: (raw) => ({
      command: requiredText(raw.command),
      timeout: optionalNumber(raw.timeout),
    }),
    // The command is the call, so the header owns it in full once expanded.
    header: (args, { theme, expanded }) =>
      `${toolName(theme, "$")} ${
        args.command === null
          ? invalidArg(theme)
          : argument(theme, expanded ? args.command || "…" : compactCommand(args.command))
      }${args.timeout === undefined ? "" : theme.fg("dim", ` (${args.timeout}s timeout)`)}`,
    body: (_args, result, { theme, expanded }) => {
      if (expanded) return output(theme, result.text, result.isError);
      // A streamed partial has no settled summary to report yet.
      if (result.isPartial) return "";
      const count = lineCount(result.text);
      const text = count ? pluralize(count, "output line") : "no output";
      return result.isError ? summary(theme, `failed · ${text}`, "error") : summary(theme, text);
    },
  });

  const readRenderer = defineRenderer({
    names: ["read"],
    // Header inherited: Pi's hyperlinks the path and labels skill reads, which the browser
    // has no counterpart for.
    decode: () => ({}),
    // Collapsed only; `withInheritedExpansion` hands the expanded state to Pi's renderer.
    body: (_args, result, { theme }) => {
      if (result.isError) return summary(theme, firstLine(result.text) || "failed", "error");
      // An image read also carries placeholder text ("Read image file [image/png]"), so the
      // images are the more informative count when there are any.
      const count = lineCount(result.text);
      const text = result.imageCount
        ? pluralize(result.imageCount, "image")
        : count
          ? pluralize(count, "line")
          : "empty";
      return block([
        summary(theme, text),
        // Pi repeats this when expanded; collapsed, it is the only sign the file was cut off.
        resultNotice(theme, splitNotice(result.text).notice),
      ]);
    },
  });

  const writeRenderer = defineRenderer({
    names: ["write"],
    decode: (raw) => ({
      path: toolPath(raw),
      content: requiredText(raw.content),
    }),
    // The content is an argument, not a result, so it belongs in this slot: a body only
    // renders once the write has finished, and watching the content stream in is the point.
    header: (args, { theme, expanded }) => {
      const lines = args.content ? args.content.split("\n").length : 0;
      const head = `${toolName(theme, "write")} ${
        args.path === null ? invalidArg(theme) : argument(theme, shortenPath(args.path) || "…")
      }${details(theme, [lines ? pluralize(lines, "line") : undefined])}`;
      if (args.content === null)
        return `${head}\n${theme.fg("error", "[invalid content arg - expected string]")}`;
      if (!expanded || !args.content) return head;
      return `${head}\n${boundedOutput(theme, args.content, MAX_CONTENT_LINES)}`;
    },
    // A successful write has nothing to report that the header does not already say.
    body: (_args, result, { theme, expanded }) => {
      if (!result.isError) return "";
      return expanded
        ? output(theme, result.text, true)
        : summary(theme, firstLine(result.text) || "failed", "error");
    },
  });

  const editRenderer = defineRenderer({
    names: ["edit"],
    decode: (raw) => ({
      path: toolPath(raw),
      replacements: listLength(raw.edits),
    }),
    header: (args, { theme }) =>
      `${toolName(theme, "edit")} ${
        args.path === null ? invalidArg(theme) : argument(theme, shortenPath(args.path) || "…")
      }${details(theme, [
        args.replacements ? pluralize(args.replacements, "replacement") : undefined,
      ])}`,
    body: (_args, result, { theme, expanded }) => {
      const diff = diffText(result.details);
      // Counts are only meaningful once the producer is done, but the diff itself is worth
      // watching accumulate — the browser makes the same distinction.
      if (result.isPartial && !(expanded && diff)) return "";
      if (result.isError || !diff) {
        const text = result.text || "applied";
        return expanded
          ? output(theme, text, result.isError)
          : summary(theme, firstLine(text), result.isError ? "error" : "success");
      }
      const { additions, removals } = diffStats(diff);
      const stats = result.isPartial
        ? ""
        : `${theme.fg("success", `+${additions}`)}${theme.fg("dim", " / ")}${theme.fg("error", `-${removals}`)}`;
      if (!expanded) return stats;
      const lines = diff.split("\n");
      const shown = lines
        .slice(0, MAX_DIFF_LINES)
        .map((line) => theme.fg(diffTone(line), line))
        .join("\n");
      const omitted = lines.length - MAX_DIFF_LINES;
      return block([
        stats,
        `\n${shown}`,
        omitted > 0 ? theme.fg("muted", `… ${omitted} more diff lines`) : undefined,
      ]);
    },
  });

  const lsRenderer = defineRenderer({
    names: ["ls"],
    decode: (raw) => ({
      path: requiredText(raw.path),
      limit: optionalNumber(raw.limit),
    }),
    header: (args, { theme }) =>
      `${toolName(theme, "ls")} ${
        args.path === null ? invalidArg(theme) : argument(theme, shortenPath(args.path || "."))
      }${details(theme, [args.limit === undefined ? undefined : `limit ${args.limit}`])}`,
    // Collapsed only; `withInheritedExpansion` hands the expanded state to Pi's renderer.
    body: (_args, result, { theme }) =>
      listSummary(result, theme, (lines) => counted(lines.length, "entry")),
  });

  const grepRenderer = defineRenderer({
    names: ["grep"],
    decode: (raw) => ({
      pattern: requiredText(raw.pattern),
      path: requiredText(raw.path),
      glob: optionalText(raw.glob),
      ignoreCase: flag(raw.ignoreCase),
      literal: flag(raw.literal),
      context: optionalNumber(raw.context),
      limit: optionalNumber(raw.limit),
    }),
    header: (args, { theme }) =>
      searchHeader(theme, "grep", args.pattern, [
        args.path === null
          ? "invalid path arg"
          : args.path
            ? `in ${shortenPath(args.path)}`
            : undefined,
        args.glob || undefined,
        args.ignoreCase ? "ignoring case" : undefined,
        args.literal ? "literal" : undefined,
        args.context ? `±${args.context} context` : undefined,
        args.limit === undefined ? undefined : `limit ${args.limit}`,
      ]),
    body: (_args, result, { theme }) =>
      listSummary(result, theme, (lines) => {
        const matches = lines.filter((line) => /:\d+: /.test(line));
        return counted((matches.length ? matches : lines).length, "matching line");
      }),
  });

  const findRenderer = defineRenderer({
    names: ["find"],
    decode: (raw) => ({
      pattern: requiredText(raw.pattern),
      path: requiredText(raw.path),
      limit: optionalNumber(raw.limit),
    }),
    header: (args, { theme }) =>
      searchHeader(theme, "find", args.pattern, [
        args.path === null
          ? "invalid path arg"
          : args.path
            ? `in ${shortenPath(args.path)}`
            : undefined,
        args.limit === undefined ? undefined : `limit ${args.limit}`,
      ]),
    body: (_args, result, { theme }) =>
      listSummary(result, theme, (lines) => counted(lines.length, "path")),
  });

  /** Expanded state delegates to Pi's renderer; collapsed state is ours. */
  const withInheritedExpansion = (
    definition: ToolDefinition<any, any, any>,
    renderer: Renderer,
  ): BuiltinRegistration => {
    const fallback = inherited(definition);
    const ours = renderer.renderResult!;
    return {
      definition,
      renderer: {
        ...renderer,
        renderResult: (result, options, theme, ctx) =>
          options.expanded
            ? fallback(result, options, theme, ctx)
            : ours(result, options, theme, ctx),
      },
    };
  };

  return [
    { definition: bash, renderer: bashRenderer },
    withInheritedExpansion(read, readRenderer),
    { definition: write, renderer: writeRenderer },
    { definition: edit, renderer: editRenderer },
    withInheritedExpansion(ls, lsRenderer),
    withInheritedExpansion(grep, grepRenderer),
    withInheritedExpansion(find, findRenderer),
  ];
}

// ---------------------------------------------------------------------------
// edit result details
// ---------------------------------------------------------------------------

function diffText(details: unknown): string {
  if (typeof details !== "object" || details === null) return "";
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : "";
}

/**
 * Pi's own `renderDiff` adds intra-line emphasis but reads the process-wide active theme,
 * which a renderer cannot depend on: it throws before `initTheme()`, and a throwing renderer
 * is silently swapped for Pi's fallback. Per-line coloring through the injected theme keeps
 * this pure, and matches what the browser draws.
 */
function diffTone(line: string): "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" {
  if (line.startsWith("+")) return "toolDiffAdded";
  if (line.startsWith("-")) return "toolDiffRemoved";
  return "toolDiffContext";
}

/** `details.diff` lines are `+<lineno> text` / `-<lineno> text` / ` <lineno> text`. */
function diffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) additions++;
    if (line.startsWith("-")) removals++;
  }
  return { additions, removals };
}
