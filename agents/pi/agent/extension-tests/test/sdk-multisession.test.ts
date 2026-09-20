import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(
  new URL("./fixtures/sdk-multisession-worker.mjs", import.meta.url),
);
const processCount = 3;

interface WorkerResult {
  sdk: string;
  settingsKeys: string[];
  rootKind: string;
  environmentKeys: string[];
  isolation: {
    distinct: boolean;
    extensionCount: number;
    providers: string[];
    siblingChecks: string[];
  };
  lifecycle: {
    inPlace: string[];
    replacement: string[];
    sibling: string[];
  };
  reloads: Array<{ index: number; count: number; ids: string[] }>;
  disposedBus: {
    beforeClear: { count: number; ids: string[] };
    afterClear: { count: number; ids: string[] };
  };
  replacement: {
    providerCount: number;
    providerIds: string[];
    siblingProviderCount: number;
  };
  sessionTransitions: {
    steps: Array<{
      label: string;
      providerCount: number;
      providerIds: string[];
      operationResult: { cancelled: boolean; selectedText?: string };
      freshRuntimeObjects: boolean;
      persisted: boolean;
    }>;
    lifecycle: string[];
    uniqueSessionIds: number;
    staleProvidersAfterDispose: number;
    crossedDefaultListenerWarningThreshold: boolean;
    providersAfterBusClear: number;
  };
  rotatingSessionTransitions: {
    steps: Array<{
      label: string;
      providerCount: number;
      providerIds: string[];
      retiredBeforeClear: number;
      retiredAfterClear: number;
      operationResult: { cancelled: boolean; selectedText?: string };
    }>;
    lifecycle: string[];
    staleProvidersAfterDispose: number;
    providersAfterBusClear: number;
  };
  persistedSession: {
    sameSessionId: boolean;
    sameFile: boolean;
    fileInDisposableDirectory: boolean;
    name: string;
    sameName: boolean;
    entryCount: number;
    sameEntryCount: boolean;
    markerType: string;
    markerData: { value: string };
    sameMarker: boolean;
    sameLeaf: boolean;
    idle: boolean;
    pendingMessages: number;
    restoredMessages: number;
    agentStarts: number;
    freshRuntimeObjects: boolean;
  };
  background: {
    initialized: boolean;
    directoryCount: number;
    jobs: number;
    closedRuntimes: number;
    remainingJobArtifacts: number;
  };
  activity: {
    before: { handles: Record<string, number>; requests: Record<string, number> };
    after: { handles: Record<string, number>; requests: Record<string, number> };
  };
  resourceEntries: number;
  extensions: string[];
  extensionErrors: string[];
  disposalErrors: string[];
  cleaned: boolean;
  repositoryUnchanged: boolean;
  resourcesUnchanged: boolean;
}

function credentialFreeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    TMPDIR: "/tmp",
  };
}

