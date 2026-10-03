// The golden gate for every tool renderer this repo owns.
//
// One table over the whole TUI renderer registry. Each case is rendered through the real
// `ToolExecutionComponent` in every result state, both
// expansion states and three widths, with ANSI stripped, and stored as a snapshot.
//
// Three things only this layer can see:
//
//   - a renderer that throws is silently replaced by Pi's fallback, so a slot-level test would
//     pass while the terminal shows pretty-printed JSON;
//   - the pending and streaming-partial states, which a session file never holds;
//   - what a narrow terminal does to a header, which is where wrapping and clipping differ.
//
// Colour is not in the goldens (it is stripped); the colour assertions that matter live next to
// the renderers that choose one — `tool-renderers.test.ts` for the questionnaire's status line.
//
// The expand hints read as a bare `· to expand` here: `keyHint` resolves the key from the
// interactive keybindings, which no test process loads, so the key name comes out empty. A real
// session shows `ctrl+o to expand` in the same place.

import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { BACKGROUND_RENDERERS } from "../agent/extensions/background-processes/src/ui/tool-renderers.ts";
import { builtinRegistrations } from "../agent/extensions/lib/tools/builtin.ts";
import { FFF_RENDERERS } from "../agent/extensions/lib/tools/fff.ts";
import { questionnaireRenderer } from "../agent/extensions/lib/tools/questionnaire.ts";
import type { Renderer } from "../agent/extensions/lib/tools/types.ts";

const CWD = "/Users/tester/project";
const WIDTHS = [60, 100, 160] as const;

// ---------------------------------------------------------------------------
// The registry, by owner
// ---------------------------------------------------------------------------

type Owner = "builtin" | "fff" | "questionnaire" | "background";

const registrations = builtinRegistrations(CWD);

/** Every renderer that can be attached to a tool, and what it is attached to. */
const REGISTRY: ReadonlyMap<Owner, ReadonlyMap<string, Renderer>> = new Map([
  [
    "builtin",
    new Map(registrations.map((entry) => [entry.definition.name, entry.renderer] as const)),
  ],
  ["fff", FFF_RENDERERS],
  ["questionnaire", new Map([["questionnaire", questionnaireRenderer]])],
  [
    "background",
    new Map(BACKGROUND_RENDERERS.flatMap((r) => r.names.map((name) => [name, r] as const))),
  ],
]);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const lines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");

const JOB = {
  jobId: "bg_7",
  kind: "background_run",
  status: "completed",
  command: "npm test",
  description: "run tests",
  cwd: CWD,
  durationMs: 2_500,
  exitCode: 0,
  outputBytes: 128,
  outputPath: "/tmp/bg/output.log",
  deliveryState: "sent",
  tail: "PASS one\nPASS two",
};
const JOBS_DETAILS = { jobs: [JOB], truncated: false, omittedCount: 0 };

/**
 * `ffgrep` groups matches under a file heading, separates files with a blank line, and appends
 * its notices. `totalFiles` in its `details` is the size of the repo index, not the number of
 * files that matched — the fixtures say 521 so a summary that reported it would be obviously
 * wrong.
 */
const FFGREP_OUTPUT = [
  "src/a.ts",
  " 11-  const before = 1;",
  " 12:  const bar = 2;",
  "",
  "src/b.ts",
  " 40:  bar();",
  "",
  '[Continue with cursor="c2"]',
].join("\n");
const GREP_DETAILS = { totalMatched: 2, totalFiles: 521, totalFilesSearched: 2 };

interface Case {
  readonly owner: Owner;
  readonly name: string;
  /** How the snapshot is titled: fff's override names collide with the built-ins. */
  readonly label?: string;
  readonly args: Record<string, unknown>;
  readonly text?: string;
  readonly details?: unknown;
}

