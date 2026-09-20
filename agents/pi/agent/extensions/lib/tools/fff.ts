// The `@ff-labs/pi-fff` search tools.
//
// Mirrors `packages/pi-web-ui-client/src/client/tools/fff.tsx`. `ffgrep` and `fffind` look like
// the built-in `grep`/`find` but take different arguments — `exclude` instead of `glob`,
// `caseSensitive` instead of `ignoreCase`, and a `cursor` that pages a previous result, which is
// worth naming because a frecency-ranked page two is not the first page of results.
//
// Two things the vendor's own renderers do not do, and both surfaces should:
//
//   - report a total the printed text does not carry. Which field that is differs per tool, and
//     the names in `details` are misleading, so both are read against
//     `@ff-labs/fff-node`'s own documentation of them:
//       * `fffind` — `SearchResult.totalMatched` is "total number of items that matched", a real
//         total: the text is capped by `limit` and sampled down to five items when the top score
//         is scattered noise, so counting its lines undercounts badly. Use it.
//       * `ffgrep`, `fff-multi-grep` — `GrepResult.totalMatched` is "always equal to
//         items.length" and `formatGrepOutput` prints every item, so it says nothing the text
//         does not. There is no hidden total to recover here.
//       * `totalFiles`, in both, is "total number of indexed files (before any filtering)" — the
//         size of the repo index, not the number of files that matched. Never a summary. The
//         file count comes from the headings in the text, which is what the browser does.
//   - surface the bracketed notices the tools append (or, for the fuzzy fallback, prepend)
//     instead of leaving them inside a 15-line output window.
//
// Tool names are mode-dependent (`/fff-mode override` renames the pair to `grep`/`find`, and
// `fff-multi-grep` only exists under `PI_FFF_MULTIGREP=1`), so a renderer is built per name and
// prints the name it was registered under.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  counted,
  listResult,
  oneLine,
  pluralize,
  shortenPath,
  splitNotice,
  truncate,
} from "./format.ts";
import { block, boundedOutput, output, resultNotice, searchHeader, summary } from "./render.ts";
import {
  defineRenderer,
  flag,
  optionalNumber,
  requiredText,
  textList,
  type Renderer,
  type ResultView,
} from "./types.ts";

/** How much of a paged search result is worth showing inline when expanded. */
const MAX_OUTPUT_LINES = 400;

/** The `path`/`exclude` pair both tools share, phrased as the browser phrases it. */
const searchScope = (path: string | null, exclude: readonly string[]): (string | undefined)[] => [
  path === null ? "invalid path arg" : path ? `in ${shortenPath(path)}` : undefined,
  exclude.length ? `excluding ${exclude.join(", ")}` : undefined,
];

/**
 * What a tool reports about its own result, absent in a payload recorded before it did.
 * `totalFiles` is deliberately not read: see the note at the top of this file.
 */
interface Totals {
  readonly matched: number;
  /** 0-based, so a non-zero value means this result is a continuation page. */
  readonly pageIndex: number;
  readonly hasMore: boolean;
}

function totals(details: unknown): Totals | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const raw = details as Record<string, unknown>;
  if (typeof raw.totalMatched !== "number" || !Number.isFinite(raw.totalMatched)) return undefined;
  return {
    matched: raw.totalMatched,
    pageIndex: typeof raw.pageIndex === "number" ? raw.pageIndex : 0,
    hasMore: raw.hasMore === true,
  };
}

/**
 * The fuzzy-fallback notice `ffgrep` puts *before* its output, where every other notice in
 * either surface is appended. Split out for the same reason: it is guidance, not content.
 *
 * Anchored on the one message the vendor prepends rather than on "a first line in brackets",
 * because `ffgrep`'s first line is a file heading and a repository really can contain a
 * directory named `[id]`.
 */
function splitLeadingNotice(text: string): { body: string; notice: string } {
  const match = /^\[(\d+ exact match(?:es)?\.[^\]\n]*)\]\n/.exec(text);
  return match
    ? { body: text.slice(match[0].length), notice: match[1]! }
    : { body: text, notice: "" };
}

/**
 * Both tools share one body, as the vendor's own does: only the noun and the total it has differ.
 * Notices show in both states — unlike the built-ins, whose expanded output comes from Pi and
 * already contains them.
 */
function searchBody(
  result: ResultView,
  theme: Theme,
  expanded: boolean,
  summarize: (totals: Totals | undefined, lines: readonly string[]) => string,
): string {
  const leading = splitLeadingNotice(result.text);
  const content = splitNotice(leading.body);
  const notices = block([resultNotice(theme, leading.notice), resultNotice(theme, content.notice)]);
  if (result.isError)
    // Expanded shows the whole failure, as the vendor's renderer did and the built-ins still do.
    // Its raw text already carries the notices, so they are not appended to it twice.
    return expanded
      ? output(theme, result.text, true)
      : block([summary(theme, firstLine(result.text) || "failed", "error"), notices]);
  // `content.body`, not the counted lines: those have blank lines filtered out, and in `ffgrep` a
  // blank line is what separates one file's matches from the next.
  if (expanded) return block([boundedOutput(theme, content.body, MAX_OUTPUT_LINES), notices]);
  const counts = totals(result.details);
  const { lines } = listResult(leading.body);
  // A tool that matched nothing and still said something is refusing the call, not reporting an
  // empty result — `ffgrep` does this for a pattern like `.*`. Say what it said instead.
  const nothingMatched = (counts?.matched ?? lines.length) === 0;
  return block([
    nothingMatched && lines.length
      ? summary(theme, truncate(oneLine(lines.join(" ")), 160))
      : summary(theme, summarize(counts, lines)),
    notices,
  ]);
}

