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

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 42, cost: 0 };
const node = (): NodeSnapshot => ({
  id: "finder",
  label: "Locate authentication state transitions",
  semanticRole: "finder",
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
      semanticResultSummary("finder", JSON.stringify({ findings: [{}, {}, {}] }), 4, 1200),
    ).toBe("3 findings · 4 tools · 1200 tokens");
    expect(semanticResultSummary("librarian", JSON.stringify({ sources: [{}, {}] }), 2, 500)).toBe(
      "2 sources · 2 tools · 500 tokens",
    );
    expect(
      semanticResultSummary("look_at", JSON.stringify({ observations: [{}, {}, {}] }), 2, 600),
    ).toBe("3 observations · 2 tools · 600 tokens");
  });

  it("renders a compact tail and never exceeds narrow terminal width", () => {
    const task = node();
    for (let index = 0; index < 12; index++)
      startToolCallSnapshot(task, {
        id: `call-${index}`,
        name: index % 2 ? "read" : "search_text",
        args: { path: `src/a-very-long-path-${index}.ts`, query: "refreshToken" },
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

    const lines = renderSemanticSnapshot(snapshot, { maxCollapsedCalls: 3 }, theme).render(28);
    expect(lines.some((line) => line.includes("9 earlier"))).toBe(true);
    expect(lines.some((line) => line.includes("call-0"))).toBe(false);
    expect(lines.filter((line) => line.startsWith("◆ "))).toEqual(["◆ 12 tools · 42 tokens"]);
    expect(lines.join("\n")).not.toContain("finder");
    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
  });
});
