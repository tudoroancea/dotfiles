import { describe, expect, it } from "vitest";
import { registerWorkflowTool } from "../src/tools/workflow-tool.ts";

describe("workflow tool authoring contract", () => {
  it("exposes the required header, bare-helper syntax, and unlimited-default guidance", () => {
    const tools: any[] = [];
    registerWorkflowTool(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      {} as never,
      {} as never,
    );

    const workflow = tools[0];
    expect(workflow.description).toContain("export const meta");
    expect(workflow.description).toContain("never use agent.delegate");
    expect(workflow.description).toContain("Omit limits by default");
    expect(workflow.promptGuidelines.join("\n")).toContain("delegate({...})");
    expect(workflow.promptGuidelines.join("\n")).toContain(
      "only when the user explicitly requests",
    );
    expect(workflow.parameters.properties.script.description).toContain("export const meta");
    expect(workflow.parameters.properties.limits.description).toContain(
      "no agent-count, concurrency, or token budget cap",
    );
  });
});
