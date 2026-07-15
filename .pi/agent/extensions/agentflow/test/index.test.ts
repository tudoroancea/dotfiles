import { describe, expect, it, vi } from "vitest";
import agentflowExtension from "../src/index.ts";

function load(raw: boolean): { beforeStart: string[]; afterStart: string[] } {
  const tools: string[] = [];
  const flags = new Map<string, unknown>();
  let start: (() => void) | undefined;
  const pi = {
    registerFlag(name: string, options: { default?: unknown }) {
      flags.set(name, name === "agentflow-raw" ? raw : options.default);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "session_start" && !start) start = handler;
    }),
    getActiveTools: () => [],
    getThinkingLevel: () => undefined,
    sendMessage: vi.fn(),
    events: { emit: vi.fn() },
  };
  agentflowExtension(pi as never);
  const beforeStart = [...tools];
  start?.();
  return { beforeStart, afterStart: tools };
}

describe("extension tool registration", () => {
  it("hides raw launch tools by default", () => {
    expect(load(false).afterStart).toEqual([
      "agentflow_finder",
      "agentflow_oracle",
      "agentflow_librarian",
      "agentflow_look_at",
      "agentflow_delegate",
      "agentflow_review",
      "agentflow_status",
      "agentflow_wait",
      "agentflow_cancel",
      "agentflow_steer",
    ]);
  });

  it("registers raw launch tools at session start only behind --agentflow-raw", () => {
    const tools = load(true);
    expect(tools.beforeStart).not.toContain("agentflow_agent");
    expect(tools.beforeStart).not.toContain("agentflow_workflow");
    expect(tools.afterStart).toEqual([
      "agentflow_finder",
      "agentflow_oracle",
      "agentflow_librarian",
      "agentflow_look_at",
      "agentflow_delegate",
      "agentflow_review",
      "agentflow_status",
      "agentflow_wait",
      "agentflow_cancel",
      "agentflow_steer",
      "agentflow_agent",
      "agentflow_workflow",
    ]);
  });
});
