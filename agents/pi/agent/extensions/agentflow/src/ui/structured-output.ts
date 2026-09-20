import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import {
  DelegateOutputSchema,
  FinderOutputSchema,
  LibrarianOutputSchema,
  LookAtOutputSchema,
  OracleOutputSchema,
  ReviewOutputSchema,
  semanticProfiles,
} from "../semantic/profiles.ts";
import type { SemanticRole } from "../types.ts";
import { sanitizeRenderedValue } from "./formatters.ts";

export type StructuredFieldKind = "markdown" | "plain";

export interface StructuredField {
  label: string;
  kind: StructuredFieldKind;
  values: readonly string[];
}

export interface StructuredItem {
  label: string;
  fields: readonly StructuredField[];
}

export interface StructuredSection {
  label: string;
  fields: readonly StructuredField[];
  items: readonly StructuredItem[];
}

export interface StructuredOutput {
  sections: readonly StructuredSection[];
}

const MAX_ARRAY_ITEMS = 64;
const MAX_VISITED_VALUES = 512;
const MAX_TEXT_CHARS = 32 * 1024;

const field = (
  label: string,
  kind: StructuredFieldKind,
  value: string | readonly string[],
): StructuredField => ({ label, kind, values: typeof value === "string" ? [value] : value });

const section = (
  label: string,
  fields: readonly StructuredField[] = [],
  items: readonly StructuredItem[] = [],
): StructuredSection => ({ label, fields, items });

