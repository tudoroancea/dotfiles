import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/runtime/artifact-store.ts";
import type { RunResult, RunSnapshot } from "../src/types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow artifacts", () => {
  it("persists semantic provenance and result envelopes in a package-isolated tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-artifacts-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    const runId = "af_semantic";
    const artifactDir = await store.create(runId, "return await finder({ task: 'inspect' })", {
      scope: "src",
    });
    const snapshot: RunSnapshot = {
      runId,
      sessionId: "session-a",
      kind: "workflow",
      name: "semantic_helpers",
      originTool: "agentflow_workflow",
      status: "completed",
      createdAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      phases: ["Inspect"],
      nodes: [
        {
          id: "task_1",
          label: "finder",
          originTool: "agentflow_workflow",
          semanticRole: "finder",
          prompt: "Inspect authentication boundaries",
          cwd: "/tmp/project",
          status: "completed",
          tools: 1,
          toolCalls: [],
          resultPreview: '{"findings":[]}',
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.01 },
        },
      ],
      logs: [],
      artifactDir,
    };
    const result: RunResult = {
      runId,
      status: "completed",
      result: {
        finder: {
          ok: true,
          output: "done",
          aborted: false,
          usage: { total: 3 },
        },
      },
      snapshot,
    };

    await store.finish(result);

    const persistedRun = JSON.parse(await readFile(join(artifactDir, "run.json"), "utf8"));
    const transcripts = JSON.parse(await readFile(join(artifactDir, "transcripts.json"), "utf8"));
    const persistedResult = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    expect(persistedRun.nodes[0]).toMatchObject({
      originTool: "agentflow_workflow",
      semanticRole: "finder",
      prompt: "Inspect authentication boundaries",
      cwd: "/tmp/project",
    });
    expect(persistedRun.sessionId).toBe("session-a");
    expect(transcripts[0]).toMatchObject({
      originTool: "agentflow_workflow",
      semanticRole: "finder",
      prompt: "Inspect authentication boundaries",
      cwd: "/tmp/project",
      result: '{"findings":[]}',
    });
    expect(persistedResult.result.finder).toMatchObject({ ok: true, output: "done" });
    await expect(store.recover()).resolves.toMatchObject([
      {
        sessionId: "session-a",
        nodes: [{ prompt: "Inspect authentication boundaries", cwd: "/tmp/project" }],
      },
    ]);
  });

  it("serializes a pending checkpoint before the terminal snapshot", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "agentflow-artifact-settlement-"));
    roots.push(root);
    try {
      const store = new ArtifactStore(root);
      const runId = "af_settlement";
      const artifactDir = await store.initialize(runId);
      const running: RunSnapshot = {
        runId,
        kind: "agent",
        status: "running",
        createdAt: new Date(0).toISOString(),
        phases: [],
        nodes: [],
        logs: [],
        artifactDir,
      };
      store.checkpoint(running);
      vi.advanceTimersByTime(250);

      await store.finish({
        runId,
        status: "completed",
        result: "done",
        snapshot: {
          ...running,
          status: "completed",
          completedAt: new Date(1).toISOString(),
          resultPreview: "done",
        },
      });

      await expect(readFile(join(artifactDir, "run.json"), "utf8")).resolves.toContain(
        '"status": "completed"',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers interrupted checkpoints with prompt and cwd intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-recovery-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    const artifactDir = await store.create("af_running", "return null", null);
    await writeFile(
      join(artifactDir, "run.json"),
      JSON.stringify({
        runId: "af_running",
        sessionId: "session-a",
        kind: "agent",
        status: "running",
        createdAt: new Date(0).toISOString(),
        phases: [],
        logs: [],
        nodes: [
          {
            id: "agent",
            label: "agent",
            prompt: "Initial task prompt",
            cwd: "/effective/cwd",
            status: "running",
            startedAt: new Date(0).toISOString(),
            tools: 0,
            toolCalls: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
          },
        ],
      }),
    );

    const [snapshot] = await store.recover();
    expect(snapshot).toMatchObject({
      sessionId: "session-a",
      status: "aborted",
      nodes: [
        {
          status: "aborted",
          prompt: "Initial task prompt",
          cwd: "/effective/cwd",
        },
      ],
    });
  });
});
