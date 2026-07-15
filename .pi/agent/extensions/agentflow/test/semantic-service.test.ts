import { describe, expect, it } from "vitest";
import { SemanticAgentService } from "../src/semantic/semantic-agent-service.ts";
import { validateSemanticInput } from "../src/semantic/profiles.ts";

const service = (
  tools: Array<{ name: string; sourceInfo?: { path?: string; source?: string } }> = [],
) => new SemanticAgentService({} as never, () => tools);

describe("semantic profiles", () => {
  it("strictly validates model-facing input", () => {
    expect(() => validateSemanticInput("finder", { task: "locate auth", tools: ["bash"] })).toThrow(
      "Invalid finder input",
    );
    expect(validateSemanticInput("finder", { task: "locate auth", paths: ["src"] })).toEqual({
      task: "locate auth",
      paths: ["src"],
    });
  });

  it.each(["finder", "oracle", "review"] as const)(
    "confines %s to read-only tools and normal Pi context",
    async (role) => {
      const node = await service().createNode(
        role,
        role === "oracle" ? { question: "why?" } : role === "finder" ? { task: "find it" } : {},
      );
      expect(node.config?.tools).not.toContain("bash");
      expect(node.config?.tools).not.toContain("edit");
      expect(node.config?.tools).not.toContain("write");
      expect(node.config?.session?.inheritParentContext).toBe(true);
      expect(node.config?.systemPrompt).toBeUndefined();
      expect(node.config?.usePiSystemPrompt).toBe(true);
      expect(node.config?.appendSystemPrompt).toContain(`You are the ${role} specialist`);
      expect(node.config?.extensions).toBe(false);
    },
  );

  it.each([
    ["finder", { task: "find it" }, "gpt-5.6-luna", "low"],
    ["oracle", { question: "why?" }, "gpt-5.6-sol", "xhigh"],
    ["review", {}, "gpt-5.6-sol", "xhigh"],
  ] as const)(
    "uses the configured %s model and thinking level",
    async (role, input, model, thinking) => {
      const node = await service().createNode(role, input);
      expect(node.config).toMatchObject({
        model,
        inheritModelProvider: true,
        thinking,
      });
    },
  );

  it("uses the configured librarian model and thinking level", async () => {
    const tools = ["web_search", "fetch_content", "get_search_content"].map((name) => ({
      name,
      sourceInfo: { path: "/extensions/research.ts", source: "research" },
    }));
    const node = await service(tools).createNode("librarian", { question: "research" });
    expect(node.config).toMatchObject({
      model: "gpt-5.6-sol",
      inheritModelProvider: true,
      thinking: "low",
    });
  });

  it("keeps delegate on the inherited model", async () => {
    const node = await service().createNode("delegate", {
      task: "implement",
      ownership: ["src/auth.ts"],
      acceptanceCriteria: ["tests pass"],
      verificationCommands: ["npm test"],
    });
    expect(node.config?.model).toBeUndefined();
    expect(node.config?.inheritModelProvider).toBe(false);
    expect(node.config?.thinking).toBe("medium");
  });

  it("uses an exact existing delegate session when continuation is requested", async () => {
    const node = await service().createNode("delegate", {
      task: "implement",
      ownership: ["src/auth.ts"],
      acceptanceCriteria: ["tests pass"],
      verificationCommands: ["npm test"],
      continuationSessionFile: "/tmp/exact.jsonl",
    });
    expect(node.config?.session).toMatchObject({ mode: "existing", file: "/tmp/exact.jsonl" });
    expect(node.config?.tools).toEqual(expect.arrayContaining(["edit", "write", "bash"]));
  });

  it("fails librarian early when research capabilities are unavailable", async () => {
    await expect(service().createNode("librarian", { question: "research" })).rejects.toThrow(
      "Librarian capabilities unavailable",
    );
  });

  it("rejects overlapping background delegates until the active run settles", async () => {
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const engine = {
      launchAgent: async () => ({ runId: "run-1", snapshot: {} }),
      observeCompletion: async () => completion,
    };
    const semantic = new SemanticAgentService(engine as never, () => []);
    const input = {
      task: "implement",
      ownership: ["src/auth"],
      acceptanceCriteria: ["done"],
      verificationCommands: ["test"],
      mode: "background",
    };
    await semantic.launch("delegate", input, {} as never, { background: true });
    await expect(
      semantic.launch("delegate", { ...input, ownership: ["src/auth/session.ts"] }, {} as never, {
        background: true,
      }),
    ).rejects.toThrow("ownership overlaps");
    settle();
    await completion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      semantic.launch("delegate", { ...input, ownership: ["src/auth/session.ts"] }, {} as never, {
        background: true,
      }),
    ).resolves.toMatchObject({ runId: "run-1" });
  });

  it("marks semantic workflow tasks with workflow origin and semantic role", async () => {
    let node: any;
    const semantic = new SemanticAgentService(
      {
        runTask: async (_runId: string, value: unknown) => {
          node = value;
          return { ok: true, output: "done", aborted: false, usage: { total: 0 } };
        },
      } as never,
      () => [],
    );
    await semantic.runInWorkflow("run", "finder", { task: "inspect" }, "task");
    expect(node).toMatchObject({
      originTool: "agentflow_workflow",
      semanticRole: "finder",
    });
  });

  it("returns a serializable workflow failure envelope for invalid input", async () => {
    const semantic = new SemanticAgentService({ isRunAborted: () => false } as never, () => []);
    await expect(semantic.runInWorkflow("run", "finder", {}, "task")).resolves.toMatchObject({
      ok: false,
      aborted: false,
      usage: { total: 0 },
    });
  });

  it("resolves librarian tools to explicit extension paths", async () => {
    const tools = ["web_search", "fetch_content", "get_search_content"].map((name) => ({
      name,
      sourceInfo: { path: "/extensions/research.ts", source: "research" },
    }));
    const node = await service(tools).createNode("librarian", { question: "research" });
    expect(node.config?.extensions).toEqual(["/extensions/research.ts"]);
    expect(node.config?.tools).toEqual(["web_search", "fetch_content", "get_search_content"]);
  });
});
