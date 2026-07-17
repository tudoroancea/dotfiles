import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/runtime/artifact-store.ts";
import { RunEngine } from "../src/runtime/run-engine.ts";
import { executeWorkflow } from "../src/runtime/workflow-runtime.ts";
import { SemanticAgentService } from "../src/semantic/semantic-agent-service.ts";
import type { AgentTaskResult, RunSnapshot, SemanticRole } from "../src/types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 };
const success = (output: string): AgentTaskResult => ({
  ok: true,
  output,
  aborted: false,
  usage,
});

describe("semantic workflow IPC", () => {
  it("executes every semantic helper plus raw agents through one serializable workflow", async () => {
    const roles: Array<{ role: SemanticRole; input: unknown; id: string }> = [];
    const rawNodes: any[] = [];
    const phases: string[] = [];
    const controller = new AbortController();
    const snapshot: RunSnapshot = {
      runId: "af_workflow",
      kind: "workflow",
      name: "all_helpers",
      originTool: "agentflow_workflow",
      status: "running",
      createdAt: new Date(0).toISOString(),
      phases,
      nodes: [],
      logs: [],
    };
    const engine = {
      startRun: vi.fn(() => snapshot.runId),
      setArtifact: vi.fn(async () => "/tmp/agentflow-artifact"),
      getResult: vi.fn(() => undefined),
      getRunAbortSignal: () => controller.signal,
      getLimits: () => ({ maxAgents: 16, concurrency: 4 }),
      addPhase: (_runId: string, phase: string) => phases.push(phase),
      log: vi.fn(),
      runTask: async (_runId: string, node: unknown) => {
        rawNodes.push(node);
        return success("raw");
      },
      isRunAborted: () => controller.signal.aborted,
      abortAndWait: vi.fn(async () => true),
      cancel: vi.fn(async () => []),
      getSnapshot: () => snapshot,
      finish: (
        _runId: string,
        status: RunSnapshot["status"],
        result?: unknown,
        error?: string,
      ) => ({
        runId: snapshot.runId,
        status,
        result,
        error,
        snapshot: { ...snapshot, status },
      }),
    };
    const semanticService = {
      runInWorkflow: async (_runId: string, role: SemanticRole, input: unknown, id: string) => {
        roles.push({ role, input, id });
        return success(role);
      },
    };
    const script = `export const meta = { name: "all_helpers", description: "Exercise semantic IPC", phases: [{ title: "Inspect" }, { title: "Implement" }] }
phase("Inspect")
const readOnly = await parallel([
  () => finder({ task: "find" }),
  () => oracle({ question: "advise" }),
  () => librarian({ question: "research" }),
  () => look_at({ path: "screen.png", objective: "inspect" }),
  () => review({ task: "review" }),
])
phase("Implement")
const mutation = args.useDelegate ? await delegate({ task: "edit", ownership: ["src/a.ts"], acceptanceCriteria: ["done"], verificationCommands: ["test"] }) : null
const piped = await pipeline(["one", "two"], async (value) => value + "!")
const raw = await agent("raw task", { label: "raw" })
return { readOnly, mutation, piped, raw, cwd, budget }`;

    const result = await executeWorkflow({
      script,
      args: { useDelegate: true },
      ctx: { cwd: "/tmp/project" } as never,
      engine: engine as never,
      semanticService: semanticService as never,
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(roles.map(({ role }) => role).sort()).toEqual(
      ["finder", "oracle", "librarian", "look_at", "delegate", "review"].sort(),
    );
    expect(new Set(roles.map(({ id }) => id)).size).toBe(6);
    expect(rawNodes).toHaveLength(1);
    expect(rawNodes[0]).toMatchObject({
      label: "raw",
      originTool: "agentflow_workflow",
    });
    expect(phases).toEqual(["Inspect", "Implement"]);
    expect((result as any).result).toMatchObject({
      mutation: { ok: true, output: "delegate" },
      raw: { ok: true, output: "raw" },
      piped: ["one!", "two!"],
      cwd: "/tmp/project",
    });
  });

  it("preserves an explicit token-budget error instead of reporting an IPC symptom", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-workflow-budget-"));
    try {
      const engine = new RunEngine(
        undefined,
        undefined,
        undefined,
        undefined,
        {
          run: async () => ({
            text: "large result",
            usage: { ...usage, total: 2 },
          }),
        },
        undefined,
        () => true,
        new ArtifactStore(root),
      );
      const result = await executeWorkflow({
        script: `export const meta = { name: "budget_failure", description: "Preserve the cause" }
const child = await agent("work")
return { child }`,
        limits: { tokenBudget: 1 },
        ctx: { cwd: "/tmp/project" } as never,
        engine,
        semanticService: {} as never,
      });

      expect(result).toMatchObject({
        status: "aborted",
        error: "Token budget exceeded (2/1)",
        snapshot: {
          error: "Token budget exceeded (2/1)",
          nodes: [{ error: "Token budget exceeded (2/1)" }],
        },
      });
      expect((result as any).error).not.toMatch(/IPC|EPIPE|disconnected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a checked child failure as the top-level workflow error", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-workflow-child-failure-"));
    try {
      const engine = new RunEngine(
        undefined,
        undefined,
        undefined,
        undefined,
        { run: async () => Promise.reject(new Error("Provider disconnected")) },
        undefined,
        () => true,
        new ArtifactStore(root),
      );
      const result = await executeWorkflow({
        script: `export const meta = { name: "child_failure", description: "Preserve the cause" }
const child = await agent("work")
if (!child.ok) throw new Error(child.error ?? "Child failed")
return { child }`,
        ctx: { cwd: "/tmp/project" } as never,
        engine,
        semanticService: {} as never,
      });

      expect(result).toMatchObject({ status: "failed", error: "Provider disconnected" });
      expect((result as any).error).not.toMatch(/Workflow sandbox IPC|EPIPE/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists provenance from real semantic workflow scheduling through artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-workflow-"));
    try {
      const artifacts = new ArtifactStore(root);
      const engine = new RunEngine(
        undefined,
        undefined,
        undefined,
        undefined,
        {
          run: async () => ({
            text: "finder complete",
            structured: { summary: "done", findings: [], unresolvedQuestions: [] },
            usage,
          }),
        },
        2,
        () => true,
        artifacts,
      );
      const fffPath = "/extensions/pi-fff/index.ts";
      const semantic = new SemanticAgentService(engine, () =>
        ["ffgrep", "fffind"].map((name) => ({
          name,
          sourceInfo: { path: fffPath, source: "pi-fff" },
        })),
      );
      const result = await executeWorkflow({
        script: `export const meta = { name: "artifact_provenance", description: "Persist provenance" }
const found = await finder({ task: "inspect" })
return { found }`,
        ctx: { cwd: "/tmp/project" } as never,
        engine,
        semanticService: semantic,
      });
      if (!("snapshot" in result) || !result.snapshot.artifactDir)
        throw new Error("workflow artifact directory missing");
      const artifactDir = result.snapshot.artifactDir;

      await vi.waitFor(async () => {
        const transcripts = JSON.parse(
          await readFile(join(artifactDir, "transcripts.json"), "utf8"),
        );
        expect(transcripts[0]).toMatchObject({
          originTool: "agentflow_workflow",
          semanticRole: "finder",
          prompt: "inspect",
          cwd: "/tmp/project",
          status: "completed",
        });
      });
      const persistedResult = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
      expect(persistedResult.result.found).toMatchObject({
        ok: true,
        output: "finder complete",
        structured: { summary: "done", findings: [] },
        aborted: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
