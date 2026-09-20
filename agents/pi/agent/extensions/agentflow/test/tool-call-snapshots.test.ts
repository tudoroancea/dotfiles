import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  finishToolCallSnapshot,
  MAX_TOOL_CALL_SNAPSHOTS,
  startToolCallSnapshot,
  summarizeToolArguments,
} from "../src/runtime/tool-call-snapshots.ts";
import type { NodeSnapshot, RunSnapshot } from "../src/types.ts";
import { renderRunCard, runOutcome, runSummary } from "../src/ui/run-card.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 42, cost: 0.0123 };
const node = (): NodeSnapshot => ({
  id: "finder",
  label: "Locate authentication state transitions",
  semanticRole: "finder",
  prompt: "Locate authentication state transitions",
  cwd: "/workspace/project",
  status: "running",
  tools: 0,
  toolCalls: [],
  usage: { ...usage },
});
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

describe("tool call snapshots", () => {
  it("keeps source/start order, updates by id, and bounds retained calls", () => {
    const snapshot = node();
    for (let index = 0; index < 40; index++) {
      startToolCallSnapshot(snapshot, {
        id: `call-${index}`,
        name: "read",
        args: { path: `src/file-${index}.ts`, offset: 10, limit: 20 },
        at: `start-${index}`,
      });
      finishToolCallSnapshot(snapshot, {
        id: `call-${index}`,
        result: { content: [{ type: "text", text: `result-${index}` }] },
        isError: index === 39,
        at: `end-${index}`,
      });
    }

    expect(snapshot.tools).toBe(40);
    expect(snapshot.toolCalls).toHaveLength(MAX_TOOL_CALL_SNAPSHOTS);
    expect(snapshot.toolCalls.map((call) => call.id)).toEqual(
      Array.from({ length: 32 }, (_, index) => `call-${index + 8}`),
    );
    expect(snapshot.toolCalls.at(-1)).toMatchObject({
      status: "failed",
      error: "result-39",
      completedAt: "end-39",
    });

    const run: RunSnapshot = {
      runId: "af_bound",
      kind: "agent",
      status: "running",
      createdAt: new Date(0).toISOString(),
      phases: [],
      nodes: [snapshot],
      logs: [],
    };
    expect(renderRunCard(run, { maxCollapsedCalls: 8 }, theme).render(200).join("\n")).toContain(
      "32 earlier tool calls",
    );
    expect(renderRunCard(run, { expanded: true }, theme).render(200).join("\n")).toContain(
      "8 earlier tool calls",
    );
  });

  it("uses compact tool-specific argument summaries", () => {
    expect(summarizeToolArguments("read", { path: "src/auth.ts", offset: 80, limit: 100 })).toBe(
      "src/auth.ts:80-179",
    );
    expect(summarizeToolArguments("bash", { command: "npm test\necho done" })).toBe("npm test");
    expect(summarizeToolArguments("Read", { file_path: "src/claude.ts" })).toBe("src/claude.ts");
    expect(summarizeToolArguments("Bash", { command: "nub run test" })).toBe("nub run test");
  });
});

