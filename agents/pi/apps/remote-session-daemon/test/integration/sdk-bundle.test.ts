import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MANAGED_EXTENSION_PATHS } from "../../src/config/schema.ts";
import {
  createSdkBundle,
  inspectSessionFile,
  type SdkBundleHandle,
} from "../../src/host/sdk-bundle.ts";
import { SDK_PROJECTION_LIMITS } from "../../src/observability/sdk-projection-bounds.ts";
import { SdkSessionHost } from "../../src/host/sdk-host.ts";

const temporaryRoots: string[] = [];
const repositoryRoot = (() => {
  const cwd = resolve(process.cwd());
  const index = cwd.indexOf("/.workrtees/");
  return index < 0 ? resolve(cwd, "../..") : cwd.slice(0, index);
})();
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "remote-sdk-"));
  temporaryRoots.push(root);
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  return { root, cwd, agentDir };
}

describe("SDK host bundle", () => {
  it("creates complete independent exact-profile rpc bundles and disposes siblings independently", async () => {
    const a = await fixture();
    const b = await fixture();
    const [first, sibling] = await Promise.all([
      createSdkBundle({ cwd: a.cwd, agentDir: a.agentDir, repositoryRoot, noTools: true }),
      createSdkBundle({ cwd: b.cwd, agentDir: b.agentDir, repositoryRoot, noTools: true }),
    ]);
    try {
      const one = first.snapshot();
      const two = sibling.snapshot();
      expect(one.loadedExtensionPaths).toEqual(
        MANAGED_EXTENSION_PATHS.map((path) => resolve(repositoryRoot, path)).sort(),
      );
      expect(two.loadedExtensionPaths).toEqual(one.loadedExtensionPaths);
      expect(one.diagnostics).toEqual([]);
      expect(two.diagnostics).toEqual([]);
      for (const identity of one.objectIdentities)
        expect(two.objectIdentities).not.toContain(identity);
      const siblingBefore = sibling.snapshot();
      expect(first.dispose()).toBe(first.dispose());
      await first.dispose();
      expect(sibling.snapshot()).toEqual(siblingBefore);
    } finally {
      await Promise.allSettled([first.dispose(), sibling.dispose()]);
    }
  }, 30_000);

  it("fails closed on unsafe or drifting extension command surfaces", async () => {
    const value = await fixture();
    const bundle = await createSdkBundle({
      cwd: value.cwd,
      agentDir: value.agentDir,
      repositoryRoot,
      noTools: true,
    });
    try {
      expect(bundle.commands()).toEqual([]);
      const preflight: boolean[] = [];
      await expect(
        bundle.prompt("/agentflow", "prompt", (accepted) => preflight.push(accepted)),
      ).rejects.toThrow(/not supported/);
      expect(preflight).toEqual([false]);
    } finally {
      await bundle.dispose();
    }

    const previous = process.env.PI_AGENTFLOW_CONFIG_SMOKE;
    process.env.PI_AGENTFLOW_CONFIG_SMOKE = "1";
    try {
      await expect(
        createSdkBundle({
          cwd: value.cwd,
          agentDir: value.agentDir,
          repositoryRoot,
          noTools: true,
        }),
      ).rejects.toThrow(/command profile drift/);
    } finally {
      if (previous === undefined) delete process.env.PI_AGENTFLOW_CONFIG_SMOKE;
      else process.env.PI_AGENTFLOW_CONFIG_SMOKE = previous;
    }
  }, 30_000);

  it("reopens confirmed persisted identity idle without agent_start or prompt replay", async () => {
    const value = await fixture();
    const sessionDirectory = join(value.root, "sessions");
    await mkdir(sessionDirectory);
    const manager = SessionManager.create(value.cwd, sessionDirectory);
    manager.appendMessage({ role: "user", content: "fixture request", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "settled fixture" }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    manager.appendCustomEntry("daemon-fixture", { confirmed: true });
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeTypeOf("string");
    const first = await createSdkBundle({
      cwd: value.cwd,
      agentDir: value.agentDir,
      repositoryRoot,
      sessionFile: sessionFile!,
      noTools: true,
    });
    const before = first.snapshot();
    const beforeEntries = structuredClone(first.entries());
    await first.dispose();
    const reopened = await createSdkBundle({
      cwd: value.cwd,
      agentDir: value.agentDir,
      repositoryRoot,
      sessionFile: sessionFile!,
      noTools: true,
    });
    try {
      const after = reopened.snapshot();
      expect(after.identity).toEqual(before.identity);
      expect(after.idle).toBe(true);
      expect(after.pendingMessages).toBe(0);
      expect(after.agentStarts).toBe(0);
      expect(after.model).toEqual(before.model);
      expect(after.thinkingLevel).toBe(before.thinkingLevel);
      for (const identity of before.objectIdentities)
        expect(after.objectIdentities).not.toContain(identity);
      expect(reopened.entries()).toEqual(beforeEntries);
      expect(JSON.stringify(reopened.entries()).match(/fixture request/g)).toHaveLength(1);
    } finally {
      await reopened.dispose();
    }
  }, 30_000);

  it("rejects unsafe resume files with bounded pre-open inspection", async () => {
    const value = await fixture();
    const regular = join(value.root, "regular.jsonl");
    await writeFile(regular, '{"type":"session"}\n');
    await expect(inspectSessionFile(regular)).resolves.toMatchObject({ size: 19 });
    const link = join(value.root, "link.jsonl");
    await symlink(regular, link);
    await expect(inspectSessionFile(link)).rejects.toThrow(/no-follow/);
    await expect(inspectSessionFile(value.cwd)).rejects.toThrow(/regular file/);

    const oversized = join(value.root, "oversized.jsonl");
    await writeFile(oversized, "");
    await truncate(oversized, SDK_PROJECTION_LIMITS.sessionBytes + 1);
    await expect(inspectSessionFile(oversized)).rejects.toThrow(/byte limit/);

    const longLine = join(value.root, "long-line.jsonl");
    await writeFile(longLine, "x".repeat(SDK_PROJECTION_LIMITS.sessionLineBytes + 1));
    await expect(inspectSessionFile(longLine)).rejects.toThrow(/oversized JSONL line/);

    const entries = join(value.root, "entries.jsonl");
    await writeFile(entries, "{}\n".repeat(SDK_PROJECTION_LIMITS.sessionEntries + 2));
    await expect(inspectSessionFile(entries)).rejects.toThrow(/entry limit/);
  });

  it("retains a swapped-out bundle when retirement fails and retries every owned bundle on disposal", async () => {
    const identity = (id: string) => ({
      identity: { sessionId: id, sessionFile: `/sessions/${id}.jsonl` },
      idle: true,
      pendingMessages: 0,
      queueBytes: 0,
      model: null,
      thinkingLevel: "off" as const,
      loadedExtensionPaths: [],
      diagnostics: [],
      agentStarts: 0,
      objectIdentities: [],
    });
    let oldDisposals = 0;
    let candidateDisposals = 0;
    const bundle = (id: string, dispose: () => Promise<void>): SdkBundleHandle => ({
      snapshot: () => identity(id),
      projectionRead: () => ({ entries: [], totalEntries: 0, startIndex: 0, queue: [] }),
      subscribe: () => () => {},
      commands: () => [],
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      setModel: async () => false,
      setThinking: (level) => level,
      compact: async () => {},
      entries: () => [],
      dispose,
    });
    const old = bundle("old", async () => {
      oldDisposals += 1;
      if (oldDisposals === 1) throw new Error("old retirement failed");
    });
    const candidate = bundle("candidate", async () => {
      candidateDisposals += 1;
    });
    let call = 0;
    const host = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot,
      bundleFactory: async () => (call++ === 0 ? old : candidate),
    });
    await expect(host.transition({ type: "replace" })).resolves.toMatchObject({
      status: "failed",
      identity: identity("candidate").identity,
      message: "old retirement failed",
    });
    expect(host.state.identity).toEqual(identity("candidate").identity);
    await host.dispose();
    expect(oldDisposals).toBe(2);
    expect(candidateDisposals).toBe(1);
  });

  it("cleans partial replacement creation and keeps disposal idempotent", async () => {
    const value = await fixture();
    const real = await createSdkBundle({
      cwd: value.cwd,
      agentDir: value.agentDir,
      repositoryRoot,
      noTools: true,
    });
    let calls = 0;
    let bundleDisposals = 0;
    const originalDispose = real.dispose;
    real.dispose = () => {
      bundleDisposals += 1;
      return originalDispose();
    };
    const host = await SdkSessionHost.create({
      launchId: "launch",
      cwd: value.cwd,
      agentDir: value.agentDir,
      repositoryRoot,
      noTools: true,
      bundleFactory: async () => {
        calls += 1;
        if (calls > 1) throw new Error("injected partial creation failure");
        return real;
      },
    });
    const result = await host.transition({
      type: "replace",
      sessionFile: "/definitely/missing.jsonl",
    });
    expect(result).toMatchObject({
      status: "failed",
      message: "injected partial creation failure",
    });
    const disposal = host.dispose();
    expect(host.dispose()).toBe(disposal);
    await disposal;
    expect(bundleDisposals).toBe(1);
  }, 30_000);
});
