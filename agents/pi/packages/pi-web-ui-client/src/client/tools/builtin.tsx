// pi-coding-agent's built-in tools: bash, read, write, edit, ls, grep, find.
//
// Argument keys come from the tool schemas in
// `@earendil-works/pi-coding-agent/dist/core/tools/*.js`; every one of them names
// its file argument `path`.

import { compactCommand, pluralize, readTruncationNotice, shortenPath } from "../format.ts";
import { highlightCode, resolveLanguageFromPath } from "../highlight.ts";
import { decodeEditDiffRendererView, type EditDiffRendererView } from "../../wire/edit-diff.ts";
import {
  ImageBlock,
  InvalidArg,
  listResult,
  Output,
  ResultNotice,
  SearchHeader,
  Summary,
} from "./shared.tsx";
import {
  defineTool,
  flag,
  listLength,
  optionalNumber,
  optionalText,
  rawResult,
  requiredText,
  type RegisteredTool,
  type ToolResultView,
} from "./types.ts";

/** A trailing producer notice is metadata only when structured details prove truncation. */
function splitAppendedNotice(result: ToolResultView | undefined): {
  content: string;
  notice: string;
} {
  const text = result?.text ?? "";
  const details =
    typeof result?.details === "object" && result.details !== null
      ? (result.details as Record<string, unknown>)
      : {};
  const truncation =
    typeof details.truncation === "object" && details.truncation !== null
      ? (details.truncation as Record<string, unknown>)
      : {};
  if (truncation.truncated !== true) return { content: text, notice: "" };
  const trimmed = text.trimEnd();
  const match = /\n\n\[([^\n]*)\]$/.exec(trimmed);
  return match
    ? { content: trimmed.slice(0, match.index), notice: match[1] }
    : { content: text, notice: "" };
}

/** Lines of result text, treating the tools' explicit "(no output)" as none. */
function lineCount(result: ToolResultView | undefined): number {
  const text = splitAppendedNotice(result).content;
  if (!text || text === "(no output)") return 0;
  return text.split("\n").length;
}

/** The legacy file key is decoded here only; current calls continue to use `path`. */
function decodedToolPath(raw: Readonly<Record<string, unknown>>): string | null {
  return requiredText(raw.path ?? raw.file_path);
}

function PathValue({ path }: { path: string | null }) {
  if (path === null) return <InvalidArg />;
  return <>{path ? shortenPath(path) : "[path unavailable]"}</>;
}

/** Highlight known, bounded source directly; every fallback remains escaped Preact text. */
function SourceOutput({ text, path }: { text: string; path: string | null }) {
  if (!text) return null;
  const language = path === null ? undefined : resolveLanguageFromPath(path);
  if (!language) return <Output text={text} />;
  try {
    const highlighted = highlightCode(text, language);
    if (!highlighted.highlighted) return <Output text={text} />;
    return (
      <div class="tool-output markdown-content tool-code-output">
        <pre>
          <code
            class={`language-${language} hljs`}
            dangerouslySetInnerHTML={{ __html: highlighted.html }}
          />
        </pre>
      </div>
    );
  } catch {
    return <Output text={text} />;
  }
}

/**
 * A listing tool's result: the collapsed count and the notice it appended. `count`
 * measures what the tool actually returned, so it agrees with the content the
 * expanded view shows.
 */
function listBody(
  result: ToolResultView,
  expanded: boolean,
  summarize: (lines: readonly string[]) => string,
) {
  const { lines, notice } = listResult(result.text);
  return (
    <>
      {expanded ? (
        <Output text={result.text} isError={result.isError} />
      ) : (
        <Summary
          text={result.isError ? result.text.split("\n")[0] || "failed" : summarize(lines)}
          status={result.isError ? "error" : undefined}
        />
      )}
      {/* Shown in both states: a truncated result is worth knowing about even at a
          glance, and the expanded output has the notice stripped from its text. */}
      {expanded ? null : <ResultNotice notice={notice} />}
    </>
  );
}

/** `N nouns`, or an explicit empty statement so a collapsed box is never blank. */
function counted(lines: readonly string[], noun: string): string {
  return lines.length
    ? pluralize(lines.length, noun)
    : `no ${noun === "entry" ? "entries" : `${noun}s`}`;
}