describe("run card", () => {
  it("uses role-specific result summaries", () => {
    expect(runOutcome("finder", JSON.stringify({ findings: [{}, {}, {}] }))).toBe("3 findings");
    expect(runOutcome("librarian", JSON.stringify({ sources: [{}, {}] }))).toBe("2 sources");
    expect(runOutcome("look_at", JSON.stringify({ observations: [{}, {}, {}] }))).toBe(
      "3 observations",
    );
    expect(runOutcome("oracle", JSON.stringify({ recommendation: "do it" }))).toBe(
      "recommendation",
    );
    // A streamed preview is routinely incomplete JSON, which has no outcome to report yet.
    expect(runOutcome("finder", '{"findings":[{')).toBe("");

    const task = node();
    task.tools = 4;
    task.usage.total = 1200;
    task.resultPreview = JSON.stringify({ findings: [{}, {}, {}] });
    const snapshot: RunSnapshot = {
      runId: "af_summary",
      kind: "agent",
      semanticRole: "finder",
      status: "completed",
      createdAt: new Date(0).toISOString(),
      phases: [],
      nodes: [task],
      logs: [],
    };
    expect(runSummary(snapshot, "finder")).toBe("3 findings · 4 tools · 1.2k tokens · $0.0123");
  });

  it("previews recent tool calls with their statuses when collapsed", () => {
    const task = node();
    for (let index = 0; index < 12; index++)
      startToolCallSnapshot(task, {
        id: `call-${index}`,
        name: index % 2 ? "read" : "search_text",
        args: { path: `src/a-very-long-path-${index}.ts`, query: "refreshToken" },
      });
    finishToolCallSnapshot(task, {
      id: "call-9",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    finishToolCallSnapshot(task, {
      id: "call-10",
      result: { content: [{ type: "text", text: "failed" }] },
      isError: true,
    });
    const snapshot: RunSnapshot = {
      runId: "af_test",
      kind: "agent",
      name: "finder",
      semanticRole: "finder",
      status: "running",
      createdAt: new Date(0).toISOString(),
      phases: [],
      nodes: [task],
      logs: [],
    };

    const lines = renderRunCard(
      snapshot,
      { maxCollapsedCalls: 3, observedAt: 5_000 },
      theme,
    ).render(40);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("9 earlier tool calls");
    expect(lines.some((line) => line.includes("✓ read"))).toBe(true);
    expect(lines.some((line) => line.includes("✗ search_text"))).toBe(true);
    expect(lines.some((line) => line.includes("◆ read"))).toBe(true);
    // Elapsed closes the collapsed line too, as it does in the browser; at 40 columns the
    // cost is what falls off the end.
    expect(lines.at(-1)).toContain("◆ running · 5.0s · 12 tools · 42 tokens");
    expect(
      renderRunCard(snapshot, { maxCollapsedCalls: 3, observedAt: 5_000 }, theme)
        .render(100)
        .at(-1),
    ).toContain("◆ running · 5.0s · 12 tools · 42 tokens · $0.0123");
    expect(lines.join("\n")).not.toContain("finder");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("states background runs without a stale tools/tokens/cost summary", () => {
    const task = node();
    for (let index = 0; index < 12; index++)
      startToolCallSnapshot(task, {
        id: `call-${index}`,
        name: "read",
        args: { path: `src/a-very-long-path-${index}.ts` },
      });
    const snapshot: RunSnapshot = {
      runId: "af_test_bg",
      kind: "agent",
      name: "finder",
      semanticRole: "finder",
      status: "running",
      background: true,
      createdAt: new Date(0).toISOString(),
      phases: [],
      nodes: [task],
      logs: [],
    };

    // The mode qualifies the status word instead of repeating it as its own
    // segment ("running · running in the background").
    const lines = renderRunCard(
      snapshot,
      { maxCollapsedCalls: 3, observedAt: 5_000 },
      theme,
    ).render(40);
    expect(lines.at(-1)).toContain("◆ running in the background");
    expect(lines.at(-1)).not.toContain("running · running");
    expect(lines.at(-1)).not.toContain("tools");
    expect(lines.at(-1)).not.toContain("tokens");
    expect(lines.at(-1)).not.toContain("$");
    // Nor a duration: this card is never corrected, so one measured against the clock would
    // grow on every unrelated redraw and outlive the run.
    expect(lines.at(-1)).not.toMatch(/\d+s/);

    // Once it finishes, the delivered snapshot reports its real usage again.
    const done = renderRunCard(
      { ...snapshot, status: "completed", nodes: [{ ...task, status: "completed" }] },
      { maxCollapsedCalls: 3 },
      theme,
    ).render(80);
    expect(done.at(-1)).toContain("✓ completed");
    expect(done.at(-1)).not.toContain("in the background");
    expect(done.at(-1)).toContain("tokens");
  });

  it("renders expanded snapshots in the shared bounded hierarchy", () => {
    const task = node();
    task.startedAt = new Date(0).toISOString();
    task.completedAt = new Date(65_000).toISOString();
    task.status = "completed";
    task.resultPreview = "Authentication state map";
    startToolCallSnapshot(task, {
      id: "call-read",
      name: "read",
      args: { path: "src/auth.ts", offset: 1, limit: 20 },
      at: new Date(1_000).toISOString(),
    });
    finishToolCallSnapshot(task, {
      id: "call-read",
      result: { content: [{ type: "text", text: "source text" }] },
      isError: false,
      at: new Date(2_000).toISOString(),
    });
    const snapshot: RunSnapshot = {
      runId: "af_test",
      kind: "agent",
      semanticRole: "finder",
      status: "completed",
      createdAt: new Date(0).toISOString(),
      completedAt: new Date(65_000).toISOString(),
      phases: [],
      nodes: [task],
      logs: [],
      artifactDir: "/tmp/artifacts/af_test",
    };

    // Metadata opens the detail, the status line closes it, and the prompt is
    // left to the caller's own title unless it asks for the section.
    const text = renderRunCard(snapshot, { expanded: true }, theme).render(100).join("\n");
    expect(text).not.toContain("Prompt");
    expect(text.indexOf("Cwd: /workspace/project")).toBeLessThan(text.indexOf("Tool calls"));
    expect(text.indexOf("Tool calls")).toBeLessThan(text.indexOf("Output"));
    expect(text.indexOf("Output")).toBeLessThan(text.indexOf("1m 5s"));
    expect(text).toContain("Run: af_test");
    expect(text).toContain("Artifacts: /tmp/artifacts/af_test");

    const withPrompt = renderRunCard(snapshot, { expanded: true, promptSection: true }, theme)
      .render(100)
      .join("\n");
    expect(withPrompt.indexOf("Cwd: /workspace/project")).toBeLessThan(
      withPrompt.indexOf("Prompt"),
    );
    expect(withPrompt.indexOf("Prompt")).toBeLessThan(withPrompt.indexOf("Tool calls"));

    const taggedTheme = {
      fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
      bold: (value: string) => value,
    } as Theme;
    const styled = renderRunCard(snapshot, { expanded: true }, taggedTheme).render(200).join("\n");
    expect(styled).toContain("<success>✓</success> <toolTitle>read      </toolTitle>");
    expect(styled).toContain('<muted>args:</muted> <dim>{"path":"src/auth.ts"');
    expect(styled).not.toContain("completed read");
  });

  it("renders Claude backend, requested model alias, and cost in shared cards", () => {
    const task = node();
    task.backend = "claude";
    task.model = "opus";
    task.status = "completed";
    const snapshot: RunSnapshot = {
      runId: "af_claude",
      kind: "agent",
      name: "claude/opus",
      status: "completed",
      createdAt: new Date(0).toISOString(),
      phases: [],
      nodes: [task],
      logs: [],
    };

    const collapsed = renderRunCard(snapshot, {}, theme).render(80).join("\n");
    expect(collapsed).toContain("claude/opus");
    expect(collapsed).toContain("$0.0123");
    const expanded = renderRunCard(snapshot, { expanded: true }, theme).render(80).join("\n");
    expect(expanded).toContain("Backend: claude");
    expect(expanded).toContain("Model: opus");
    expect(expanded).toContain("$0.0123");
  });
});