/** The first line of a failure, which is what a collapsed box has room for. */
const firstLine = (text: string): string => text.split("\n")[0] ?? "";

/**
 * `N matching lines in M files`, from the shape of the text: matches are the indented ` 12: line`
 * rows and file headings are the unindented ones. This is the browser's `grepSummary`, and for
 * grep it is not a fallback — the tool reports no total its text does not already carry, and its
 * `totalFiles` counts the repo index rather than the files that matched.
 */
function grepSummary(counts: Totals | undefined, lines: readonly string[]): string {
  const matched = lines.filter((line) => /^\s+\d+: /.test(line)).length;
  const files = lines.filter((line) => !/^\s/.test(line)).length;
  // `GrepResult.totalMatched` equals the number of items printed, so it only stands in when the
  // text is a shape the two patterns above do not recognize at all.
  const total = matched || counts?.matched || 0;
  if (!total) return "no matches";
  return `${pluralize(total, "matching line")}${files > 1 ? ` in ${pluralize(files, "file")}` : ""}`;
}

/** `N paths · page 2 · more available`. */
function findSummary(counts: Totals | undefined, lines: readonly string[]): string {
  return [
    counted(counts?.matched ?? lines.length, "path"),
    counts?.pageIndex ? `page ${counts.pageIndex + 1}` : "",
    counts?.hasMore ? "more available" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const grepRenderer = (label: string): Renderer =>
  defineRenderer({
    names: [label],
    decode: (raw) => ({
      pattern: requiredText(raw.pattern),
      path: requiredText(raw.path),
      exclude: textList(raw.exclude),
      caseSensitive: flag(raw.caseSensitive),
      context: optionalNumber(raw.context),
      limit: optionalNumber(raw.limit),
      paged: Boolean(raw.cursor),
    }),
    header: (args, { theme }) =>
      searchHeader(theme, label, args.pattern, [
        ...searchScope(args.path, args.exclude),
        args.caseSensitive ? "case-sensitive" : undefined,
        args.context ? `±${args.context} context` : undefined,
        args.limit === undefined ? undefined : `limit ${args.limit}`,
        args.paged ? "next page" : undefined,
      ]),
    body: (_args, result, { theme, expanded }) => searchBody(result, theme, expanded, grepSummary),
  });

const findRenderer = (label: string): Renderer =>
  defineRenderer({
    names: [label],
    decode: (raw) => ({
      pattern: requiredText(raw.pattern),
      path: requiredText(raw.path),
      exclude: textList(raw.exclude),
      limit: optionalNumber(raw.limit),
      paged: Boolean(raw.cursor),
    }),
    header: (args, { theme }) =>
      searchHeader(theme, label, args.pattern, [
        ...searchScope(args.path, args.exclude),
        args.limit === undefined ? undefined : `limit ${args.limit}`,
        args.paged ? "next page" : undefined,
      ]),
    body: (_args, result, { theme, expanded }) => searchBody(result, theme, expanded, findSummary),
  });

/**
 * The OR-pattern grep, which only exists under `PI_FFF_MULTIGREP=1` and has no browser
 * counterpart. Its patterns are the call and its result is `ffgrep`'s.
 */
const multiGrepRenderer = (label: string): Renderer =>
  defineRenderer({
    names: [label],
    decode: (raw) => ({
      patterns: textList(raw.patterns),
      constraints: requiredText(raw.constraints),
      context: optionalNumber(raw.context),
      limit: optionalNumber(raw.limit),
      paged: Boolean(raw.cursor),
    }),
    header: (args, { theme }) =>
      searchHeader(theme, label, args.patterns.join(", "), [
        args.constraints === null
          ? "invalid constraints arg"
          : args.constraints
            ? `matching ${args.constraints}`
            : undefined,
        args.context ? `±${args.context} context` : undefined,
        args.limit === undefined ? undefined : `limit ${args.limit}`,
        args.paged ? "next page" : undefined,
      ]),
    body: (_args, result, { theme, expanded }) => searchBody(result, theme, expanded, grepSummary),
  });

/**
 * Every name the vendor can register a tool under, across all three `/fff-mode` values. The
 * wrapper package looks each registration up here and reports the ones it does not find, so a
 * vendor rename surfaces instead of quietly leaving that tool on the vendor's own renderers.
 *
 * The `override` entries are a safety net rather than a live path: that mode renames the tools to
 * shadow the built-ins, and `builtin-tool-renderers.ts` registers `grep`/`find` first — Pi
 * resolves a name to its first registration — so in that mode Pi's own built-ins win and FFF's
 * native search is not reached at all. See the fff package README.
 */
export const FFF_RENDERERS: ReadonlyMap<string, Renderer> = new Map([
  ["ffgrep", grepRenderer("ffgrep")],
  ["fffind", findRenderer("fffind")],
  ["fff-multi-grep", multiGrepRenderer("fff-multi-grep")],
  // `/fff-mode override` renames the tools to shadow the built-ins.
  ["grep", grepRenderer("grep")],
  ["find", findRenderer("find")],
  ["multi_grep", multiGrepRenderer("multi_grep")],
]);
