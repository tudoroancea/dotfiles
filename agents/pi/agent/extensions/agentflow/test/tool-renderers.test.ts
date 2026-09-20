import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopLiveRedraw } from "../../lib/tools/live.ts";
import { registerSemanticTools } from "../src/tools/semantic-tools.ts";
import { registerStatusTool } from "../src/tools/status-tool.ts";
import { registerWorkflowTool } from "../src/tools/workflow-tool.ts";
import { slotContext } from "./helpers/slot-context.ts";
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
    const renderContext = slotContext({}, { state: {} });
    const collapsedComponent = renderer(
      {
        details: { snapshot: snapshots, observedAt },
        content: [{ type: "text", text: "RAW JSON" }],
      },
      { expanded: false, isPartial: false },
      theme,
      renderContext,
    );
    const collapsed = collapsedComponent.render(72);
    expect(collapsed.join("\n")).toContain("af_one");
    expect(collapsed.join("\n")).toContain("5.0s");
    expect(collapsedComponent.render(72)).toEqual(collapsed);
    expect(collapsed.join("\n")).toContain("1 finding");
    expect(collapsed.join("\n")).toContain("expand");
    expect(collapsed.join("\n")).not.toContain("RAW JSON");
    expect(collapsed.every((line: string) => visibleWidth(line) <= 72)).toBe(true);

    const expanded = renderer(
      {
        details: { snapshot: snapshots[1], observedAt },
        content: [{ type: "text", text: "RAW JSON" }],
      },
      { expanded: true, isPartial: false },
      theme,
      slotContext({}, { expanded: true }),
    )
      .render(100)
      .join("\n");
    expect(expanded).toContain("af_two");
    expect(expanded).toContain("Prompt");
    expect(expanded).toContain("Artifacts: /artifacts/af_two");
    expect(expanded).not.toContain("RAW JSON");
    // The snapshot has a tool count but no retained call details, so the expanded
    // section still reports the omitted calls rather than silently hiding them.
    expect(expanded).toContain("Tool calls");
    expect(expanded).toContain("2 earlier tool calls");
    expect(expanded.indexOf("Cwd: /work/project")).toBeLessThan(expanded.indexOf("Prompt"));
    expect(expanded.indexOf("Output")).toBeLessThan(expanded.indexOf("1 finding · 2 tools"));
  });

  it("includes Claude backend and requested model in status rendering", () => {
    const { tools } = toolsHarness();
    const run = snapshot("af_claude");
    run.name = "claude/opus";
    run.semanticRole = undefined;
    run.nodes[0]!.semanticRole = undefined;
    run.nodes[0]!.backend = "claude";
    run.nodes[0]!.model = "opus";

    const collapsed = tools
      .get("agentflow_status")
      .renderResult(
        { details: { snapshot: run } },
        { expanded: false, isPartial: false },
        theme,
        slotContext({}),
      )
      .render(100)
      .join("\n");
    // A collapsed control result names the run and its state; usage belongs to the card.
    expect(collapsed).toContain("af_claude");
    expect(collapsed).toContain("claude/opus");

    const expanded = tools
      .get("agentflow_status")
      .renderResult(
        { details: { snapshot: run } },
        { expanded: true, isPartial: false },
        theme,
        slotContext({}, { expanded: true }),
      )
      .render(100)
      .join("\n");
    expect(expanded).toContain("Backend: claude");
    expect(expanded).toContain("Model: opus");
    expect(expanded).toContain("$0.0120");
  });

  it("uses aggregate cost availability for expanded multi-node workflows", () => {
    const { tools } = toolsHarness();
    const run = snapshot("af_mixed_cost");
    run.kind = "workflow";
    run.nodes.push({
      ...structuredClone(run.nodes[0]!),
      id: "claude_2",
      label: "claude/opus",
      backend: "claude",
      model: "opus",
      usage: { ...run.nodes[0]!.usage, cost: 0, costKnown: false },
    });

    const lines = tools
      .get("agentflow_status")
      .renderResult(
        { details: { snapshot: run } },
        { expanded: true, isPartial: false },
        theme,
        slotContext({}, { expanded: true }),
      )
      .render(100);

    // One unknown-cost node makes the run's own total unknown, so its closing line reports
    // "cost unavailable" rather than a partial sum.
    const closing = lines.at(-1) ?? "";
    expect(closing).toContain("cost unavailable");
    expect(closing).not.toContain("$");
    // Each node still reports the cost it does know, like a collapsed standalone subagent.
    expect(lines.join("\n")).toContain("$0.0120");
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
        { expanded: false, isPartial: false },
        theme,
        slotContext({}),
      )
      .render(100)
      .join("\n");
    expect(wait).toContain("af_waited");
    expect(wait).not.toContain("raw:true");

    const cancelled = tools
      .get("agentflow_cancel")
      .renderResult(
        { details: { snapshots: [snapshot("af_cancelled", "aborted")] } },
        { expanded: false, isPartial: false },
        theme,
        slotContext({}),
      )
      .render(100)
      .join("\n");
    // Cancellation reports the runs it touched and their state, like every control tool.
    expect(cancelled).toContain("af_cancelled");
    expect(cancelled).toContain("aborted");
  });

  it("shows control arguments and bounds steering messages", () => {
    const { tools } = toolsHarness();
    const waitArgs = { runIds: ["af_one", "af_two"] };
    const waitCall = tools
      .get("agentflow_wait")
      .renderCall(waitArgs, theme, slotContext(waitArgs))
      .render(200)
      .join("\n");
    expect(waitCall).toContain("af_one, af_two");

    const steerArgs = { runId: "af_one", nodeId: "finder", message: "one\ntwo\nthree" };
    const collapsedSteer = tools
      .get("agentflow_steer")
      .renderCall(steerArgs, theme, slotContext(steerArgs))
      .render(200)
      .join("\n");
    expect(collapsedSteer).toContain("agentflow_steer · af_one / finder · one two three");

    const expandedSteer = tools
      .get("agentflow_steer")
      .renderCall(steerArgs, theme, slotContext(steerArgs, { expanded: true }))
      .render(200)
      .join("\n");
    expect(expandedSteer).toContain("af_one / finder");
    expect(expandedSteer).toContain("one");
  });
});