const CASES: readonly Case[] = [
  // --- built-ins ---
  { owner: "builtin", name: "bash", args: { command: "ls -la", timeout: 30 }, text: lines(4) },
  {
    owner: "builtin",
    name: "read",
    args: { path: `${CWD}/a.ts`, offset: 5, limit: 10 },
    text: `${lines(9)}\n\n[500 more lines in file. Use offset=15 to continue.]`,
  },
  {
    owner: "builtin",
    name: "write",
    args: { path: `${CWD}/a.txt`, content: "x\ny" },
    text: "ok",
  },
  {
    owner: "builtin",
    name: "edit",
    args: { path: `${CWD}/a.txt`, edits: [{ oldText: "a", newText: "b" }] },
    text: "applied",
    details: { diff: " 1 keep\n-2 a\n+2 b" },
  },
  { owner: "builtin", name: "ls", args: { path: "/tmp", limit: 50 }, text: lines(3) },
  {
    owner: "builtin",
    name: "grep",
    args: {
      pattern: "foo",
      path: "src",
      glob: "*.ts",
      ignoreCase: true,
      literal: true,
      context: 2,
      limit: 20,
    },
    text: "src/a.ts:1: foo\nsrc/b.ts:9: foo",
  },
  {
    owner: "builtin",
    name: "find",
    args: { pattern: "*.ts", path: "src", limit: 10 },
    text: lines(5),
  },

  // --- fff, under every name the three modes register ---
  {
    owner: "fff",
    name: "ffgrep",
    args: {
      pattern: "bar",
      path: "src",
      exclude: ["test/"],
      caseSensitive: true,
      context: 1,
      cursor: "c1",
    },
    text: FFGREP_OUTPUT,
    details: GREP_DETAILS,
  },
  {
    owner: "fff",
    name: "fffind",
    args: { pattern: "auth", exclude: "vendor/" },
    text: lines(2),
    details: { totalMatched: 90, totalFiles: 521, pageIndex: 1, hasMore: true },
  },
  {
    owner: "fff",
    name: "fff-multi-grep",
    args: { patterns: ["auth_state", "authState"], constraints: "*.ts !test/", limit: 20 },
    text: FFGREP_OUTPUT,
    details: { ...GREP_DETAILS, patterns: ["auth_state", "authState"] },
  },
  {
    owner: "fff",
    name: "grep",
    label: "fff grep (override mode)",
    args: { pattern: "bar", path: "src" },
    text: FFGREP_OUTPUT,
    details: GREP_DETAILS,
  },
  {
    owner: "fff",
    name: "find",
    label: "fff find (override mode)",
    args: { pattern: "auth" },
    text: lines(2),
    details: { totalMatched: 2, totalFiles: 521 },
  },
  {
    owner: "fff",
    name: "multi_grep",
    label: "fff multi_grep (override mode)",
    args: { patterns: ["auth"], limit: 20 },
    text: FFGREP_OUTPUT,
    details: GREP_DETAILS,
  },

  // --- questionnaire ---
  {
    owner: "questionnaire",
    name: "questionnaire",
    args: {
      questions: [
        {
          id: "scope",
          label: "Scope",
          prompt: "How far should this go?",
          options: [
            { value: "small", label: "Small", description: "Only the affected module" },
            { value: "all", label: "All", description: "Every related module" },
          ],
        },
        { id: "notes", prompt: "Anything else?", options: [{ value: "none", label: "Nothing" }] },
      ],
    },
    text: "Scope: user selected: 2. All\nQ2: user wrote: ship it",
    details: {
      questions: [
        {
          id: "scope",
          label: "Scope",
          prompt: "How far should this go?",
          options: [
            { value: "small", label: "Small", description: "Only the affected module" },
            { value: "all", label: "All", description: "Every related module" },
          ],
        },
        {
          id: "notes",
          label: "Q2",
          prompt: "Anything else?",
          options: [{ value: "none", label: "Nothing" }],
        },
      ],
      answers: [
        { id: "scope", value: "all", label: "All", wasCustom: false, index: 2 },
        { id: "notes", value: "ship it", label: "ship it", wasCustom: true },
      ],
      cancelled: false,
    },
  },

  // --- background ---
  {
    owner: "background",
    name: "background_run",
    args: { command: "npm test", description: "run tests", timeout: 60 },
    details: JOBS_DETAILS,
  },
  {
    owner: "background",
    name: "background_event_stream",
    args: { command: "tail -f log", description: "watch", persistent: true },
    details: {
      jobs: [
        {
          ...JOB,
          kind: "background_event_stream",
          monitor: {
            deliveries: 3,
            droppedLines: 1,
            droppedBytes: 20,
            splitLines: 0,
            captureOnly: true,
            completionOutput: "remaining",
          },
        },
      ],
      truncated: false,
      omittedCount: 0,
    },
  },
  {
    owner: "background",
    name: "background_status",
    args: { jobId: "bg_7", tailLines: 20 },
    details: JOBS_DETAILS,
  },
  {
    owner: "background",
    name: "background_wait",
    args: { jobIds: ["bg_7"], timeout: 30 },
    details: JOBS_DETAILS,
  },
  {
    owner: "background",
    name: "background_stop",
    args: { jobIds: ["bg_7", "bg_8"] },
    details: JOBS_DETAILS,
  },
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27);

