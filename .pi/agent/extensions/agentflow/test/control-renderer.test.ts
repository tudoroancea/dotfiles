import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { registerStatusTool } from "../src/tools/status-tool.ts";
import { registerSteerTool } from "../src/tools/steer-tool.ts";
import type { RunSnapshot } from "../src/types.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal()),
  keyHint: () => "alt+e to expand",
}));

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function snapshot(runId: string, status: RunSnapshot["status"] = "completed"): RunSnapshot {
  return {
    runId,
    kind: "agent",
    name: "finder",
    semanticRole: "finder",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: status === "running" ? undefined : "2026-01-01T00:00:02.000Z",
    phases: [],
    logs: [],
    artifactDir: `/artifacts/${runId}`,
    resultPreview: '{"findings":[{"title":"issue"}]}',
    nodes: [
      {
        id: "finder_1",
        label: "finder",
        semanticRole: "finder",
        prompt: "Inspect authentication state transitions",
        cwd: "/work/project",
        status,
        tools: 2,
        toolCalls: [],
        resultPreview: '{"findings":[{"title":"issue"}]}',
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          total: 120,
          cost: 0.012,
        },
      },
    ],
  };
}

function toolsHarness() {
  const tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool) };
  const engine = {
    getSnapshot: vi.fn(),
    wait: vi.fn(),
    cancel: vi.fn(),
    steer: vi.fn(),
  };
  registerStatusTool(pi as never, engine as never);
  registerSteerTool(pi as never, engine as never);
  return { tools, engine };
}

describe("agentflow control tool rendering", () => {
  it("renders status lists semantically when collapsed and detailed when expanded", () => {
    const { tools } = toolsHarness();
    const renderer = tools.get("agentflow_status").renderResult;
    const snapshots = [snapshot("af_one", "running"), snapshot("af_two")];

    const observedAt = Date.parse("2026-01-01T00:00:05.000Z");
    const renderContext = { state: {} };
    const collapsedComponent = renderer(
      {
        details: { snapshot: snapshots, observedAt },
        content: [{ type: "text", text: "RAW JSON" }],
      },
      { expanded: false },
      theme,
      renderContext,
    );
    const collapsed = collapsedComponent.render(72);
    expect(collapsed.join("\n")).toContain("af_one");
    expect(collapsed.join("\n")).toContain("5s");
    expect(collapsedComponent.render(72)).toEqual(collapsed);
    expect(collapsed.join("\n")).toContain("1 findings");
    expect(collapsed.join("\n")).toContain("expand");
    expect(collapsed.join("\n")).not.toContain("RAW JSON");
    expect(collapsed.every((line: string) => visibleWidth(line) <= 72)).toBe(true);

    const expanded = renderer(
      {
        details: { snapshot: snapshots[1], observedAt },
        content: [{ type: "text", text: "RAW JSON" }],
      },
      { expanded: true },
      theme,
      renderContext,
    )
      .render(100)
      .join("\n");
    expect(expanded).toContain("af_two");
    expect(expanded).toContain("Prompt");
    expect(expanded).toContain("Tool calls");
    expect(expanded).toContain("Artifacts: /artifacts/af_two");
    expect(expanded).not.toContain("RAW JSON");
  });

  it("includes Claude backend and requested model in status rendering", () => {
    const { tools } = toolsHarness();
    const run = snapshot("af_claude");
    run.name = "claude/opus";
    run.semanticRole = undefined;
    run.nodes[0]!.semanticRole = undefined;
    run.nodes[0]!.backend = "claude";
    run.nodes[0]!.model = "opus";

    const rendered = tools
      .get("agentflow_status")
      .renderResult({ details: { snapshot: run } }, { expanded: false }, theme, { state: {} })
      .render(100)
      .join("\n");

    expect(rendered).toContain("claude/opus");
    expect(rendered).toContain("$0.0120");
  });

  it("renders wait and cancellation results from structured details", () => {
    const { tools } = toolsHarness();
    const run = snapshot("af_waited");
    const wait = tools
      .get("agentflow_wait")
      .renderResult(
        {
          details: { results: [{ runId: run.runId, status: run.status, snapshot: run }] },
          content: [{ type: "text", text: "[{raw:true}]" }],
        },
        { expanded: false },
        theme,
        { state: {} },
      )
      .render(100)
      .join("\n");
    expect(wait).toContain("af_waited");
    expect(wait).not.toContain("raw:true");

    const cancelled = tools
      .get("agentflow_cancel")
      .renderResult(
        { details: { snapshots: [snapshot("af_cancelled", "aborted")] } },
        { expanded: false },
        theme,
        { state: {} },
      )
      .render(100)
      .join("\n");
    expect(cancelled).toContain("1 cancelled");
  });

  it("shows control arguments and bounds steering messages", () => {
    const { tools } = toolsHarness();
    const waitCall = tools
      .get("agentflow_wait")
      .renderCall({ runIds: ["af_one", "af_two"] }, theme).text;
    expect(waitCall).toContain("af_one, af_two");

    const steerCall = tools
      .get("agentflow_steer")
      .renderCall(
        { runId: "af_one", nodeId: "finder", message: "one\ntwo\nthree\nfour\nfive\nsix\nseven" },
        theme,
        { expanded: true },
      ).text;
    expect(steerCall).toContain("Target: af_one / finder");
    expect(steerCall).toContain("more lines");
  });
});
