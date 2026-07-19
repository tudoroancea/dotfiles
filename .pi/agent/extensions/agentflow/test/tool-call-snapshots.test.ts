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
import { renderSemanticSnapshot, semanticResultSummary } from "../src/ui/semantic-renderer.ts";

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
  });

  it("uses compact tool-specific argument summaries", () => {
    expect(summarizeToolArguments("read", { path: "src/auth.ts", offset: 80, limit: 100 })).toBe(
      "src/auth.ts:80-179",
    );
    expect(summarizeToolArguments("bash", { command: "npm test\necho done" })).toBe("npm test");
  });
});

describe("semantic snapshot renderer", () => {
  it("uses role-specific result summaries", () => {
    expect(
      semanticResultSummary("finder", JSON.stringify({ findings: [{}, {}, {}] }), 4, 1200, 0.0123),
    ).toBe("3 findings · 4 tools · 1.2k tokens · $0.0123");
    expect(
      semanticResultSummary("librarian", JSON.stringify({ sources: [{}, {}] }), 2, 500, 0.12),
    ).toBe("2 sources · 2 tools · 500 tokens · $0.120");
    expect(
      semanticResultSummary(
        "look_at",
        JSON.stringify({ observations: [{}, {}, {}] }),
        2,
        1_250_000,
        1.25,
      ),
    ).toBe("3 observations · 2 tools · 1.3M tokens · $1.25");
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

    const lines = renderSemanticSnapshot(snapshot, { maxCollapsedCalls: 3 }, theme).render(40);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("9 earlier tool calls");
    expect(lines.some((line) => line.includes("✓ read"))).toBe(true);
    expect(lines.some((line) => line.includes("✗ search_text"))).toBe(true);
    expect(lines.some((line) => line.includes("◆ read"))).toBe(true);
    expect(lines.at(-1)).toContain("◆ running · 12 tools · 42 tokens · $0");
    expect(lines.join("\n")).not.toContain("finder");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
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

    const text = renderSemanticSnapshot(snapshot, { expanded: true }, theme).render(100).join("\n");
    expect(text.indexOf("Prompt")).toBeLessThan(text.indexOf("1m05s"));
    expect(text.indexOf("1m05s")).toBeLessThan(text.indexOf("Tool calls"));
    expect(text.indexOf("Tool calls")).toBeLessThan(text.indexOf("Output"));
    expect(text.indexOf("Output")).toBeLessThan(text.indexOf("Metadata"));
    expect(text).toContain("Cwd: /workspace/project");
    expect(text).toContain("Artifacts: /tmp/artifacts/af_test");

    const taggedTheme = {
      fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
      bold: (value: string) => value,
    } as Theme;
    const styled = renderSemanticSnapshot(snapshot, { expanded: true }, taggedTheme)
      .render(200)
      .join("\n");
    expect(styled).toContain("<success>✓</success> <toolTitle>read      </toolTitle>");
    expect(styled).toContain('<muted>args:</muted> <dim>{"path":"src/auth.ts"');
    expect(styled).not.toContain("completed read");
  });
});