describe("agentflow launch tool rendering", () => {
  function launchHarness() {
    const tools = new Map<string, any>();
    const pi = { registerTool: (tool: any) => tools.set(tool.name, tool) };
    registerSemanticTools(pi as never, { launch: vi.fn() } as never);
    registerWorkflowTool(pi as never, {} as never, {} as never);
    return tools;
  }

  const body = (tool: any, details: unknown, expanded: boolean, width = 100) =>
    tool
      .renderResult(
        { details, content: [{ type: "text", text: "RAW" }] },
        { expanded, isPartial: false },
        theme,
        slotContext(tool.name === "agentflow_delegate" ? DELEGATE_ARGS : {}, { expanded }),
      )
      .render(width)
      .join("\n");

  const DELEGATE_ARGS = {
    task: "Extract the parser",
    ownership: ["src/parser.ts"],
    acceptanceCriteria: ["tests pass"],
    verificationCommands: ["nub run test"],
  };

  it("shows a delegate's contract only when expanded", () => {
    const delegate = launchHarness().get("agentflow_delegate");
    const run = snapshot("af_delegate");
    run.semanticRole = "delegate";
    run.logs = ["queued", "started"];

    const collapsed = body(delegate, { snapshot: run }, false);
    expect(collapsed).not.toContain("Ownership");
    expect(collapsed).toContain("✓ completed");

    const expanded = body(delegate, { snapshot: run }, true);
    for (const marker of [
      "Run: af_delegate",
      "Ownership",
      "src/parser.ts",
      "Acceptance criteria",
      "tests pass",
      "Verification",
      "nub run test",
      "Logs",
      "started",
    ])
      expect(expanded, marker).toContain(marker);
    expect(expanded.indexOf("Ownership")).toBeLessThan(expanded.indexOf("Logs"));
  });

  it("describes a workflow by its nodes in both states", () => {
    const workflow = launchHarness().get("agentflow_workflow");
    const run = snapshot("af_workflow");
    run.kind = "workflow";
    run.name = "extract_parser";
    run.phases = ["scan", "fix"];
    run.nodes = [
      { ...run.nodes[0]!, id: "scan_1", label: "scan", phase: "scan", status: "completed" },
      { ...run.nodes[0]!, id: "fix_1", label: "fix", phase: "fix", status: "running", tools: 3 },
    ];

    const collapsed = body(workflow, { snapshot: run }, false);
    expect(collapsed).toContain("✓ scan");
    expect(collapsed).toContain("◆ fix");

    const expanded = body(workflow, { snapshot: run }, true);
    expect(expanded).toContain("Phases: scan → fix");
    expect(expanded).toContain("Nodes");
    expect(expanded).toContain("3 tools");
  });

  it("bounds collapsed workflow nodes and suppresses stale background timing", () => {
    const workflow = launchHarness().get("agentflow_workflow");
    const run = snapshot("af_workflow_bound", "running");
    run.kind = "workflow";
    run.phases = ["scan", "scan"];
    run.background = true;
    run.nodes = Array.from({ length: 10 }, (_, index) => ({
      ...structuredClone(run.nodes[0]!),
      id: `node_${index}`,
      label: index === 9 ? "a workflow node label that is far too long" : `node ${index}`,
      phase: "scan",
      status: index === 0 ? "failed" : index === 9 ? "running" : "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: index > 0 && index < 9 ? "2026-01-01T00:00:02.000Z" : undefined,
      toolCalls:
        index === 9
          ? Array.from({ length: 6 }, (_, callIndex) => ({
              id: `call_${callIndex}`,
              name: "read",
              status: "completed",
              argumentSummary: `file-${callIndex}.ts`,
              startedAt: "2026-01-01T00:00:00.000Z",
            }))
          : [],
    }));

    const collapsed = body(workflow, { snapshot: run }, false);
    expect(collapsed).toContain("2 earlier nodes");
    expect(collapsed).not.toContain("node 0");
    expect(collapsed).toContain("a workflow node");
    expect(collapsed).not.toContain("far too long");
    expect(collapsed.match(/scan/g)).toHaveLength(1);
    expect(collapsed).toContain("✗ scan · 2.0s");
    expect(collapsed).not.toContain("failed");

    const expanded = body(workflow, { snapshot: run }, true);
    expect(expanded).toContain("node 0");
    expect(expanded).toContain("2 earlier tool calls");
    expect(expanded).not.toMatch(/◆ running · \d+(?:s|m|h)/);
  });

  it("names a workflow by its script meta and reports its limits", () => {
    const workflow = launchHarness().get("agentflow_workflow");
    const args = {
      script: 'export const meta = { name: "extract_parser", description: "Split the parser" }',
      limits: { maxAgents: 4, concurrency: 2 },
      mode: "background",
    };
    const header = workflow.renderCall(args, theme, slotContext(args)).render(200).join("\n");
    expect(header).toContain("agentflow_workflow extract_parser · background · Split the parser");

    const run = snapshot("af_workflow");
    run.kind = "workflow";
    const expanded = workflow
      .renderResult(
        { details: { snapshot: run }, content: [] },
        { expanded: true, isPartial: false },
        theme,
        slotContext(args, { expanded: true }),
      )
      .render(100)
      .join("\n");
    expect(expanded).toContain("Max agents: 4");
    expect(expanded).toContain("Concurrency: 2");
  });

  it("falls back to the tool's own text when no snapshot is readable", () => {
    const finder = launchHarness().get("agentflow_finder");
    expect(body(finder, { unexpected: true }, false)).toContain("RAW");
  });

  describe("live elapsed time", () => {
    afterEach(() => {
      stopLiveRedraw();
      vi.useRealTimers();
    });

    /** One row, rendered as often as the shell would once the renderer asks for it. */
    function row(tool: any, details: unknown) {
      const redraws = { count: 0 };
      const ctx = slotContext(
        {},
        { state: {}, invalidate: () => (redraws.count += 1), expanded: false },
      );
      return {
        redraws,
        render: () =>
          tool
            .renderResult(
              { details, content: [{ type: "text", text: "RAW" }] },
              { expanded: false, isPartial: false },
              theme,
              ctx,
            )
            .render(100)
            .join("\n"),
      };
    }

    it("advances a running run's elapsed time and stops once it settles", () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:02.000Z") });
      const finder = launchHarness().get("agentflow_finder");
      const running = row(finder, { snapshot: snapshot("af_live", "running") });

      expect(running.render()).toContain("2.0s");
      vi.advanceTimersByTime(3_000);
      expect(running.redraws.count).toBe(3);
      expect(running.render()).toContain("5.0s");

      // The run settles: the row reports a fixed duration and asks for nothing more.
      const settled = row(finder, { snapshot: snapshot("af_live") });
      settled.render();
      vi.advanceTimersByTime(3_000);
      expect(settled.redraws.count).toBe(0);
      expect(settled.render()).toContain("2.0s");
    });

    /**
     * The launch card of a background run is the one row that can never be corrected: the engine
     * writes its snapshot once and delivers the finished run as a message of its own. So it
     * reports no duration at all — one measured against the clock would grow on every unrelated
     * redraw, and would still be counting long after the run ended.
     */
    it("reports no duration on a background launch card, and never redraws it", () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:02.000Z") });
      const finder = launchHarness().get("agentflow_finder");
      const launched = row(finder, {
        snapshot: { ...snapshot("af_bg", "running"), background: true },
      });
      // A foreground run of the same age, for contrast: it does report a duration, and ticks.
      const foreground = row(finder, { snapshot: snapshot("af_fg", "running") });

      expect(launched.render()).toContain("running in the background");
      expect(launched.render()).not.toMatch(/\d+s/);
      expect(foreground.render()).toContain("2.0s");

      vi.advanceTimersByTime(5_000);
      expect(launched.redraws.count).toBe(0);
      expect(launched.render()).not.toMatch(/\d+s/);
      expect(foreground.redraws.count).toBe(5);
      expect(foreground.render()).toContain("7.0s");
    });

    it("leaves a control tool's recorded observation alone", () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:02.000Z") });
      const { tools, engine } = toolsHarness();
      engine.getSnapshot.mockReturnValue(snapshot("af_live", "running"));
      const status = tools.get("agentflow_status");
      const observed = row(status, {
        snapshot: snapshot("af_live", "running"),
        observedAt: Date.parse("2026-01-01T00:00:02.000Z"),
      });

      expect(observed.render()).toContain("2.0s");
      vi.advanceTimersByTime(3_000);
      expect(observed.redraws.count).toBe(0);
      expect(observed.render()).toContain("2.0s");
    });
  });
});
