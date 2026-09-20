// The `@ff-labs/pi-fff` search tools.
//
// These mirror the terminal renderers in `agent/extensions/lib/tools/fff.ts`.
// FFF's structured totals have tool-specific meanings: only `fffind` has a
// hidden match total, while grep counts remain derived from the printed shape.

import { pluralize, shortenPath } from "../format.ts";
import {
  ExpandableOutput,
  listResult,
  Output,
  ResultNotice,
  SearchHeader,
  Summary,
} from "./shared.tsx";
import {
  defineTool,
  flag,
  optionalNumber,
  requiredText,
  textList,
  type RegisteredTool,
  type ToolResultView,
} from "./types.ts";

const MAX_OUTPUT_LINES = 400;

function searchScope(path: string | null, exclude: readonly string[]): string[] {
  return [
    path === null ? "invalid path arg" : path ? `in ${shortenPath(path)}` : "",
    exclude.length ? `excluding ${exclude.join(", ")}` : "",
  ];
}

interface Totals {
  readonly matched: number;
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

/** Split only FFF's exact, leading fuzzy-fallback message. */
function splitLeadingNotice(text: string): { body: string; notice: string } {
  const match = /^\[(\d+ exact match(?:es)?\.[^\]\n]*)\]\n/.exec(text);
  return match
    ? { body: text.slice(match[0].length), notice: match[1] ?? "" }
    : { body: text, notice: "" };
}

/** Preserve content whitespace while removing the trailing notice parsed by `listResult`. */
function splitTrailingNotice(text: string): { body: string; notice: string } {
  const trimmed = text.trimEnd();
  const match = /\n\n\[([^\n]*)\]$/.exec(trimmed);
  return match
    ? { body: trimmed.slice(0, match.index), notice: match[1] ?? "" }
    : { body: trimmed, notice: "" };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`;
}

/** Counts grep matches and files from the output shape, never from `totalFiles`. */
function grepSummary(counts: Totals | undefined, lines: readonly string[]): string {
  const matched = lines.filter((line) => /^\s+\d+: /.test(line)).length;
  const files = lines.filter((line) => !/^\s/.test(line)).length;
  const total = matched || counts?.matched || 0;
  if (!total) return "no matches";
  return `${pluralize(total, "matching line")}${files > 1 ? ` in ${pluralize(files, "file")}` : ""}`;
}

function findSummary(counts: Totals | undefined, lines: readonly string[]): string {
  const matched = counts?.matched ?? lines.length;
  return [
    matched ? pluralize(matched, "path") : "no paths",
    counts?.pageIndex ? `page ${counts.pageIndex + 1}` : "",
    counts?.hasMore ? "more available" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function resultBody(
  result: ToolResultView | undefined,
  expanded: boolean,
  dkey: string,
  summarize: (counts: Totals | undefined, lines: readonly string[]) => string,
) {
  if (!result) return null;
  const leading = splitLeadingNotice(result.text);
  const content = splitTrailingNotice(leading.body);
  const { lines } = listResult(leading.body);
  const counts = totals(result.details);
  const nothingMatched = (counts?.matched ?? lines.length) === 0;
  const summary =
    nothingMatched && lines.length
      ? truncate(oneLine(lines.join(" ")), 160)
      : summarize(counts, lines);

  if (result.isError) {
    return expanded ? (
      <Output text={result.text} isError />
    ) : (
      <>
        <Summary text={result.text.split("\n")[0] || "failed"} status="error" />
        <ResultNotice notice={leading.notice} />
        <ResultNotice notice={content.notice} />
      </>
    );
  }

  return (
    <>
      {expanded ? (
        <ExpandableOutput text={content.body} maxLines={MAX_OUTPUT_LINES} dkey={`${dkey}:output`} />
      ) : (
        <Summary text={summary} />
      )}
      <ResultNotice notice={leading.notice} />
      <ResultNotice notice={content.notice} />
    </>
  );
}

const grepRenderer = (label: string): RegisteredTool =>
  defineTool({
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
    header: (args) => (
      <SearchHeader
        label={label}
        pattern={args.pattern}
        details={[
          ...searchScope(args.path, args.exclude),
          args.caseSensitive ? "case-sensitive" : "",
          args.context ? `±${args.context} context` : "",
          args.limit === undefined ? "" : `limit ${args.limit}`,
          args.paged ? "next page" : "",
        ]}
      />
    ),
    body: (_args, result, { expanded, dkey }) => resultBody(result, expanded, dkey, grepSummary),
  });

const findRenderer = (label: string): RegisteredTool =>
  defineTool({
    names: [label],
    decode: (raw) => ({
      pattern: requiredText(raw.pattern),
      path: requiredText(raw.path),
      exclude: textList(raw.exclude),
      limit: optionalNumber(raw.limit),
      paged: Boolean(raw.cursor),
    }),
    header: (args) => (
      <SearchHeader
        label={label}
        pattern={args.pattern}
        details={[
          ...searchScope(args.path, args.exclude),
          args.limit === undefined ? "" : `limit ${args.limit}`,
          args.paged ? "next page" : "",
        ]}
      />
    ),
    body: (_args, result, { expanded, dkey }) => resultBody(result, expanded, dkey, findSummary),
  });

const multiGrepRenderer = (label: string): RegisteredTool =>
  defineTool({
    names: [label],
    decode: (raw) => ({
      patterns: textList(raw.patterns),
      constraints: requiredText(raw.constraints),
      context: optionalNumber(raw.context),
      limit: optionalNumber(raw.limit),
      paged: Boolean(raw.cursor),
    }),
    header: (args) => (
      <SearchHeader
        label={label}
        pattern={args.patterns.join(", ")}
        details={[
          args.constraints === null
            ? "invalid constraints arg"
            : args.constraints
              ? `matching ${args.constraints}`
              : "",
          args.context ? `±${args.context} context` : "",
          args.limit === undefined ? "" : `limit ${args.limit}`,
          args.paged ? "next page" : "",
        ]}
      />
    ),
    body: (_args, result, { expanded, dkey }) => resultBody(result, expanded, dkey, grepSummary),
  });

export const FFF_TOOLS: readonly RegisteredTool[] = [
  grepRenderer("ffgrep"),
  findRenderer("fffind"),
  multiGrepRenderer("fff-multi-grep"),
];
