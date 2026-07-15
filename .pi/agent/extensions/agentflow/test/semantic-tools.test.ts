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
});
