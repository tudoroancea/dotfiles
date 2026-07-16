import { describe, expect, it, vi } from "vitest";
import { registerSemanticTools } from "../src/tools/semantic-tools.ts";

describe("semantic tool registration", () => {
  it("registers contextual guidelines that name each tool", () => {
    const tools: any[] = [];
    registerSemanticTools(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      { launch: vi.fn() } as never,
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "agentflow_finder",
      "agentflow_oracle",
      "agentflow_librarian",
      "agentflow_look_at",
      "agentflow_delegate",
      "agentflow_review",
    ]);
    for (const tool of tools) {
      expect(tool.promptGuidelines).toHaveLength(1);
      expect(tool.promptGuidelines[0]).toContain(tool.name);
    }

    const lookAt = tools.find((tool) => tool.name === "agentflow_look_at");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const rendered = lookAt.renderCall(
      {
        path: "screens/current.png",
        objective: "Compare navigation",
        referenceFiles: ["screens/expected.png"],
      },
      theme,
    );
    expect(rendered.render(200)[0]).toContain(
      "look_at screens/current.png — Compare navigation (+1 ref)",
    );
  });

  it("publishes ordered foreground snapshots that update stable tool-call ids", async () => {
    const tools: any[] = [];
    const base = {
      runId: "af_live",
      kind: "agent",
      name: "finder",
      semanticRole: "finder",
      status: "running",
      createdAt: new Date(0).toISOString(),
      phases: [],
      logs: [],
    };
    const node = {
      id: "finder_1",
      label: "finder",
      semanticRole: "finder",
      status: "running",
      tools: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    };
    const snapshots = [
      {
        ...base,
        nodes: [
          {
            ...node,
            toolCalls: [
              {
                id: "call-read",
                name: "read",
                status: "running",
                startedAt: "1",
                argumentSummary: "src/auth.ts:1-20",
              },
            ],
          },
        ],
      },
      {
        ...base,
        nodes: [
          {
            ...node,
            toolCalls: [
              {
                id: "call-read",
                name: "read",
                status: "completed",
                startedAt: "1",
                completedAt: "2",
                argumentSummary: "src/auth.ts:1-20",
              },
              {
                id: "call-search",
                name: "ffgrep",
                status: "running",
                startedAt: "3",
                argumentSummary: "refreshToken",
              },
            ],
          },
        ],
      },
    ];
    const service = {
      launch: vi.fn(async (_role, _params, _ctx, options) => {
        for (const snapshot of snapshots) options.onUpdate(snapshot);
        return {
          runId: "af_live",
          status: "completed",
          result: { findings: [] },
          snapshot: { ...snapshots[1], status: "completed" },
        };
      }),
    };
    registerSemanticTools(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      service as never,
    );
    const finder = tools.find((tool) => tool.name === "agentflow_finder");
    const updates: any[] = [];

    await finder.execute(
      "tool-call",
      { task: "inspect" },
      new AbortController().signal,
      (update: unknown) => updates.push(update),
      {},
    );

    expect(updates).toHaveLength(2);
    expect(updates[0].details.snapshot.nodes[0].toolCalls).toMatchObject([
      { id: "call-read", status: "running" },
    ]);
    expect(updates[1].details.snapshot.nodes[0].toolCalls).toMatchObject([
      { id: "call-read", status: "completed" },
      { id: "call-search", status: "running" },
    ]);
  });
});
