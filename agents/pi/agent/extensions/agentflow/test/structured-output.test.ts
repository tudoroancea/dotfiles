import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { RunSnapshot } from "../src/types.ts";
import { renderRunCard } from "../src/ui/run-card.ts";
import {
  decodeStructuredOutput,
  renderStructuredOutput,
  type StructuredOutput,
} from "../src/ui/structured-output.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const fixtures = {
  finder: {
    summary: "# Finder summary\n\nUses **Markdown**.",
    findings: [{ path: "src/auth.ts", range: "10-20", relevance: "Calls `verify()` here." }],
    unresolvedQuestions: ["Does **legacy** auth still call this?"],
  },
  oracle: {
    recommendation: "# Prefer the queue",
    assumptions: ["Calls may run **concurrently**."],
    risks: ["A stale read can overwrite a write."],
    revisitConditions: ["Revisit if execution becomes serial."],
  },
  librarian: {
    summary: "# TypeBox rejects extras",
    sources: [
      {
        title: "TypeBox validation",
        url: "https://example.test/typebox",
        evidence: "The docs say `additionalProperties: false` is checked.",
      },
    ],
    unresolvedQuestions: ["Does `Repair` behave differently?"],
  },
  look_at: {
    summary: "# The diagram has two lanes",
    observations: ["The **left** lane owns input."],
    comparisons: [
      {
        referenceFile: "reference.png",
        similarities: ["Both use a blue boundary."],
        differences: ["Only the target has labels."],
      },
    ],
    uncertainties: ["The small caption is unreadable."],
  },
  delegate: {
    summary: "# Implemented the decoder",
    filesChanged: ["src/decode.ts"],
    verification: [{ command: "nub run test", status: "passed", output: "42 tests passed" }],
    followUps: ["Consider adding a **fuzz** test."],
  },
  review: {
    summary: "# One actionable issue",
    findings: [
      {
        severity: "high",
        path: "src/session.ts",
        location: "L40-L52",
        explanation: "The update can **race** another write.",
        remediation: "Put the full mutation in `withQueue()`.",
      },
    ],
  },
} as const;

const shape = (output: StructuredOutput) =>
  output.sections.map((section) => ({
    label: section.label,
    fields: section.fields.map((field) => [field.label, field.kind]),
    items: section.items.map((item) => ({
      label: item.label,
      fields: item.fields.map((field) => [field.label, field.kind]),
    })),
  }));