/** Reject hostile or unexpectedly large exact results before schema validation and projection. */
function withinDisplayBounds(value: unknown): boolean {
  let characters = 0;
  let visited = 0;
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (!current || current.depth > 8 || ++visited > MAX_VISITED_VALUES) return false;
    if (typeof current.value === "string") {
      characters += current.value.length;
      if (characters > MAX_TEXT_CHARS) return false;
    } else if (typeof current.value === "object" && current.value !== null) {
      if (seen.has(current.value)) return false;
      seen.add(current.value);
      if (Array.isArray(current.value)) {
        if (current.value.length > MAX_ARRAY_ITEMS) return false;
        for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      } else {
        const entries = Object.entries(current.value);
        if (entries.length > 16) return false;
        for (const [, item] of entries) pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function parseCandidate(role: SemanticRole, candidate: unknown): unknown | undefined {
  let value = candidate;
  if (typeof candidate === "string") {
    if (candidate.length > MAX_TEXT_CHARS) return undefined;
    try {
      value = JSON.parse(candidate);
    } catch {
      // Streamed and snapshot previews are routinely cut in the middle of JSON.
      return undefined;
    }
  }
  if (!withinDisplayBounds(value)) return undefined;
  return Check(semanticProfiles[role].outputSchema, value) ? value : undefined;
}

/** Decode every declared property of a complete semantic result, or return raw-text fallback. */
export function decodeStructuredOutput(
  role: string,
  candidate: unknown,
): StructuredOutput | undefined {
  if (
    role !== "finder" &&
    role !== "oracle" &&
    role !== "librarian" &&
    role !== "look_at" &&
    role !== "delegate" &&
    role !== "review"
  )
    return undefined;
  const value = parseCandidate(role, candidate);
  if (value === undefined) return undefined;

  if (role === "finder") {
    const output = value as Static<typeof FinderOutputSchema>;
    return {
      sections: [
        section("Summary", [field("", "markdown", output.summary)]),
        section(
          "Findings",
          [],
          output.findings.map((finding, index) => ({
            label: `Finding ${index + 1}`,
            fields: [
              field("Path", "plain", finding.path),
              field("Range", "plain", finding.range),
              field("Relevance", "markdown", finding.relevance),
            ],
          })),
        ),
        section("Unresolved questions", [field("", "markdown", output.unresolvedQuestions)]),
      ],
    };
  }
  if (role === "oracle") {
    const output = value as Static<typeof OracleOutputSchema>;
    return {
      sections: [
        section("Recommendation", [field("", "markdown", output.recommendation)]),
        section("Assumptions", [field("", "markdown", output.assumptions)]),
        section("Risks", [field("", "markdown", output.risks)]),
        section("Revisit conditions", [field("", "markdown", output.revisitConditions)]),
      ],
    };
  }
  if (role === "librarian") {
    const output = value as Static<typeof LibrarianOutputSchema>;
    return {
      sections: [
        section("Summary", [field("", "markdown", output.summary)]),
        section(
          "Sources",
          [],
          output.sources.map((source, index) => ({
            label: `Source ${index + 1}`,
            fields: [
              field("Title", "plain", source.title),
              field("URL", "plain", source.url),
              field("Evidence", "markdown", source.evidence),
            ],
          })),
        ),
        section("Unresolved questions", [field("", "markdown", output.unresolvedQuestions)]),
      ],
    };
  }
  if (role === "look_at") {
    const output = value as Static<typeof LookAtOutputSchema>;
    return {
      sections: [
        section("Summary", [field("", "markdown", output.summary)]),
        section("Observations", [field("", "markdown", output.observations)]),
        section(
          "Comparisons",
          [],
          output.comparisons.map((comparison, index) => ({
            label: `Comparison ${index + 1}`,
            fields: [
              field("Reference file", "plain", comparison.referenceFile),
              field("Similarities", "markdown", comparison.similarities),
              field("Differences", "markdown", comparison.differences),
            ],
          })),
        ),
        section("Uncertainties", [field("", "markdown", output.uncertainties)]),
      ],
    };
  }
  if (role === "delegate") {
    const output = value as Static<typeof DelegateOutputSchema>;
    return {
      sections: [
        section("Summary", [field("", "markdown", output.summary)]),
        section("Files changed", [field("", "plain", output.filesChanged)]),
        section(
          "Verification",
          [],
          output.verification.map((verification, index) => ({
            label: `Check ${index + 1}`,
            fields: [
              field("Command", "plain", verification.command),
              field("Status", "plain", verification.status),
              field("Output", "plain", verification.output),
            ],
          })),
        ),
        section("Follow-ups", [field("", "markdown", output.followUps)]),
      ],
    };
  }

  const output = value as Static<typeof ReviewOutputSchema>;
  return {
    sections: [
      section("Summary", [field("", "markdown", output.summary)]),
      section(
        "Findings",
        [],
        output.findings.map((finding, index) => ({
          label: `Finding ${index + 1}`,
          fields: [
            field("Severity", "plain", finding.severity),
            field("Path", "plain", finding.path),
            field("Location", "plain", finding.location),
            field("Explanation", "markdown", finding.explanation),
            field("Remediation", "markdown", finding.remediation),
          ],
        })),
      ),
    ],
  };
}

const clean = (value: string): string =>
  sanitizeRenderedValue(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n");

/** Build from the renderer's injected theme; only optional syntax highlighting reads Pi's global. */
const markdownTheme = (theme: Theme): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", text),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold?.(text) ?? text,
  italic: (text) => theme.italic?.(text) ?? text,
  underline: (text) => theme.underline?.(text) ?? text,
  strikethrough: (text) => theme.strikethrough?.(text) ?? text,
  highlightCode(code, language) {
    try {
      return getMarkdownTheme().highlightCode?.(code, language) ?? code.split("\n");
    } catch {
      // Unit/export hosts may render before Pi initializes its process-wide active theme.
      return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
    }
  },
});

/** Render the structured hierarchy with Markdown values indented below their field labels. */
export function renderStructuredOutput(
  output: StructuredOutput,
  theme: Theme,
  maxLines: number,
): Component {
  const markdown = new Map<string, Markdown>();
  const markdownFor = (value: string): Markdown => {
    const source = clean(value) || "(empty)";
    let component = markdown.get(source);
    if (!component) {
      component = new Markdown(source, 0, 0, markdownTheme(theme));
      markdown.set(source, component);
    }
    return component;
  };
  const appendPlain = (lines: string[], value: string, indent: number, width: number): void => {
    const prefix = " ".repeat(indent);
    const available = Math.max(1, width - indent);
    const source = clean(value).replaceAll("\t", "   ") || "(empty)";
    for (const physicalLine of source.split("\n")) {
      const line = theme.fg("muted", physicalLine);
      const columns = Math.max(1, visibleWidth(line));
      for (let start = 0; start < columns;) {
        let chunk = sliceByColumn(line, start, available, true);
        let consumed = visibleWidth(chunk);
        if (consumed === 0) {
          const boundary = sliceByColumn(line, start, available);
          consumed = Math.max(1, visibleWidth(boundary));
          chunk = truncateToWidth(boundary, available, "…");
        }
        lines.push(`${prefix}${chunk}`);
        start += consumed;
      }
    }
  };
  const appendMarkdown = (lines: string[], value: string, indent: number, width: number): void => {
    const prefix = " ".repeat(indent);
    const available = Math.max(1, width - indent);
    for (const line of markdownFor(value).render(available)) lines.push(`${prefix}${line}`);
  };
  const appendField = (lines: string[], value: StructuredField, indent: number, width: number) => {
    if (value.label)
      lines.push(
        `${" ".repeat(indent)}${truncateToWidth(theme.fg("dim", theme.bold(value.label)), Math.max(1, width - indent), "…")}`,
      );
    if (!value.values.length) {
      appendPlain(lines, "(none)", indent + (value.label ? 2 : 0), width);
      return;
    }
    const valueIndent = indent + (value.label ? 2 : 0);
    value.values.forEach((text, index) => {
      if (value.values.length > 1) {
        lines.push(`${" ".repeat(valueIndent)}${theme.fg("dim", `${index + 1}.`)}`);
        const nested = valueIndent + 2;
        if (value.kind === "markdown") appendMarkdown(lines, text, nested, width);
        else appendPlain(lines, text, nested, width);
      } else if (value.kind === "markdown") appendMarkdown(lines, text, valueIndent, width);
      else appendPlain(lines, text, valueIndent, width);
    });
  };

  return {
    render(width) {
      if (width <= 0) return [];
      const lines: string[] = [];
      for (const group of output.sections) {
        if (lines.length) lines.push("");
        lines.push(`  ${theme.fg("toolTitle", theme.bold(group.label))}`);
        for (const value of group.fields) appendField(lines, value, 4, width);
        if (!group.fields.length && !group.items.length) appendPlain(lines, "(none)", 4, width);
        group.items.forEach((item) => {
          lines.push(`    ${theme.fg("toolTitle", theme.bold(item.label))}`);
          for (const value of item.fields) appendField(lines, value, 6, width);
        });
      }
      if (lines.length <= maxLines) return lines.map((line) => truncateToWidth(line, width, "…"));
      return [
        ...lines.slice(0, Math.max(0, maxLines - 1)),
        theme.fg("dim", `… ${lines.length - maxLines + 1} more lines`),
      ].map((line) => truncateToWidth(line, width, "…"));
    },
    invalidate() {
      for (const component of markdown.values()) component.invalidate();
    },
  };
}
