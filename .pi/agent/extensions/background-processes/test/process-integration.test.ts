import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundProcessesExtension from "../src/index.ts";
import { ArtifactStore } from "../src/runtime/artifact-store.ts";
import { MAX_GENERATED_JOB_ID } from "../src/runtime/job-store.ts";
import { ProcessRuntime } from "../src/runtime/process-runtime.ts";
import { ARTIFACT_JOB_PATH_MAX_BYTES, type SerializedJobs } from "../src/runtime/results.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRuntime(
  options: ConstructorParameters<typeof ProcessRuntime>[1] = {},
): Promise<ProcessRuntime> {
  const root = await mkdtemp(join(tmpdir(), "pi-background-process-"));
  roots.push(root);
  const artifacts = new ArtifactStore("integration", { root });
  const runtime = new ProcessRuntime("integration", { ...options, artifacts });
  await runtime.initialize();
  return runtime;
}

async function waitForOutput(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const output = await readFile(path, "utf8").catch(() => "");
    if (output.trim().split(/\s+/).length >= 2) return output;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("process did not emit PID output");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessesDead(pids: number[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`processes remained alive: ${pids.filter(isAlive).join(", ")}`);
}

describe("local process integration", () => {
  it("delivers repeated-whitespace root paths exactly and releases capacity", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-background-process-parent-"));
    roots.push(parent);
    const root = join(parent, "artifact   root");
    const artifacts = new ArtifactStore("integration", { root, runtimeId: "runtime" });
    const runtime = new ProcessRuntime("integration", {
      artifacts,
      completedRecordLimit: 1,
    });
    await runtime.initialize();
    const job = await runtime.launch({
      kind: "background_bash",
      command: "printf exact",
      cwd: process.cwd(),
    });
    runtime.markLaunchTransferred(job.id);
    for (
      let attempt = 0;
      attempt < 200 && runtime.get(job.id)?.status === "running";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const send = vi.fn();

    await runtime.flushCompletionDeliveries(send);

    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]![0] as SerializedJobs;
    expect(payload.jobs[0]).toMatchObject({
      outputPath: job.outputPath,
      metadataPath: job.metadataPath,
      deliveryState: "sending",
    });
    expect(payload.text).toContain("artifact   root");
    expect(runtime.get(job.id)?.deliveryState).toBe("sent");
    await expect(
      runtime.launch({ kind: "background_bash", command: "true", cwd: process.cwd() }),
    ).resolves.toMatchObject({ id: "bg_2" });
    await runtime.shutdown();
  });

  it("supports deepest-root turnover beyond 99 launches through delivery and consumption", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-background-turnover-"));
    roots.push(parent);
    const fixedSuffix = `/deep/runtime/${MAX_GENERATED_JOB_ID}/output.log`;
    const root = join(
      parent,
      "x".repeat(
        ARTIFACT_JOB_PATH_MAX_BYTES -
          Buffer.byteLength(parent) -
          Buffer.byteLength(fixedSuffix) -
          1,
      ),
    );
    const artifacts = new ArtifactStore("deep", { root, runtimeId: "runtime" });
    const runtime = new ProcessRuntime("deep", {
      artifacts,
      completedRecordLimit: 1,
      operations: { exec: vi.fn(async () => ({ exitCode: 0 })) },
    });
    await runtime.initialize();
    const delivered: string[] = [];

    for (let index = 1; index <= 105; index += 1) {
      const job = await runtime.launch({
        kind: "background_bash",
        command: `turnover ${index}`,
        cwd: process.cwd(),
      });
      runtime.markLaunchTransferred(job.id);
      while (runtime.get(job.id)?.status === "running")
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(Buffer.byteLength(job.outputPath!)).toBeLessThanOrEqual(ARTIFACT_JOB_PATH_MAX_BYTES);
      if (index % 2 === 0) {
        await runtime.flushCompletionDeliveries((payload) => {
          delivered.push(payload.jobs[0]!.jobId);
        });
      } else {
        expect((await runtime.waitResult([job.id])).jobs[0]?.deliveryState).toBe("consumed");
      }
    }

    expect(runtime.list()).toHaveLength(1);
    expect(runtime.list()[0]?.id).toBe("bg_105");
    expect(delivered).toHaveLength(52);
    await runtime.shutdown();
  });

  it("captures raw stdout and stderr from the first byte", async () => {
    const runtime = await createRuntime();
    const job = await runtime.launch({
      kind: "background_bash",
      command: "printf 'stdout'; printf 'stderr' >&2",
      cwd: process.cwd(),
    });
    for (
      let attempt = 0;
      attempt < 200 && runtime.get(job.id)?.status === "running";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.get(job.id)).toMatchObject({
      status: "completed",
      terminalTail: { content: "stdoutstderr", bytes: 12, lines: 1, truncated: false },
    });
    expect(await readFile(job.outputPath!, "utf8")).toBe("stdoutstderr");
    expect(JSON.parse(await readFile(job.metadataPath!, "utf8"))).not.toHaveProperty(
      "terminalTail",
    );
    await runtime.shutdown();
  });

  it.each(["quit", "reload", "new", "resume", "fork"])(
    "%s extension shutdown kills a real TERM-ignoring process tree with no late message",
    async (reason) => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
      const messages: unknown[] = [];
      backgroundProcessesExtension({
        on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
        registerTool: (tool: { name: string; execute: (...args: never[]) => Promise<unknown> }) =>
          tools.set(tool.name, tool),
        registerCommand: vi.fn(),
        registerMessageRenderer: vi.fn(),
        sendMessage: (message: unknown) => messages.push(message),
      } as never);
      const context = {
        mode: "rpc",
        cwd: process.cwd(),
        hasUI: true,
        isIdle: () => true,
        sessionManager: { getSessionId: () => `lifecycle-${reason}-${Date.now()}` },
        ui: { setStatus: vi.fn(), notify: vi.fn() },
      };
      let shutDown = false;
      try {
        await handlers.get("session_start")!({}, context);
        const command = `sh -c 'trap "" TERM; sh -c '"'"'trap "" TERM; while :; do echo tick; sleep .05; done'"'"' & echo "$$ $!"; wait'`;
        const launched = (await tools
          .get("monitor")!
          .execute(
            "lifecycle" as never,
            { command, description: `lifecycle ${reason}`, persistent: true } as never,
            undefined as never,
            undefined as never,
            context as never,
          )) as {
          details: { jobs: Array<{ outputPath: string; metadataPath: string }> };
        };
        const job = launched.details.jobs[0]!;
        const output = await waitForOutput(job.outputPath);
        const pids = output.trim().split(/\s+/).slice(0, 2).map(Number);
        expect(pids).toHaveLength(2);
        expect(pids.every(isAlive)).toBe(true);

        await handlers.get("session_shutdown")!({ reason }, context);
        shutDown = true;
        await expectProcessesDead(pids);
        const messageCount = messages.length;
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(messages).toHaveLength(messageCount);
        expect(JSON.parse(await readFile(job.metadataPath, "utf8"))).toMatchObject({
          status: "cancelled",
          requestedTerminalCause: "shutdown",
        });
      } finally {
        if (!shutDown) await handlers.get("session_shutdown")?.({ reason }, context);
      }
    },
  );

  it("persists high-volume output completely with bounded model state and no queued buffers", async () => {
    const runtime = await createRuntime();
    const bytes = 4 * 1024 * 1024;
    const job = await runtime.launch({
      kind: "background_bash",
      command: `dd if=/dev/zero bs=65536 count=64 2>/dev/null | tr '\\0' x`,
      cwd: process.cwd(),
    });
    const result = await runtime.waitResult([job.id]);
    const persisted = await readFile(job.outputPath!);
    const terminal = runtime.get(job.id)!;

    expect(persisted).toHaveLength(bytes);
    expect(persisted.every((byte) => byte === 0x78)).toBe(true);
    expect(terminal.outputBytes).toBe(bytes);
    expect(terminal.terminalTail!.bytes).toBeLessThanOrEqual(50 * 1024);
    expect(terminal.terminalTail!.lines).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect((runtime as unknown as { active: Map<string, unknown> }).active.size).toBe(0);
    await runtime.shutdown();
  });

  it("stops a shell child and its grandchild process tree", async () => {
    const runtime = await createRuntime();
    const command = `sh -c 'sleep 300 & echo "$$ $!"; wait'`;
    const job = await runtime.launch({ kind: "background_bash", command, cwd: process.cwd() });
    const output = await waitForOutput(job.outputPath!);
    const pids = output.trim().split(/\s+/).map(Number);
    expect(pids).toHaveLength(2);
    expect(pids.every(isAlive)).toBe(true);

    await runtime.stop(job.id);

    expect(runtime.get(job.id)).toMatchObject({
      status: "cancelled",
      requestedTerminalCause: "stop",
    });
    await expectProcessesDead(pids);
    await runtime.shutdown();
  });
});