describe("semantic structured output", () => {
  it("decodes every property of all six role schemas with the intended display kind", () => {
    expect(shape(decodeStructuredOutput("finder", fixtures.finder)!)).toEqual([
      { label: "Summary", fields: [["", "markdown"]], items: [] },
      {
        label: "Findings",
        fields: [],
        items: [
          {
            label: "Finding 1",
            fields: [
              ["Path", "plain"],
              ["Range", "plain"],
              ["Relevance", "markdown"],
            ],
          },
        ],
      },
      { label: "Unresolved questions", fields: [["", "markdown"]], items: [] },
    ]);
    expect(shape(decodeStructuredOutput("oracle", fixtures.oracle)!)).toEqual([
      { label: "Recommendation", fields: [["", "markdown"]], items: [] },
      { label: "Assumptions", fields: [["", "markdown"]], items: [] },
      { label: "Risks", fields: [["", "markdown"]], items: [] },
      { label: "Revisit conditions", fields: [["", "markdown"]], items: [] },
    ]);
    expect(shape(decodeStructuredOutput("librarian", fixtures.librarian)!)).toEqual([
      { label: "Summary", fields: [["", "markdown"]], items: [] },
      {
        label: "Sources",
        fields: [],
        items: [
          {
            label: "Source 1",
            fields: [
              ["Title", "plain"],
              ["URL", "plain"],
              ["Evidence", "markdown"],
            ],
          },
        ],
      },
      { label: "Unresolved questions", fields: [["", "markdown"]], items: [] },
    ]);
    expect(shape(decodeStructuredOutput("look_at", fixtures.look_at)!)).toEqual([
      { label: "Summary", fields: [["", "markdown"]], items: [] },
      { label: "Observations", fields: [["", "markdown"]], items: [] },
      {
        label: "Comparisons",
        fields: [],
        items: [
          {
            label: "Comparison 1",
            fields: [
              ["Reference file", "plain"],
              ["Similarities", "markdown"],
              ["Differences", "markdown"],
            ],
          },
        ],
      },
      { label: "Uncertainties", fields: [["", "markdown"]], items: [] },
    ]);
    expect(shape(decodeStructuredOutput("delegate", fixtures.delegate)!)).toEqual([
      { label: "Summary", fields: [["", "markdown"]], items: [] },
      { label: "Files changed", fields: [["", "plain"]], items: [] },
      {
        label: "Verification",
        fields: [],
        items: [
          {
            label: "Check 1",
            fields: [
              ["Command", "plain"],
              ["Status", "plain"],
              ["Output", "plain"],
            ],
          },
        ],
      },
      { label: "Follow-ups", fields: [["", "markdown"]], items: [] },
    ]);
    expect(shape(decodeStructuredOutput("review", fixtures.review)!)).toEqual([
      { label: "Summary", fields: [["", "markdown"]], items: [] },
      {
        label: "Findings",
        fields: [],
        items: [
          {
            label: "Finding 1",
            fields: [
              ["Severity", "plain"],
              ["Path", "plain"],
              ["Location", "plain"],
              ["Explanation", "markdown"],
              ["Remediation", "markdown"],
            ],
          },
        ],
      },
    ]);
  });

  it("requires a complete exact schema and degrades partial previews to raw text", () => {
    expect(decodeStructuredOutput("finder", JSON.stringify(fixtures.finder))).toBeDefined();
    expect(decodeStructuredOutput("finder", '{"summary":"cut","findings":[')).toBeUndefined();
    expect(decodeStructuredOutput("finder", { ...fixtures.finder, extra: true })).toBeUndefined();
    expect(
      decodeStructuredOutput("delegate", {
        ...fixtures.delegate,
        verification: [{ command: "test", status: "maybe", output: "" }],
      }),
    ).toBeUndefined();
    expect(decodeStructuredOutput("agent", fixtures.finder)).toBeUndefined();
    expect(decodeStructuredOutput("finder", " ".repeat(32 * 1024 + 1))).toBeUndefined();
    expect(
      decodeStructuredOutput("look_at", {
        ...fixtures.look_at,
        comparisons: Array.from({ length: 64 }, (_, index) => ({
          referenceFile: `reference-${index}.png`,
          similarities: Array.from({ length: 64 }, () => ""),
          differences: Array.from({ length: 64 }, () => ""),
        })),
      }),
    ).toBeUndefined();
  });

  it("prefers an exact foreground result when the persisted preview is incomplete", () => {
    const snapshot: RunSnapshot = {
      runId: "run-review",
      kind: "agent",
      semanticRole: "review",
      status: "completed",
      createdAt: new Date(0).toISOString(),
      completedAt: new Date(1_000).toISOString(),
      phases: [],
      resultPreview: '{"summary":"truncated",',
      nodes: [
        {
          id: "review",
          label: "review",
          semanticRole: "review",
          prompt: "Review the change",
          cwd: "/work/project",
          status: "completed",
          tools: 0,
          toolCalls: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            cost: 0,
          },
        },
      ],
      logs: [],
    };
    const rendered = renderRunCard(
      snapshot,
      { expanded: true, structuredResult: fixtures.review },
      theme,
    )
      .render(100)
      .join("\n");
    expect(rendered).toContain("Summary");
    expect(rendered).toContain("One actionable issue");
    expect(rendered).toContain("Path");
    expect(rendered).toContain("src/session.ts");
    expect(rendered).not.toContain('{"summary":"truncated"');
  });

  it("keeps exact raw string results for non-semantic runs", () => {
    const snapshot: RunSnapshot = {
      runId: "run-agent",
      kind: "agent",
      status: "completed",
      createdAt: new Date(0).toISOString(),
      phases: [],
      resultPreview: "short preview",
      nodes: [
        {
          id: "agent",
          label: "agent",
          prompt: "Work",
          cwd: "/work/project",
          status: "completed",
          tools: 0,
          toolCalls: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            cost: 0,
          },
        },
      ],
      logs: [],
    };
    const rendered = renderRunCard(
      snapshot,
      { expanded: true, role: "agent", structuredResult: "exact first line\nexact second line" },
      theme,
    )
      .render(100)
      .join("\n");
    expect(rendered).toContain("exact first line\nexact second line");
    expect(rendered).not.toContain("short preview");

    const oversized = renderRunCard(
      snapshot,
      { expanded: true, role: "agent", structuredResult: "x".repeat(40 * 1024) },
      theme,
    ).render(40);
    expect(oversized.join("\n")).toContain("more characters");
    expect(oversized.length).toBeLessThanOrEqual(32);
    expect(oversized.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("indents nested Markdown headings, preserves plain metadata, and applies one line bound", () => {
    const output = decodeStructuredOutput("review", fixtures.review)!;
    const lines = renderStructuredOutput(output, theme, 24).render(48);
    expect(lines[0]).toBe("  Summary");
    expect(lines[1]?.startsWith("    ")).toBe(true);
    expect(lines.join("\n")).toContain("Path");
    expect(lines.join("\n")).toContain("src/session.ts");
    expect(lines.join("\n")).not.toContain("**race**");
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);

    const longPlain = decodeStructuredOutput("delegate", {
      ...fixtures.delegate,
      filesChanged: ["src/a-very-long-directory-name/and-a-long-file-name.ts"],
    })!;
    const wrappedPlain = renderStructuredOutput(longPlain, theme, 100).render(24).join("\n");
    expect(wrappedPlain).toContain("src/a-very-long");
    expect(wrappedPlain.replaceAll(/\s/g, "")).toContain(
      "src/a-very-long-directory-name/and-a-long-file-name.ts",
    );

    const widePlain = decodeStructuredOutput("delegate", {
      ...fixtures.delegate,
      filesChanged: ["abcd界e"],
    })!;
    const wrappedWide = renderStructuredOutput(widePlain, theme, 100).render(7);
    expect(wrappedWide.join("").replaceAll(/\s/g, "")).toContain("abcd界e");
    expect(wrappedWide.every((line) => visibleWidth(line) <= 7)).toBe(true);

    const bounded = renderStructuredOutput(
      decodeStructuredOutput("oracle", {
        ...fixtures.oracle,
        assumptions: Array.from({ length: 30 }, (_, index) => `Assumption ${index}`),
      })!,
      theme,
      8,
    ).render(32);
    expect(bounded).toHaveLength(8);
    expect(bounded.at(-1)).toMatch(/more lines/);
  });
});
