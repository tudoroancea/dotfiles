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
      "agentflow_delegate",
      "agentflow_review",
    ]);
    for (const tool of tools) {
      expect(tool.promptGuidelines).toHaveLength(1);
      expect(tool.promptGuidelines[0]).toContain(tool.name);
    }
  });
});