/**
 * Everything a terminal would act on rather than show: CSI colour sequences, and the OSC 8
 * hyperlinks Pi's `read` header wraps a path in.
 */
function stripAnsi(line: string): string {
  let out = "";
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== ESC) {
      out += line[index];
      continue;
    }
    const introducer = line[index + 1];
    if (introducer === "[") {
      index += 1;
      while (index + 1 < line.length) {
        const code = line.charCodeAt(++index);
        if (code >= 0x40 && code <= 0x7e) break;
      }
    } else if (introducer === "]") {
      index += 1;
      while (index + 1 < line.length) {
        index += 1;
        if (line.charCodeAt(index) === 0x07) break;
        if (line[index] === ESC && line[index + 1] === "\\") {
          index += 1;
          break;
        }
      }
    } else {
      index += 1;
    }
  }
  return out.trimEnd();
}

type State = "pending" | "partial" | "success" | "error";

function component(entry: Case): ToolExecutionComponent {
  const registration = registrations.find((item) => item.definition.name === entry.name);
  const renderer = REGISTRY.get(entry.owner)!.get(entry.name)!;
  const definition = {
    // A built-in is registered as Pi's own definition with our slots on top, so the goldens
    // see the same inheritance the session does — `read`'s expanded body is still Pi's.
    ...(registration?.definition ?? { name: entry.name }),
    // Every renderer here uses Pi's own shell; nothing draws its own box.
    renderShell: "default",
    renderCall: renderer.renderCall ?? registration?.definition.renderCall,
    renderResult: renderer.renderResult ?? registration?.definition.renderResult,
  };
  return new ToolExecutionComponent(
    entry.name,
    "call-1",
    entry.args,
    { showImages: false },
    definition as never,
    { requestRender: () => {} } as never,
    CWD,
  );
}

function render(entry: Case, state: State, expanded: boolean, width: number): string[] {
  const instance = component(entry);
  instance.setExpanded(expanded);
  if (state !== "pending")
    instance.updateResult(
      {
        content: entry.text === undefined ? [] : [{ type: "text", text: entry.text }],
        details: entry.details,
        isError: state === "error",
      } as never,
      state === "partial",
    );
  return instance.render(width).map(stripAnsi);
}

/** Every state of one tool in one reviewable block. */
function golden(entry: Case): string {
  const blocks: string[] = [];
  for (const state of ["pending", "partial", "success", "error"] as const)
    for (const expanded of [false, true])
      for (const width of WIDTHS) {
        const body = render(entry, state, expanded, width)
          .join("\n")
          .replace(/^\n+|\n+$/g, "");
        blocks.push(
          `── ${state} · ${expanded ? "expanded" : "collapsed"} · w=${width}\n${
            body || "(renders nothing)"
          }`,
        );
      }
  return blocks.join("\n\n");
}

describe("tool renderer goldens", () => {
  initTheme("dark");

  it("covers exactly the registry, per owner", () => {
    for (const [owner, renderers] of REGISTRY) {
      expect(
        CASES.filter((entry) => entry.owner === owner)
          .map((entry) => entry.name)
          .sort(),
        owner,
      ).toEqual([...renderers.keys()].sort());
    }
  });

  for (const entry of CASES)
    it(`${entry.owner}: ${entry.label ?? entry.name}`, () => {
      expect(golden(entry)).toMatchSnapshot();
    });
});