async function runWorker(): Promise<WorkerResult> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [workerPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: credentialFreeEnvironment(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  expect(stderr).toBe("");
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as WorkerResult;
}

describe("Pi SDK multi-session integration spike", () => {
  it("cleans reload listeners and isolates whole-host replacement in fresh processes", async () => {
    const runs: WorkerResult[] = [];
    for (let index = 0; index < processCount; index += 1) runs.push(await runWorker());

    expect(runs).toHaveLength(processCount);
    const semanticRuns = runs.map(({ activity: _activity, ...result }) => result);
    expect(semanticRuns.slice(1)).toEqual([semanticRuns[0], semanticRuns[0]]);

    const result = runs[0]!;
    expect(result.sdk).toBe("0.86.1");
    expect(result.settingsKeys).toEqual(["extensions", "packages"]);
    expect(result.rootKind).toBe("short-/tmp");
    expect(result.environmentKeys).toEqual([
      "CLAUDE_CONFIG_DIR",
      "HERDR_ENV",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "PI_CODING_AGENT_DIR",
      "PI_OFFLINE",
      "TMPDIR",
      "TZ",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "npm_config_cache",
    ]);
    expect(result.isolation).toEqual({
      distinct: true,
      extensionCount: result.extensions.length,
      providers: ["agentflow", "background"],
      siblingChecks: ["reload-1", "reload-2", "replacement"],
    });
    expect(result.isolation.extensionCount).toBeGreaterThan(2);
    expect(result.extensions).toContain("<tmp>/a/extensions/agentflow/src/index.ts");
    expect(result.extensions).toContain("<tmp>/a/extensions/background-processes/src/index.ts");

    expect(result.reloads).toEqual([
      { index: 1, count: 2, ids: ["agentflow", "background"] },
      { index: 2, count: 2, ids: ["agentflow", "background"] },
    ]);
    expect(result.lifecycle).toEqual({
      inPlace: [
        "start:startup",
        "stop:reload",
        "start:reload",
        "stop:reload",
        "start:reload",
        "stop:quit",
      ],
      replacement: ["start:startup", "stop:quit"],
      sibling: ["start:startup", "stop:quit"],
    });
    expect(result.disposedBus).toEqual({
      beforeClear: { count: 0, ids: [] },
      afterClear: { count: 0, ids: [] },
    });
    expect(result.replacement).toEqual({
      providerCount: 2,
      providerIds: ["agentflow", "background"],
      siblingProviderCount: 2,
    });
    expect(result.sessionTransitions).toEqual({
      steps: [
        {
          label: "new",
          providerCount: 2,
          providerIds: ["agentflow", "background"],
          operationResult: { cancelled: false },
          freshRuntimeObjects: true,
          persisted: true,
        },
        {
          label: "switch",
          providerCount: 2,
          providerIds: ["agentflow", "background"],
          operationResult: { cancelled: false },
          freshRuntimeObjects: true,
          persisted: true,
        },
        {
          label: "fork",
          providerCount: 2,
          providerIds: ["agentflow", "background"],
          operationResult: {
            cancelled: false,
            selectedText: "second transition fixture request",
          },
          freshRuntimeObjects: true,
          persisted: true,
        },
        {
          label: "clone",
          providerCount: 2,
          providerIds: ["agentflow", "background"],
          operationResult: { cancelled: false },
          freshRuntimeObjects: true,
          persisted: true,
        },
        {
          label: "import",
          providerCount: 2,
          providerIds: ["agentflow", "background"],
          operationResult: { cancelled: false },
          freshRuntimeObjects: true,
          persisted: true,
        },
      ],
      lifecycle: [
        "start:startup",
        "stop:new",
        "start:new",
        "stop:resume",
        "start:resume",
        "stop:fork",
        "start:fork",
        "stop:fork",
        "start:fork",
        "stop:resume",
        "start:resume",
        "stop:quit",
      ],
      uniqueSessionIds: 5,
      staleProvidersAfterDispose: 0,
      crossedDefaultListenerWarningThreshold: false,
      providersAfterBusClear: 0,
    });
    expect(result.rotatingSessionTransitions.steps.map((step) => step.label)).toEqual([
      "new",
      "switch",
      "fork",
      "clone",
      "import",
    ]);
    for (const step of result.rotatingSessionTransitions.steps) {
      expect(step.providerCount).toBe(2);
      expect(step.providerIds).toEqual(["agentflow", "background"]);
      expect(step.retiredBeforeClear).toBe(0);
      expect(step.retiredAfterClear).toBe(0);
      expect(step.operationResult.cancelled).toBe(false);
    }
    expect(result.rotatingSessionTransitions.lifecycle).toEqual([
      "start:startup",
      "stop:new",
      "start:new",
      "stop:resume",
      "start:resume",
      "stop:fork",
      "start:fork",
      "stop:fork",
      "start:fork",
      "stop:resume",
      "start:resume",
      "stop:quit",
    ]);
    expect(result.rotatingSessionTransitions.staleProvidersAfterDispose).toBe(0);
    expect(result.rotatingSessionTransitions.providersAfterBusClear).toBe(0);
    expect(result.persistedSession).toEqual({
      sameSessionId: true,
      sameFile: true,
      fileInDisposableDirectory: true,
      name: "SDK idle reopen spike",
      sameName: true,
      entryCount: 5,
      sameEntryCount: true,
      markerType: "sdk-idle-session-marker",
      markerData: { value: "persisted-without-model-call" },
      sameMarker: true,
      sameLeaf: true,
      idle: true,
      pendingMessages: 0,
      restoredMessages: 2,
      agentStarts: 0,
      freshRuntimeObjects: true,
    });
    expect(result.background.initialized).toBe(true);
    expect(result.background.directoryCount).toBeGreaterThanOrEqual(3);
    expect(result.background.jobs).toBe(0);
    expect(result.background.closedRuntimes).toBe(19);
    expect(result.background.remainingJobArtifacts).toBe(0);
    expect(result.activity.after.handles.ChildProcess ?? 0).toBe(0);
    expect(result.activity.after.requests).toEqual({});
    expect(result.resourceEntries).toBeGreaterThan(200);
    expect(result.extensionErrors).toEqual([]);
    expect(result.disposalErrors).toEqual([]);
    expect(result.cleaned).toBe(true);
    expect(result.repositoryUnchanged).toBe(true);
    expect(result.resourcesUnchanged).toBe(true);
  }, 200_000);
});
