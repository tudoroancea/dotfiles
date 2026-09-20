import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { registerClaudeTool } from "../src/tools/claude-tool.ts";

const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, cost: 0.12 };

function snapshot(model = "opus") {
  return {
    runId: "af_claude",
    kind: "agent",
    name: `claude/${model}`,
    originTool: "agentflow_claude",
    status: "completed",
    createdAt: new Date(0).toISOString(),
    phases: [],
    logs: [],
    nodes: [
      {
        id: "claude",
        label: `claude/${model}`,
        originTool: "agentflow_claude",
        backend: "claude",
        model,
        prompt: "Advise only",
        cwd: "/tmp/project",
        status: "completed",
        tools: 0,
        toolCalls: [],
        usage,
        resultPreview: "recommendation",
      },
    ],
  };
}

function registeredTool(launchAgent: ReturnType<typeof vi.fn>) {
  const tools: any[] = [];
  registerClaudeTool(
    { registerTool: (tool: unknown) => tools.push(tool) } as never,
    { launchAgent } as never,
  );
  return tools[0]!;
}

describe("agentflow_claude tool", () => {
  it("registers only the strict task, model, and mode inputs", () => {
    const tool = registeredTool(vi.fn());

    expect(tool.name).toBe("agentflow_claude");
    expect(Object.keys(tool.parameters.properties)).toEqual(["task", "model", "mode"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(Check(tool.parameters, { task: "review" })).toBe(true);
    expect(Check(tool.parameters, { task: "review", model: "fable", mode: "background" })).toBe(
      true,
    );
    expect(Check(tool.parameters, { task: "review", model: "haiku" })).toBe(false);
    expect(Check(tool.parameters, { task: "review", cwd: "/tmp" })).toBe(false);
  });

  it("defaults to Opus and routes foreground updates and cost through a marked node", async () => {
    const current = snapshot();
    const launchAgent = vi.fn(async (node, _ctx, options) => {
      options.onUpdate(current);
      return {
        runId: current.runId,
        status: "completed",
        result: "recommendation",
        snapshot: current,
      };
    });
    const tool = registeredTool(launchAgent);
    const updates: unknown[] = [];

    const result = await tool.execute(
      "call",
      { task: "Advise only" },
      new AbortController().signal,
      (update: unknown) => updates.push(update),
      { cwd: "/tmp/project" },
    );

    expect(launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        claude: true,
        prompt: "Advise only",
        originTool: "agentflow_claude",
        config: { model: "opus" },
      }),
      expect.anything(),
      expect.objectContaining({ background: false }),
    );
    expect(updates).toEqual([expect.objectContaining({ details: { snapshot: current } })]);
    expect(result.content[0].text).toBe("recommendation");
    expect(result.details).toMatchObject({ cost: 0.12, snapshot: current });
  });

  it("starts background Sonnet runs without advertising unsupported steering", async () => {
    const current = { ...snapshot("sonnet"), status: "running" };
    const launchAgent = vi.fn(async (_node: unknown, _ctx: unknown, options: any) => {
      expect(options.onUpdate).toBeUndefined();
      return { runId: current.runId, snapshot: current };
    });
    const tool = registeredTool(launchAgent);

    const result = await tool.execute(
      "call",
      { task: "Implement the UI", model: "sonnet", mode: "background" },
      new AbortController().signal,
      undefined,
      { cwd: "/tmp/project" },
    );

    expect(launchAgent.mock.calls[0]![0]).toMatchObject({
      claude: true,
      config: { model: "sonnet" },
    });
    expect(result.content[0].text).toContain(
      "agentflow_status, agentflow_wait, or agentflow_cancel",
    );
    expect(result.content[0].text).not.toContain("steer");
  });
});
