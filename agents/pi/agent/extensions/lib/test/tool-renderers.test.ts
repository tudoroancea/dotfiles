import {
  initTheme,
  ToolExecutionComponent,
  type AgentToolResult,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import builtinToolRenderers from "../../builtin-tool-renderers.ts";
import { builtinRegistrations } from "../../lib/tools/builtin.ts";
import { FFF_RENDERERS } from "../../lib/tools/fff.ts";
import { liveRedraw, stopLiveRedraw } from "../../lib/tools/live.ts";
import { questionnaireRenderer } from "../../lib/tools/questionnaire.ts";
import {
  defineRenderer,
  type RenderContext,
  type Renderer,
  type SlotContext,
} from "../../lib/tools/types.ts";

/** Colors are ANSI wrappers, so an identity theme leaves the rendered text assertable. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const WIDTH = 100;

const registrations = builtinRegistrations("/workspace/project");
const rendererFor = (name: string): Renderer => {
  const registration = registrations.find((entry) => entry.definition.name === name);
  if (!registration) throw new Error(`no registration for ${name}`);
  return registration.renderer;
};

function slotContext(args: unknown, overrides: Partial<SlotContext> = {}): SlotContext {
  return {
    args,
    toolCallId: "call-1",
    cwd: "/workspace/project",
    expanded: false,
    isError: false,
    isPartial: false,
    executionStarted: true,
    argsComplete: true,
    showImages: false,
    lastComponent: undefined,
    state: {},
    invalidate: () => {},
    ...overrides,
  };
}

function renderHeader(
  renderer: Renderer,
  args: Record<string, unknown>,
  expanded = false,
): string[] {
  if (!renderer.renderCall) throw new Error(`${renderer.names.join()} inherits its header`);
  return renderer.renderCall(args, theme, slotContext(args, { expanded })).render(WIDTH);
}

function renderBody(
  renderer: Renderer,
  args: Record<string, unknown>,
  result: { text?: string; details?: unknown; images?: number },
  options: { expanded?: boolean; isPartial?: boolean; isError?: boolean } = {},
): string[] {
  if (!renderer.renderResult) throw new Error(`${renderer.names.join()} inherits its body`);
  const content: AgentToolResult<unknown>["content"] = [];
  if (result.text !== undefined) content.push({ type: "text", text: result.text });
  for (let index = 0; index < (result.images ?? 0); index++)
    content.push({ type: "image", data: "", mimeType: "image/png" });
  return renderer
    .renderResult(
      { content, details: result.details },
      { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
      theme,
      slotContext(args, {
        expanded: options.expanded ?? false,
        isError: options.isError ?? false,
        isPartial: options.isPartial ?? false,
      }),
    )
    .render(WIDTH);
}

/** The built-in under test, looked up by name; fff's renderers are keyed by name too. */
const header = (name: string, args: Record<string, unknown>, expanded = false): string[] =>
  renderHeader(rendererFor(name), args, expanded);
const body = (
  name: string,
  args: Record<string, unknown>,
  result: { text?: string; details?: unknown; images?: number },
  options: { expanded?: boolean; isPartial?: boolean; isError?: boolean } = {},
): string[] => renderBody(rendererFor(name), args, result, options);

/** `Text` pads every line to the viewport width; the padding is not part of the content. */
const text = (lines: string[]): string =>
  lines
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

describe("built-in tool renderers", () => {
  it("covers exactly Pi's built-in tools", () => {
    expect(registrations.map((entry) => entry.definition.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("keeps Pi's header for read and its own for the rest", () => {
    expect(rendererFor("read").renderCall).toBeUndefined();
    for (const name of ["bash", "write", "edit", "ls", "grep", "find"])
      expect(rendererFor(name).renderCall, name).toBeDefined();
  });

  describe("bash", () => {
    it("compacts a multi-line command in the header and expands it in full", () => {
      expect(text(header("bash", { command: "npm test\nnpm run lint", timeout: 30 }))).toBe(
        "$ npm test ↵ npm run lint (30s timeout)",
      );
      expect(text(header("bash", { command: "npm test\nnpm run lint" }, true))).toBe(
        "$ npm test\nnpm run lint",
      );
    });

    it("summarizes output while collapsed and shows it when expanded", () => {
      expect(text(body("bash", {}, { text: "one\ntwo\nthree" }))).toBe("3 output lines");
      // Pi appends a bracketed notice when it truncates; counting it would overstate by two.
      expect(
        text(
          body("bash", {}, { text: "one\ntwo\n\n[Showing lines 1-2 of 900. Full output: /tmp/x]" }),
        ),
      ).toBe("2 output lines");
      expect(text(body("bash", {}, { text: "" }))).toBe("no output");
      expect(text(body("bash", {}, { text: "one\ntwo" }, { expanded: true }))).toBe("one\ntwo");
    });

    it("marks a failure and stays silent about an unsettled partial", () => {
      expect(text(body("bash", {}, { text: "boom" }, { isError: true }))).toBe(
        "failed · 1 output line",
      );
      expect(body("bash", {}, { text: "partial" }, { isPartial: true })).toEqual([]);
    });

    it("flags a non-string command", () => {
      expect(text(header("bash", { command: 42 }))).toBe("$ [invalid arg]");
    });
  });

  describe("read", () => {
    it("summarizes the file it read", () => {
      expect(text(body("read", { path: "a.ts" }, { text: "one\ntwo" }))).toBe("2 lines");
      // An image read also returns placeholder text, so the images are the better count.
      expect(
        text(body("read", { path: "a.png" }, { text: "Read image file [image/png]", images: 1 })),
      ).toBe("1 image");
      expect(text(body("read", { path: "empty.ts" }, { text: "" }))).toBe("empty");
      expect(
        text(
          body("read", { path: "nope.ts" }, { text: "ENOENT: no such file" }, { isError: true }),
        ),
      ).toBe("ENOENT: no such file");
      expect(text(body("read", { path: "a.ts" }, { text: "" }, { isError: true }))).toBe("failed");
    });

    it("keeps the truncation notice visible while collapsed", () => {
      expect(
        text(
          body(
            "read",
            { path: "a.ts" },
            { text: "l1\nl2\n\n[500 more lines in file. Use offset=3 to continue.]" },
          ),
        ),
      ).toBe("2 lines\n[500 more lines in file. Use offset=3 to continue.]");
    });

    it("delegates the expanded body to Pi's renderer", () => {
      expect(
        text(body("read", { path: "a.ts" }, { text: "line one" }, { expanded: true })),
      ).toContain("line one");
    });
  });

  describe("write", () => {
    it("counts the content in the header and shows it once expanded", () => {
      expect(text(header("write", { path: "/workspace/project/a.ts", content: "a\nb\nc" }))).toBe(
        "write /workspace/project/a.ts · 3 lines",
      );
      // The blank line is the terminal's `.tool-output { margin-top }`.
      expect(text(header("write", { path: "a.ts", content: "a\nb" }, true))).toBe(
        "write a.ts · 2 lines\n\na\nb",
      );
    });

    it("accepts the file_path alias and marks a missing or invalid argument", () => {
      expect(text(header("write", { file_path: "a.ts", content: "x" }))).toBe(
        "write a.ts · 1 line",
      );
      expect(text(header("write", { content: "x" }))).toBe("write … · 1 line");
      expect(text(header("write", { path: "a.ts", content: 42 }))).toBe(
        "write a.ts\n[invalid content arg - expected string]",
      );
    });

    it("reports only failures", () => {
      expect(body("write", {}, { text: "" })).toEqual([]);
      expect(text(body("write", {}, { text: "EACCES: denied\nat write" }, { isError: true }))).toBe(
        "EACCES: denied",
      );
    });
  });

  describe("edit", () => {
    // The shape `details.diff` really has: `±<line number> <text>`, no unified-diff headers
    // (`dist/core/tools/edit-diff.js`).
    const diff = " 1 unchanged\n-2 old line\n+2 new line";

    it("names the file and the replacement count", () => {
      expect(text(header("edit", { path: "a.ts", edits: [{}, {}] }))).toBe(
        "edit a.ts · 2 replacements",
      );
    });

    it("shows diff stats collapsed and the diff itself expanded", () => {
      expect(text(body("edit", {}, { text: "", details: { diff } }))).toBe("+1 / -1");
      expect(text(body("edit", {}, { text: "", details: { diff } }, { expanded: true }))).toBe(
        `+1 / -1\n\n${diff}`,
      );
    });

    it("keeps showing a streaming diff when expanded, without counts", () => {
      expect(body("edit", {}, { text: "", details: { diff } }, { isPartial: true })).toEqual([]);
      expect(
        text(
          body("edit", {}, { text: "", details: { diff } }, { expanded: true, isPartial: true }),
        ),
        // `text()` trims, and the first context line starts with a space.
      ).toBe(diff.trim());
    });

    it("falls back to the tool's message when there is no diff", () => {
      expect(text(body("edit", {}, { text: "applied 1 edit" }))).toBe("applied 1 edit");
      expect(text(body("edit", {}, { text: "no match found\ncontext" }, { isError: true }))).toBe(
        "no match found",
      );
    });
  });

  describe("ls, grep and find", () => {
    it("counts entries, matches and paths instead of dumping output", () => {
      expect(text(body("ls", { path: "src" }, { text: "a.ts\nb.ts\nc.ts" }))).toBe("3 entries");
      expect(text(body("ls", { path: "src" }, { text: "(empty directory)" }))).toBe("no entries");
      expect(
        text(body("grep", { pattern: "x" }, { text: "a.ts:1: x\na.ts:9: x\nb.ts:2: x" })),
      ).toBe("3 matching lines");
      expect(
        text(body("find", { pattern: "x" }, { text: "No files found matching pattern" })),
      ).toBe("no paths");
    });

    it("separates the bracketed limit notice from the counted content", () => {
      expect(
        text(
          body(
            "grep",
            { pattern: "x" },
            { text: "a.ts:1: x\nb.ts:2: x\n\n[100 matches limit reached. Use limit=200 for more]" },
          ),
        ),
      ).toBe("2 matching lines\n[100 matches limit reached. Use limit=200 for more]");
    });

    it("reports a failure instead of a count", () => {
      expect(text(body("ls", { path: "nope" }, { text: "ENOENT" }, { isError: true }))).toBe(
        "ENOENT",
      );
    });

    it("spells out the arguments the browser shows", () => {
      expect(
        text(
          header("grep", {
            pattern: "handler",
            path: "/workspace/project/src",
            glob: "*.ts",
            ignoreCase: true,
            literal: true,
            context: 2,
            limit: 50,
          }),
        ),
      ).toBe(
        "grep handler · in /workspace/project/src · *.ts · ignoring case · literal · ±2 context · limit 50",
      );
      expect(text(header("find", { pattern: "*.ts", limit: 20 }))).toBe("find *.ts · limit 20");
      expect(text(header("ls", {}))).toBe("ls .");
    });

    it("delegates the expanded body to Pi's renderer", () => {
      expect(text(body("ls", { path: "src" }, { text: "a.ts\nb.ts" }, { expanded: true }))).toBe(
        "a.ts\nb.ts",
      );
    });
  });
});

/**
 * The vendor's own renderers are replaced wholesale (`agent/extensions/fff`), so these are the
 * only renderers these tools ever get. The wrapper's own test proves they are attached.
 */
describe("fff search tools", () => {
  const renderer = (name: string): Renderer => {
    const found = FFF_RENDERERS.get(name);
    if (!found) throw new Error(`no fff renderer for ${name}`);
    return found;
  };
  // `ffgrep` groups matches under a file heading, separates files with a blank line, and indents
  // matches as ` 12: line` and context rows as ` 11- line`.
  const grepOutput = "src/a.ts\n 12: const handler = 1\n 11- context\n\nsrc/b.ts\n 3: handler()";

  it("spells out the arguments the vendor drops", () => {
    expect(
      text(
        renderHeader(renderer("ffgrep"), {
          pattern: "handler",
          path: "src/",
          exclude: ["test/", "*.min.js"],
          caseSensitive: true,
          context: 2,
          limit: 50,
          cursor: "fff_c1",
        }),
      ),
      // Wrapped, not clipped: a header is styled text in a `Text`, as the browser wraps its own.
    ).toBe(
      "ffgrep handler · in src/ · excluding test/, *.min.js · case-sensitive · ±2 context · limit 50 · next\npage",
    );
    expect(text(renderHeader(renderer("fffind"), { pattern: "profile", limit: 30 }))).toBe(
      "fffind profile · limit 30",
    );
  });

  it("counts grep matches and files from the text, never from `totalFiles`", () => {
    // Real `details` for this output: `GrepResult.totalMatched` equals the number of items
    // printed, and `totalFiles` is the size of the repo index — 521 files here, 2 of which
    // matched. Reporting `totalFiles` as "files" is the mistake this asserts against.
    expect(
      text(
        renderBody(
          renderer("ffgrep"),
          {},
          { text: grepOutput, details: { totalMatched: 2, totalFiles: 521 } },
        ),
      ),
    ).toBe("2 matching lines in 2 files");
    // The text is the authority for grep: `totalMatched` is documented as equal to the number of
    // items printed, so a payload where they disagree is not one to believe.
    expect(
      text(
        renderBody(
          renderer("ffgrep"),
          {},
          { text: grepOutput, details: { totalMatched: 999, totalFiles: 521 } },
        ),
      ),
    ).toBe("2 matching lines in 2 files");
    expect(
      text(
        renderBody(
          renderer("ffgrep"),
          {},
          { text: "No matches found", details: { totalMatched: 0, totalFiles: 521 } },
        ),
      ),
    ).toBe("no matches");
    // A route directory named `[id]` is content: the trailing-notice split is one line only.
    expect(
      text(
        renderBody(
          renderer("ffgrep"),
          {},
          { text: "src/a.ts\n 12: const a = 1\n\n[locale]/page.tsx\n 3: const x = arr[0]" },
        ),
      ),
    ).toBe("2 matching lines in 2 files");
  });

  it("counts find paths from the total, which its text does not carry", () => {
    // `SearchResult.totalMatched` is a real total: the text is capped by `limit`, and sampled
    // down to five items when the top score is weak.
    expect(
      text(
        renderBody(
          renderer("fffind"),
          {},
          { text: "a.ts\nb.ts\nc.ts", details: { totalMatched: 179, totalFiles: 521 } },
        ),
      ),
    ).toBe("179 paths");
    expect(
      text(
        renderBody(
          renderer("fffind"),
          {},
          {
            text: "No files found matching pattern",
            details: { totalMatched: 0, totalFiles: 521 },
          },
        ),
      ),
    ).toBe("no paths");
  });

  it("names a continuation page and the pages still to come", () => {
    expect(
      text(
        renderBody(
          renderer("fffind"),
          {},
          {
            text: "a.ts",
            details: { totalMatched: 90, totalFiles: 521, pageIndex: 2, hasMore: true },
          },
        ),
      ),
    ).toBe("90 paths · page 3 · more available");
  });

  it("repeats a refusal instead of reporting an empty result", () => {
    // The wildcard guard: no matches, not an error, and a message worth reading.
    const guard =
      "Pattern '.*' matches everything — grep needs a concrete substring or identifier. " +
      "Example: `pattern: 'MyClass'`.";
    expect(
      text(
        renderBody(
          renderer("ffgrep"),
          {},
          { text: guard, details: { totalMatched: 0, totalFiles: 0 } },
        ),
      ),
    ).toContain("matches everything");
  });

  it("splits out the notices the vendor leaves inside its output window", () => {
    expect(
      text(
        renderBody(
          renderer("ffgrep"),
          {},
          {
            text: `${grepOutput}\n\n[Continue with cursor="fff_c2"]`,
            details: { totalMatched: 2, totalFiles: 521 },
          },
        ),
      ),
    ).toBe('2 matching lines in 2 files\n[Continue with cursor="fff_c2"]');
    // The fuzzy fallback puts its notice first instead, and it must not become content.
    const fuzzy = text(
      renderBody(
        renderer("ffgrep"),
        {},
        {
          text: `[0 exact matches. Maybe you meant this?]\n${grepOutput}`,
          details: { totalMatched: 2, totalFiles: 521 },
        },
        { expanded: true },
      ),
    );
    expect(fuzzy).toContain("[0 exact matches. Maybe you meant this?]");
    expect(fuzzy).toContain(" 12: const handler = 1");
    // A file heading in brackets is content, not a notice: only the vendor's own message is one.
    expect(
      text(
        renderBody(renderer("ffgrep"), {}, { text: "[id]\n 3: x", details: { totalMatched: 1 } }),
      ),
    ).toBe("1 matching line");
  });

  it("keeps the blank lines that separate one file's matches from the next", () => {
    expect(text(renderBody(renderer("ffgrep"), {}, { text: grepOutput }, { expanded: true }))).toBe(
      grepOutput,
    );
  });

  it("shows a failure in full when expanded and its first line when collapsed", () => {
    const failure = "Failed to create FFF file finder: index is locked\nat FileFinder.create";
    expect(text(renderBody(renderer("fffind"), {}, { text: failure }, { isError: true }))).toBe(
      "Failed to create FFF file finder: index is locked",
    );
    expect(
      text(
        renderBody(renderer("fffind"), {}, { text: failure }, { isError: true, expanded: true }),
      ),
    ).toBe(failure);
  });

  it("renders under every name the three modes register", () => {
    expect([...FFF_RENDERERS.keys()].sort()).toEqual(
      ["ffgrep", "fffind", "fff-multi-grep", "grep", "find", "multi_grep"].sort(),
    );
    expect(text(renderHeader(renderer("grep"), { pattern: "x" }))).toBe("grep x");
    expect(
      text(renderHeader(renderer("fff-multi-grep"), { patterns: ["a", "b"], constraints: "*.ts" })),
    ).toBe("fff-multi-grep a, b · matching *.ts");
  });
});

describe("questionnaire", () => {
  const QUESTIONS = [
    {
      id: "scope",
      label: "Scope",
      prompt: "Which scope should be changed?",
      options: [
        { value: "small", label: "Small", description: "Only the affected module" },
        { value: "all", label: "All", description: "Every related module" },
      ],
    },
    { id: "notes", prompt: "Anything else?", options: [{ value: "none", label: "Nothing else" }] },
  ];
  const ANSWERS = [
    { id: "scope", value: "all", label: "All", wasCustom: false, index: 2 },
    { id: "notes", value: "Ship it", label: "Ship it", wasCustom: true },
  ];
  const args = { questions: QUESTIONS };

  /**
   * What Pi's shell composes into its one box: `renderCall` always, `renderResult` once a
   * result exists. Rendering both is what shows the header and the body agreeing.
   */
  function row(
    result: { text?: string; details?: unknown; isError?: boolean } | undefined,
    options: { expanded?: boolean; isPartial?: boolean } = {},
    activeTheme: Theme = theme,
  ): string[] {
    const isPartial = result ? (options.isPartial ?? false) : true;
    const ctx = slotContext(args, {
      expanded: options.expanded ?? false,
      isError: result?.isError ?? false,
      isPartial,
    });
    const lines = questionnaireRenderer.renderCall!(args, activeTheme, ctx).render(WIDTH);
    if (result)
      lines.push(
        ...questionnaireRenderer.renderResult!(
          {
            content: [{ type: "text", text: result.text ?? "" }],
            details: result.details,
          },
          { expanded: options.expanded ?? false, isPartial },
          activeTheme,
          ctx,
        ).render(WIDTH),
      );
    return lines;
  }

  const answered = {
    text: "Scope: user selected: 2. All\nQ2: user wrote: Ship it",
    details: { questions: QUESTIONS, answers: ANSWERS, cancelled: false },
  };

  it("counts the questions it asked and names them", () => {
    // Pending is the header alone: Pi calls the body slot only once a result exists, and tints
    // its own box `toolPendingBg` until then — which is exactly the state being reported.
    expect(text(row(undefined))).toBe("questionnaire · 2 questions (Scope, Q2)");
  });

  it("collapses to one status line and expands to the browser's view", () => {
    expect(text(row(answered))).toBe(
      "questionnaire · 2 questions (Scope, Q2)\n2 of 2 questions answered.",
    );
    expect(text(row(answered, { expanded: true }))).toBe(
      [
        "questionnaire · 2 questions (Scope, Q2)",
        "2 of 2 questions answered.",
        "",
        "Scope: ✓ Selected: All",
        "Q2: ✓ Custom answer: Ship it",
        "",
        "Scope — Which scope should be changed?",
        "  – Option: Small — Only the affected module",
        "  ✓ Selected: All — Every related module",
        "Q2 — Anything else?",
        "  – Option: Nothing else",
      ].join("\n"),
    );
  });

  it("reports cancellation, failure and answers left unanswered", () => {
    const cancelled = {
      text: "User cancelled the questionnaire",
      details: { questions: QUESTIONS, answers: [], cancelled: true },
    };
    expect(text(row(cancelled))).toContain("Questionnaire was cancelled.");
    expect(text(row(cancelled, { expanded: true }))).toContain("Scope: Not answered");
    // A legacy failure carries no `isError`, only a cancellation and an `Error:` message. It
    // also carries no normalized questions, so the header falls back to the ones asked for.
    expect(text(row({ text: "Error: No questions provided", details: { cancelled: true } }))).toBe(
      "questionnaire · 2 questions (Scope, Q2)\nError: No questions provided",
    );
    // A running questionnaire says nothing about the questions it has not reached.
    expect(text(row({ text: "", details: { questions: QUESTIONS } }, { isPartial: true }))).toBe(
      "questionnaire · 2 questions (Scope, Q2)\nAwaiting a response in the questionnaire.",
    );
  });

  it("marks the option an answer chose, by index and then by value", () => {
    const selected = (details: unknown): string[] =>
      text(row({ details }, { expanded: true }))
        .split("\n")
        .filter((line) => line.startsWith("  ") && line.includes("Selected: "));
    // The recorded index counts positions in the payload, so an entry that is not an option
    // must not shift the mark — the browser matches on the source index for the same reason.
    expect(
      selected({
        questions: [
          { id: "scope", label: "Scope", prompt: "?", options: [null, ...QUESTIONS[0].options] },
        ],
        answers: [{ id: "scope", value: "all", label: "All", wasCustom: false, index: 2 }],
        cancelled: false,
      }),
    ).toEqual(["  ✓ Selected: Small — Only the affected module"]);
    // No index: the option whose value matches, which is all a foreign payload leaves to go on.
    expect(
      selected({
        questions: QUESTIONS,
        answers: [{ id: "scope", value: "all", label: "All", wasCustom: false }],
        cancelled: false,
      }),
    ).toEqual(["  ✓ Selected: All — Every related module"]);
    // An index past the end of the options selects nothing: the payload did record a choice.
    expect(
      selected({
        questions: QUESTIONS,
        answers: [{ id: "scope", value: "all", label: "All", wasCustom: false, index: 9 }],
        cancelled: false,
      }),
    ).toEqual([]);
  });

  it("lists an answer whose question is gone, and marks truncated text", () => {
    const expanded = text(
      row(
        {
          details: {
            questions: [{ id: "scope", label: "Scope", prompt: "?", options: [] }],
            answers: [
              { id: "removed", value: "safe", label: "Orphan label", wasCustom: false },
              { id: "", value: "x", label: "y", wasCustom: true },
            ],
            cancelled: false,
          },
        },
        { expanded: true },
      ),
    );
    expect(expanded).toContain("Answers without a matching question");
    expect(expanded).toContain("removed: ✓ Selected: Orphan label");
    // An answer with no id is still named, by position.
    expect(expanded).toContain("Answer 2: ✓ Custom answer: y");

    // Either an over-long prompt or an over-long option says so, and the question is marked too.
    for (const question of [
      { id: "a", label: "A", prompt: "p".repeat(1_100), options: [] },
      {
        id: "a",
        label: "A",
        prompt: "?",
        options: [{ value: "v", label: "o".repeat(300) }],
      },
    ]) {
      const truncated = text(row({ details: { questions: [question] } }, { expanded: true }));
      expect(truncated, question.prompt.slice(0, 8)).toContain(
        "Questionnaire text was truncated for display.",
      );
      expect(truncated, question.prompt.slice(0, 8)).toContain("… [truncated]");
    }
  });

  it("bounds a hostile payload and says what it left out", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `q${index}`,
      prompt: "?",
      options: Array.from({ length: 40 }, (_, option) => ({
        value: `v${option}`,
        label: `o${option}`,
      })),
    }));
    const expanded = text(
      row({ details: { questions: many, answers: [], cancelled: false } }, { expanded: true }),
    );
    expect(expanded).toContain("8 questions omitted");
    expect(expanded).toContain("8 options omitted");
    // An escape sequence in an argument must not reach the terminal. It has to be read in the
    // expanded state: collapsed, the body is the status line alone and never quotes a prompt.
    const escape = String.fromCharCode(27);
    const hostile = text(
      row(
        {
          details: {
            questions: [
              {
                id: "x",
                label: `${escape}[31mred`,
                prompt: `${escape}[2Jwiped`,
                options: [{ value: "v", label: `${escape}]8;;http://evil${escape}\\link` }],
              },
            ],
            answers: [],
          },
        },
        { expanded: true },
      ),
    );
    expect(hostile).not.toContain(escape);
    expect(hostile).toContain("wiped");
    expect(hostile).toContain("link");
  });

  it("degrades instead of throwing on a malformed payload", () => {
    expect(() => row({ details: "not an object" })).not.toThrow();
    // Two of the three entries are not questions, so the count is what survived decoding.
    expect(text(row({ details: { questions: [null, 42, {}], answers: "bad" } }))).toContain(
      "0 answers shown for 1 questions shown.",
    );
    expect(text(row({ details: { questions: [{}] } }, { expanded: true }))).toContain(
      "Question details are unavailable or malformed.",
    );
  });

  /**
   * Colour is what distinguishes the four states at a glance, and it is the renderer's choice:
   * Pi tints the box from `isError` alone, so a cancelled questionnaire arrives here
   * indistinguishable from a completed one. These are the browser's own status colours.
   */
  it("colours the status line by the questionnaire's own state", () => {
    const tagged = {
      ...theme,
      fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
    } as unknown as Theme;
    const tone = (
      result: Parameters<typeof row>[0],
      options: Parameters<typeof row>[1] = {},
    ): string | undefined =>
      // The header is the first line, so the status line — whatever it says — is the second.
      row(result, options, tagged)[1]?.match(/<(\w+)>/)?.[1];
    expect(tone({ text: "", details: { questions: QUESTIONS } }, { isPartial: true })).toBe(
      "warning",
    );
    expect(tone(answered)).toBe("success");
    expect(tone({ details: { questions: QUESTIONS, answers: [], cancelled: true } })).toBe("muted");
    expect(tone({ text: "Error: no questions", details: { cancelled: true } })).toBe("error");
  });
});

describe("registration", () => {
  /**
   * Reload and session replacement rebuild historical rows before `session_start`, so bash must
   * already carry our renderer. Broader preloading would activate tools for the model; the other
   * six remain deferred until the active set is stable.
   */
  it("preloads bash, then replaces it and adds the other tools on session_start", async () => {
    const registered = new Map<string, { name: string }>();
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (event === "session_start") handlers.push(handler);
      },
      registerTool: (tool: { name: string }) => registered.set(tool.name, tool),
    };

    builtinToolRenderers(pi as never, []);
    expect([...registered.keys()]).toEqual(["bash"]);
    expect(handlers).toHaveLength(1);
    const provisionalBash = registered.get("bash");

    await handlers[0]!({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
    expect([...registered.keys()].sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    expect(registered.get("bash")).not.toBe(provisionalBash);
  });

  it("does not preload bash when the CLI explicitly restricts tools", () => {
    const registered: string[] = [];
    builtinToolRenderers(
      {
        on: () => undefined,
        registerTool: (tool: { name: string }) => registered.push(tool.name),
      } as never,
      ["--no-builtin-tools"],
    );
    expect(registered).toEqual([]);
  });
});

describe("live rows", () => {
  afterEach(() => {
    stopLiveRedraw();
    vi.useRealTimers();
  });

  const context = (state: Record<string, unknown>, redraws: { count: number }): RenderContext => ({
    expanded: false,
    theme,
    cwd: "/workspace/project",
    state,
    invalidate: () => (redraws.count += 1),
  });

  it("redraws while live, stops on the first settled render, and never doubles up", () => {
    vi.useFakeTimers();
    const state: Record<string, unknown> = {};
    const redraws = { count: 0 };
    const ctx = context(state, redraws);

    liveRedraw(ctx, true);
    // A redraw re-runs the slot, so the same row asks again; it must reuse its own timer.
    liveRedraw(ctx, true);
    vi.advanceTimersByTime(3_000);
    expect(redraws.count).toBe(3);

    liveRedraw(ctx, false);
    vi.advanceTimersByTime(3_000);
    expect(redraws.count).toBe(3);
    expect(state.liveRedrawTimer).toBeUndefined();

    // A row that was never live schedules nothing at all.
    const settled = { count: 0 };
    liveRedraw(context({}, settled), false);
    vi.advanceTimersByTime(3_000);
    expect(settled.count).toBe(0);
  });

  it("drops every timer at session shutdown, since a renderer owns no lifecycle", () => {
    vi.useFakeTimers();
    const rows = [1, 2, 3].map(() => {
      const redraws = { count: 0 };
      liveRedraw(context({}, redraws), true);
      return redraws;
    });
    vi.advanceTimersByTime(1_000);
    expect(rows.map((row) => row.count)).toEqual([1, 1, 1]);

    stopLiveRedraw();
    vi.advanceTimersByTime(5_000);
    expect(rows.map((row) => row.count)).toEqual([1, 1, 1]);
  });
});

/**
 * The shell is what composes the two slots, resolves built-in inheritance and picks the box
 * tone, so at least one call goes through the real `ToolExecutionComponent`: a renderer that
 * throws is silently replaced by Pi's fallback, which no slot-level test would notice.
 */
describe("through Pi's tool-execution shell", () => {
  const CSI = String.fromCharCode(27);
  /** The characters a line actually occupies, background padding included. */
  const bare = (line: string): string =>
    line
      .split(CSI)
      .join("")
      .replaceAll(/\[[0-9;]*m/g, "");
  const stripAnsi = (line: string): string => bare(line).trimEnd();

  function shellLines(
    name: string,
    args: Record<string, unknown>,
    result: { text: string; details?: unknown },
    expanded: boolean,
  ): string[] {
    initTheme("dark");
    const registration = registrations.find((entry) => entry.definition.name === name)!;
    const component = new ToolExecutionComponent(
      name,
      "call-1",
      args,
      { showImages: false },
      {
        ...registration.definition,
        renderShell: "default",
        renderCall: registration.renderer.renderCall ?? registration.definition.renderCall,
        renderResult: registration.renderer.renderResult ?? registration.definition.renderResult,
      } as never,
      { requestRender: () => {} } as never,
      "/workspace/project",
    );
    component.setExpanded(expanded);
    component.updateResult(
      { content: [{ type: "text", text: result.text }], details: result.details, isError: false },
      false,
    );
    return component
      .render(80)
      .map(stripAnsi)
      .filter((line) => line !== "");
  }

  it("renders one compact row per collapsed call and the full output when expanded", () => {
    expect(shellLines("bash", { command: "ls -la" }, { text: "a\nb\nc" }, false)).toEqual([
      " $ ls -la",
      " 3 output lines",
    ]);
    expect(shellLines("bash", { command: "ls -la" }, { text: "a\nb" }, true)).toEqual([
      " $ ls -la",
      " a",
      " b",
    ]);
  });

  /**
   * The other host that calls these slots. `pi --export` renders each call once, through
   * `dist/core/export-html/tool-renderer.js`, which hardcodes `isPartial: true` for `renderCall`
   * and `false` for `renderResult` and emits both. A renderer that decides *which* slot draws
   * from `isPartial` — as a self-drawn box has to, having no shared box to append into —
   * therefore duplicates its card there, one copy of it claiming a settled call is still
   * running. So the header slot must be the header in every state, and the body slot the body.
   */
  it("keeps the header and the body in their own slots, as the HTML exporter needs", () => {
    const args = {
      questions: [
        { id: "a", label: "Scope", prompt: "How far?", options: [{ value: "x", label: "X" }] },
      ],
    };
    const result = {
      content: [{ type: "text", text: "Scope: user selected: 1. X" }],
      details: {
        questions: args.questions,
        answers: [{ id: "a", value: "x", label: "X", wasCustom: false, index: 1 }],
        cancelled: false,
      },
    };
    const exportContext = (isPartial: boolean, expanded: boolean): SlotContext =>
      slotContext(args, { isPartial, expanded, executionStarted: true, argsComplete: true });
    const rendered = (component: { render: (width: number) => string[] }): string =>
      component
        .render(80)
        .map(stripAnsi)
        .filter((line) => line !== "")
        .join("\n");

    const header = rendered(
      questionnaireRenderer.renderCall!(args, theme, exportContext(true, false)),
    );
    const body = rendered(
      questionnaireRenderer.renderResult!(
        result as never,
        { expanded: false, isPartial: false },
        theme,
        exportContext(false, false),
      ),
    );
    expect(header).toBe("questionnaire · 1 question (Scope)");
    expect(body).toBe("1 of 1 questions answered.");
    // Neither slot repeats the other, and neither reports a state the export does not have.
    expect(header).not.toContain("Awaiting");
    expect(body).not.toContain("questionnaire ·");
  });

  /**
   * The whole phase rests on one property of Pi's shell: `invalidate()` re-runs both render
   * slots (`updateDisplay`) rather than repainting the lines the row already had. If it only
   * repainted, every timer here would fire into a frozen row.
   */
  it("re-runs the slot through the real shell, so the row shows a new value", () => {
    initTheme("dark");
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z") });
    try {
      const ticking = defineRenderer<{ live: boolean }>({
        names: ["ticking"],
        decode: (raw) => ({ live: raw.live === true }),
        header: () => "ticking",
        body: (args, _result, ctx) => {
          liveRedraw(ctx, args.live);
          return `at ${Date.now()}`;
        },
      });
      let renders = 0;
      const instance = new ToolExecutionComponent(
        "ticking",
        "call-1",
        { live: true },
        { showImages: false },
        { name: "ticking", renderShell: "default", ...ticking } as never,
        { requestRender: () => (renders += 1) } as never,
        "/workspace/project",
      );
      instance.updateResult({ content: [], isError: false } as never, false);
      const shown = () =>
        instance
          .render(80)
          .map((line) => stripAnsi(line).trim())
          .find((line) => line.startsWith("at "));

      expect(shown()).toBe(`at ${Date.parse("2026-01-01T00:00:00.000Z")}`);
      vi.advanceTimersByTime(3_000);
      expect(renders).toBe(3);
      expect(shown()).toBe(`at ${Date.parse("2026-01-01T00:00:03.000Z")}`);
    } finally {
      stopLiveRedraw();
      vi.useRealTimers();
    }
  });

  it("keeps Pi's inherited header for read while replacing its collapsed body", () => {
    const lines = shellLines("read", { path: "/workspace/project/a.ts" }, { text: "x\ny" }, false);
    expect(lines[0]).toContain("read");
    expect(lines[0]).toContain("a.ts");
    expect(lines.at(-1)).toBe(" 2 lines");
  });
});