function Diff({ view }: { view: EditDiffRendererView }) {
  return (
    <div class="tool-diff">
      <div class="diff-lines" aria-label={view.mode === "diff" ? "Unified diff" : "Edit result"}>
        {view.lines.map((line) => (
          <div key={line.sourceLine} class={`diff-line diff-${line.kind}`}>
            <pre class="diff-line-text">
              <span>{line.text}</span>
            </pre>
            {line.truncated ? (
              <span class="diff-line-omission">
                [{line.omittedBytes.toLocaleString()} bytes omitted from line]
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {view.sourceTruncated ? (
        <div class="diff-truncation">Additional source content omitted; total is unknown.</div>
      ) : null}
      {view.lineTruncated ? (
        <div class="diff-truncation">Long lines were truncated at the per-line byte limit.</div>
      ) : null}
      {view.mode === "fallback" ? (
        <div class="diff-truncation">Showing bounded plain-text fallback ({view.reason}).</div>
      ) : null}
    </div>
  );
}

const bash = defineTool({
  names: ["bash"],
  headerClass: "tool-command",
  decode: (raw) => ({
    command: requiredText(raw.command),
    timeout: optionalNumber(raw.timeout),
  }),
  // The command is the call, so the header owns it in full once expanded.
  header: (args, { expanded }) => (
    <>
      <span class="tool-name">$</span>{" "}
      <span class="tool-argument">
        {args.command === null ? (
          <InvalidArg />
        ) : expanded ? (
          args.command || "…"
        ) : (
          compactCommand(args.command)
        )}
      </span>
      {args.timeout === undefined ? null : (
        <span class="line-count">{` (${args.timeout}s timeout)`}</span>
      )}
    </>
  ),
  body: (_args, result, { expanded }) => {
    if (!result) return null;
    const split = result.isError
      ? { content: result.text, notice: "" }
      : splitAppendedNotice(result);
    // A streamed partial has no settled summary to report yet.
    if (expanded)
      return (
        <>
          <Output text={split.content} isError={result.isError} />
          <ResultNotice notice={split.notice} />
        </>
      );
    if (result.isPartial) return null;
    const count = lineCount(result);
    const summary = count ? pluralize(count, "output line") : "no output";
    return (
      <>
        <Summary
          text={result.isError ? `failed · ${summary}` : summary}
          status={result.isError ? "error" : undefined}
        />
        <ResultNotice notice={split.notice} />
      </>
    );
  },
});

const read = defineTool({
  names: ["read"],
  decode: (raw) => ({
    path: requiredText(raw.path),
    offset: optionalNumber(raw.offset),
    limit: optionalNumber(raw.limit),
  }),
  header: (args) => {
    const start = args.offset ?? (args.limit === undefined ? undefined : 1);
    const end =
      start !== undefined && args.limit !== undefined ? start + args.limit - 1 : undefined;
    return (
      <>
        <span class="tool-name">read</span>{" "}
        <span class="tool-path">
          {args.path === null ? <InvalidArg /> : shortenPath(args.path)}
          {start === undefined ? null : (
            <span class="line-numbers">{`:${start}${end === undefined ? "" : `-${end}`}`}</span>
          )}
        </span>
      </>
    );
  },
  body: (args, result, { expanded }) => {
    if (!result) return null;
    const truncation = readTruncationNotice(rawResult(result));
    const split = result.isError
      ? { content: result.text, notice: "" }
      : splitAppendedNotice(result);
    return (
      <>
        <ImageBlock list={result.images} cls="tool-image" />
        {expanded ? (
          result.isError || result.images.length ? (
            <Output text={split.content} isError={result.isError} />
          ) : (
            <SourceOutput text={split.content} path={args.path} />
          )
        ) : (
          // An unreadable file is the one thing worth surfacing while collapsed.
          <Summary
            text={result.isError ? result.text.split("\n")[0] : lineSummaryFor(result)}
            status={result.isError ? "error" : undefined}
          />
        )}
        <ResultNotice notice={split.notice} />
        {truncation && !split.notice ? <div class="read-truncation">{truncation}</div> : null}
      </>
    );
  },
});

/** File contents report their size; an image-only result reports the image instead. */
function lineSummaryFor(result: ToolResultView): string {
  if (result.images.length) return pluralize(result.images.length, "image");
  const count = lineCount(result);
  return count ? pluralize(count, "line") : "empty";
}

const write = defineTool({
  names: ["write"],
  decode: (raw) => ({
    path: decodedToolPath(raw),
    content: requiredText(raw.content),
  }),
  header: (args) => {
    const lines = args.content ? args.content.split("\n").length : 0;
    return (
      <>
        <span class="tool-name">write</span>{" "}
        <span class="tool-path">
          <PathValue path={args.path} />
        </span>
        {lines ? <span class="line-count"> · {pluralize(lines, "line")}</span> : null}
      </>
    );
  },
  // The header carries the size, so the body is the content itself; a successful
  // write has nothing else to report.
  body: (args, result, { expanded }) => (
    <>
      {args.content === null ? (
        <div class="tool-error">[invalid content arg - expected string]</div>
      ) : expanded && args.content ? (
        result?.isError ? (
          <Output text={args.content} />
        ) : (
          <SourceOutput text={args.content} path={args.path} />
        )
      ) : null}
      {result?.isError ? (
        expanded ? (
          <Output text={result.text} isError />
        ) : (
          <Summary text={result.text.split("\n")[0]} status="error" />
        )
      ) : null}
    </>
  ),
});

const edit = defineTool({
  names: ["edit"],
  decode: (raw) => ({
    path: decodedToolPath(raw),
    replacements: listLength(raw.edits),
  }),
  header: (args) => (
    <>
      <span class="tool-name">edit</span>{" "}
      <span class="tool-path">
        <PathValue path={args.path} />
      </span>
      {args.replacements ? (
        <span class="line-count"> · {pluralize(args.replacements, "replacement")}</span>
      ) : null}
    </>
  ),
  body: (_args, result, { expanded }) => {
    if (!result) return null;
    // A failed edit has no diff to show, only the reason it failed.
    if (result.isError)
      return expanded ? (
        <Output text={result.text} isError />
      ) : (
        <Summary text={result.text.split("\n")[0] || "failed"} status="error" />
      );
    // Unreadable details still yield a view: a bounded plain-text rendering of the
    // tool's own message, with the reason it could not be shown as a diff.
    const view = decodeEditDiffRendererView(result.details, rawResult(result));
    return (
      <>
        {/* Counts exist only for a real diff, and only once the producer is done —
            but the diff itself is worth watching accumulate while it streams. */}
        {view.mode === "diff" && !result.isPartial ? (
          <div class="compact-result diff-stats">
            <span class="diff-adds">+{view.stats.additions}</span> /{" "}
            <span class="diff-removes">-{view.stats.removals}</span>
            {view.stats.partial ? " · partial retained stats" : ""}
          </div>
        ) : null}
        {view.mode === "fallback" && !expanded ? (
          <Summary
            text={view.lines[0]?.text || result.text.split("\n")[0] || "applied"}
            status="success"
          />
        ) : null}
        {expanded ? <Diff view={view} /> : null}
      </>
    );
  },
});

const ls = defineTool({
  names: ["ls"],
  decode: (raw) => ({
    path: requiredText(raw.path),
    limit: optionalNumber(raw.limit),
  }),
  header: (args) => (
    <>
      <span class="tool-name">ls</span>{" "}
      <span class="tool-path">
        {args.path === null ? <InvalidArg /> : shortenPath(args.path || ".")}
      </span>
      {args.limit === undefined ? null : <span class="line-count"> · limit {args.limit}</span>}
    </>
  ),
  body: (_args, result, { expanded }) =>
    result ? listBody(result, expanded, (lines) => counted(lines, "entry")) : null,
});

const grep = defineTool({
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
  header: (args) => (
    <SearchHeader
      label="grep"
      pattern={args.pattern}
      details={[
        args.path === null ? "invalid path arg" : args.path ? `in ${shortenPath(args.path)}` : "",
        args.glob,
        args.ignoreCase ? "ignoring case" : "",
        args.literal ? "literal" : "",
        args.context ? `±${args.context} context` : "",
        args.limit === undefined ? "" : `limit ${args.limit}`,
      ]}
    />
  ),
  body: (_args, result, { expanded }) =>
    result
      ? listBody(result, expanded, (lines) => {
          const matches = lines.filter((line) => /:\d+: /.test(line));
          return counted(matches.length ? matches : lines, "matching line");
        })
      : null,
});

const find = defineTool({
  names: ["find"],
  decode: (raw) => ({
    pattern: requiredText(raw.pattern),
    path: requiredText(raw.path),
    limit: optionalNumber(raw.limit),
  }),
  header: (args) => (
    <SearchHeader
      label="find"
      pattern={args.pattern}
      details={[
        args.path === null ? "invalid path arg" : args.path ? `in ${shortenPath(args.path)}` : "",
        args.limit === undefined ? "" : `limit ${args.limit}`,
      ]}
    />
  ),
  body: (_args, result, { expanded }) =>
    result ? listBody(result, expanded, (lines) => counted(lines, "path")) : null,
});

export const BUILTIN_TOOLS: readonly RegisteredTool[] = [bash, read, write, edit, ls, grep, find];
