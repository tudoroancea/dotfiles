// Presentational primitives, the terminal counterparts of the browser's
// `client/tools/shared.tsx`. Each one returns styled text or a component, and the mapping
// between the two is documented in `../../TUI_RENDERING.md`.
//
// Text primitives return strings so a renderer can compose them into one wrapping `Text`;
// primitives whose browser counterpart sets `white-space: nowrap; text-overflow: ellipsis`
// return a component that clips each row instead.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeRenderedValue, statusIcon } from "./format.ts";

/** The `·` separator the browser uses between header and status-line facts. */
export const SEPARATOR = " · ";

/** Marks an argument whose payload carried something other than a string. */
export const invalidArg = (theme: Theme): string => theme.fg("error", "[invalid arg]");

/** `name` in the header, the browser's `.tool-name`. */
export const toolName = (theme: Theme, name: string): string =>
  theme.fg("toolTitle", theme.bold(name));

/** A path or pattern argument, the browser's `.tool-path` / `.tool-argument`. */
export const argument = (theme: Theme, value: string): string => theme.fg("accent", value);

/** The dim `·`-separated tail of a header, the browser's `.line-count`. */
export function details(theme: Theme, parts: readonly (string | undefined)[]): string {
  const tail = parts.filter((part): part is string => Boolean(part)).join(SEPARATOR);
  return tail ? theme.fg("dim", `${SEPARATOR}${tail}`) : "";
}

/**
 * Header for the four search tools (the built-in `grep`/`find` and fff's `ffgrep`/`fffind`):
 * the pattern is the call, and the flags that narrow it follow as a `·`-separated tail.
 */
export function searchHeader(
  theme: Theme,
  label: string,
  /** `null` when the payload carried a non-string pattern. */
  pattern: string | null,
  parts: readonly (string | undefined)[],
): string {
  const shown = pattern === null ? invalidArg(theme) : argument(theme, pattern || "…");
  return `${toolName(theme, label)} ${shown}${details(theme, parts)}`;
}

/**
 * The one-line result summary a collapsed box shows in place of full output. Sanitized like
 * `output` is: a summary is often the first line of a tool's own text — a failure message, or a
 * refusal quoting the arguments it was given — so it carries whatever the payload did.
 */
export function summary(
  theme: Theme,
  text: string,
  tone: "dim" | "error" | "success" = "dim",
): string {
  return text ? theme.fg(tone, sanitizeRenderedValue(text)) : "";
}

/** Full output inside an expanded box, tinted when the call failed. */
export function output(theme: Theme, text: string, isError = false): string {
  if (!text) return "";
  return `\n${theme.fg(isError ? "error" : "toolOutput", sanitizeRenderedValue(text))}`;
}

/**
 * Output bounded to `maxLines`. This is the terminal's answer to the browser's
 * `ExpandableOutput`: there is no inner disclosure to click, so each state picks a bound and
 * says what it left out.
 */
export function boundedOutput(
  theme: Theme,
  text: string,
  maxLines: number,
  isError = false,
): string {
  if (!text) return "";
  // Normalize line endings first: the sanitizer maps a stray CR to a space, so a CRLF
  // payload sanitized first would keep a trailing space on every line.
  const lines = sanitizeRenderedValue(text.replaceAll("\r\n", "\n")).split("\n");
  if (lines.length <= maxLines) return output(theme, lines.join("\n"), isError);
  const shown = lines.slice(0, maxLines).join("\n");
  const omitted = lines.length - maxLines;
  return `${output(theme, shown, isError)}\n${theme.fg("muted", `… ${omitted} more lines`)}`;
}

/** The bracketed limit/truncation notice a listing tool appended, if any. */
export function resultNotice(theme: Theme, notice: string): string {
  return notice ? theme.fg("warning", `[${sanitizeRenderedValue(notice)}]`) : "";
}

/** Heading for one section of an expanded card. */
export const sectionTitle = (theme: Theme, title: string): string =>
  theme.fg("toolTitle", theme.bold(title));

/** One row of a `facts` list. Empty values drop out so no blank rows appear. */
export interface Fact {
  label: string;
  value: string;
  error?: boolean;
}

/**
 * The browser renders these as a two-column CSS grid; a terminal has no grid, so each fact
 * becomes its own `Label: value` line.
 */
export function facts(theme: Theme, items: readonly Fact[]): string[] {
  return (
    items
      // A payload from an older session can omit a field the type says is required, so an
      // absent value drops out exactly like an empty one.
      .filter((item) => typeof item.value === "string" && item.value !== "")
      .map((item) =>
        item.error
          ? theme.fg("error", `${item.label}: ${sanitizeRenderedValue(item.value)}`)
          : theme.fg("dim", `${item.label}: ${sanitizeRenderedValue(item.value)}`),
      )
  );
}

/** The configured expand/collapse keybinding, absent outside the interactive TUI. */
export function expandHint(theme: Theme, expanded: boolean): string | undefined {
  try {
    return theme.fg("dim", keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"));
  } catch {
    return undefined;
  }
}

const statusTone = (status: string): "success" | "error" | "muted" | "accent" | "dim" => {
  if (status === "completed" || status === "success") return "success";
  if (status === "failed" || status === "error" || status === "timed_out") return "error";
  if (status === "aborted" || status === "cancelled") return "muted";
  if (status === "running") return "accent";
  return "dim";
};

/**
 * The status line that closes a run or job card: an icon and state, then a `·`-separated
 * tail of facts, then the box's own expansion hint. Mirrors the browser's `StatusLine`.
 */
export function statusLine(
  theme: Theme,
  status: string,
  options: {
    /** The state text, when it should read differently from `status`. */
    state?: string;
    parts: readonly (string | undefined)[];
    expanded: boolean;
  },
): string {
  const head = theme.fg(statusTone(status), `${statusIcon(status)} ${options.state ?? status}`);
  const tail = [
    ...options.parts
      .filter((part): part is string => Boolean(part))
      .map((part) => theme.fg("dim", part)),
    expandHint(theme, options.expanded),
  ].filter(Boolean);
  return [head, ...tail].join(theme.fg("dim", SEPARATOR));
}

/** Drop empty entries and join the rest into one block of styled text. */
export const block = (parts: readonly (string | undefined)[]): string =>
  parts.filter((part): part is string => Boolean(part)).join("\n");

/**
 * One terminal row per entry, clipped with an ellipsis instead of wrapped — the browser's
 * `white-space: nowrap; text-overflow: ellipsis` rows.
 */
export function rows(lines: readonly string[]): Component {
  return {
    render: (width) => (width <= 0 ? [] : lines.map((line) => truncateToWidth(line, width, "…"))),
    invalidate() {},
  };
}
