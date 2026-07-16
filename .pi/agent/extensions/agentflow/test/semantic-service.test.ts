import { describe, expect, it } from "vitest";
import { SemanticAgentService } from "../src/semantic/semantic-agent-service.ts";
import { validateSemanticInput } from "../src/semantic/profiles.ts";

const FFF_EXTENSION = "/extensions/pi-fff/index.ts";
const fffTools = ["ffgrep", "fffind"].map((name) => ({
  name,
  sourceInfo: { path: FFF_EXTENSION, source: "pi-fff" },
}));
const service = (
  tools: Array<{ name: string; sourceInfo?: { path?: string; source?: string } }> = [],
) => new SemanticAgentService({} as never, () => [...fffTools, ...tools]);

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

  it.each(["finder", "oracle", "look_at", "review"] as const)(
    "confines %s to read-only tools and normal Pi context",
    async (role) => {
      const node = await service().createNode(
        role,
        role === "oracle"
          ? { question: "why?" }
          : role === "finder"
            ? { task: "find it" }
            : role === "look_at"
              ? { path: "screen.png", objective: "find visual regressions" }
              : {},
      );
      expect(node.config?.tools).not.toContain("bash");
      expect(node.config?.tools).not.toContain("edit");
      expect(node.config?.tools).not.toContain("write");
      expect(node.config?.session?.inheritParentContext).toBe(true);
      expect(node.config?.systemPrompt).toBeUndefined();
      expect(node.config?.usePiSystemPrompt).toBe(true);
      expect(node.config?.appendSystemPrompt).toContain(`You are the ${role} specialist`);
      if (role === "look_at") expect(node.config?.extensions).toBe(false);
      else expect(node.config?.extensions).toEqual([FFF_EXTENSION]);
    },
  );

  it.each([
    ["finder", { task: "find it" }, "gpt-5.6-luna", "low"],
    ["oracle", { question: "why?" }, "gpt-5.6-sol", "xhigh"],
    ["look_at", { path: "screen.png", objective: "inspect it" }, "gpt-5.6-luna", "low"],
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

  it("strictly validates bounded look_at input", () => {
    const input = {
      path: "screen.png",
      objective: "Compare the navigation states",
      context: "Regression check",
      referenceFiles: ["expected.png"],
      mode: "background",
    };
    expect(validateSemanticInput("look_at", input)).toEqual(input);
    expect(() => validateSemanticInput("look_at", { ...input, unexpected: true })).toThrow(
      "Invalid look_at input",
    );
    expect(() => validateSemanticInput("look_at", { path: "", objective: "inspect" })).toThrow(
      "Invalid look_at input",
    );
    expect(() =>
      validateSemanticInput("look_at", {
        path: "screen.png",
        objective: "inspect",
        referenceFiles: Array.from({ length: 33 }, () => "reference.png"),
      }),
    ).toThrow("Invalid look_at input");
  });

  it("compiles look_at as an isolated read-only multimodal child", async () => {
    const node = await service().createNode("look_at", {
      path: "screen.png",
      objective: "Compare layout",
      context: "Desktop breakpoint",
      referenceFiles: ["expected.png"],
    });
    expect(node.prompt).toContain("screen.png");
    expect(node.prompt).toContain("expected.png");
    expect(node.prompt).toContain("Compare layout");
    expect(node.config).toMatchObject({
      model: "gpt-5.6-luna",
      thinking: "low",
      tools: ["read"],
      skills: false,
      extensions: false,
      session: { mode: "memory" },
    });
    expect(node.config?.outputSchema).toBeDefined();
    expect(node.config?.appendSystemPrompt).toContain("Never guess");
    expect(node.config?.appendSystemPrompt).toContain("every reference");
  });

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

  it("keeps delegate on the inherited model and names its file session", async () => {
    const node = await service().createNode("delegate", {
      task: "implement the authentication flow",
      ownership: ["src/auth.ts"],
      acceptanceCriteria: ["tests pass"],
      verificationCommands: ["npm test"],
    });
    expect(node.config?.model).toBeUndefined();
    expect(node.config?.inheritModelProvider).toBe(false);
    expect(node.config?.thinking).toBe("medium");
    expect(node.config?.session).toMatchObject({
      mode: "file",
      name: "delegate: implement the authentication flow",
    });
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

  it("gives delegate the globally active background-process extension", async () => {
    const path = "/extensions/background-processes/index.ts";
    const tools = [
      "background_bash",
      "monitor",
      "background_status",
      "background_wait",
      "background_stop",
    ].map((name) => ({ name, sourceInfo: { path, source: "local" } }));
    const node = await service(tools).createNode("delegate", {
      task: "implement",
      ownership: ["src/auth.ts"],
      acceptanceCriteria: ["tests pass"],
      verificationCommands: ["npm test"],
    });
    expect(node.config?.extensions).toEqual([FFF_EXTENSION, path]);
    expect(node.config?.tools).toEqual(
      expect.arrayContaining(["background_bash", "background_wait"]),
    );
    expect(node.config?.extensionMode).toBe("rpc");
  });

  it("omits background processes unless the complete extension is globally active", async () => {
    const node = await service([
      {
        name: "background_bash",
        sourceInfo: { path: "/extensions/background-processes/index.ts", source: "local" },
      },
    ]).createNode("delegate", {
      task: "implement",
      ownership: ["src/auth.ts"],
      acceptanceCriteria: ["tests pass"],
      verificationCommands: ["npm test"],
    });
    expect(node.config?.tools).not.toContain("background_bash");
    expect(node.config?.extensionMode).toBe("print");
  });

  it("fails librarian early when research capabilities are unavailable", async () => {
    await expect(service().createNode("librarian", { question: "research" })).rejects.toThrow(
      "Librarian capabilities unavailable",
    );
  });

  it("fails search roles early when FFF capabilities are unavailable", async () => {
    const semantic = new SemanticAgentService({} as never, () => []);
    await expect(semantic.createNode("finder", { task: "find it" })).rejects.toThrow(
      "FFF search capabilities unavailable",
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
    const semantic = new SemanticAgentService(engine as never, () => fffTools);
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
      () => fffTools,
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
