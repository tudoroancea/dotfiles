import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(
  new URL("./fixtures/sdk-rpc-process-model-worker.mjs", import.meta.url),
);

interface ActivitySnapshot {
  handles: Record<string, number>;
  requests: Record<string, number>;
}

interface SdkMeasurement {
  count: number;
  startupMs: number;
  rssBefore: number;
  rssReady: number;
  rssAfterDispose: number;
  processIds: number[];
  loadedPaths: string[][];
  handles: {
    before: ActivitySnapshot;
    ready: ActivitySnapshot;
    afterDispose: ActivitySnapshot;
  };
}

interface RpcMeasurement {
  count: number;
  startupMs: number;
  individualStartupMs: number[];
  ready: boolean[];
  rssBytes: number[];
  rssTotal: number;
  processIds: number[];
  parentPids: number[];
  handles: { before: ActivitySnapshot; ready: ActivitySnapshot };
  childHandleDelta: number;
  stderr: string[];
}

interface WorkerResult {
  sdkVersion: string;
  counts: number[];
  environmentKeys: string[];
  candidateProfile: {
    sdk: { noExtensions: boolean; additionalExtensionPaths: string[] };
    rpc: { noExtensions: boolean; extensionPaths: string[] };
  };
  sdk: SdkMeasurement[];
  rpc: RpcMeasurement[];
  preflight: {
    handledCallbacks: boolean[];
    handledCompletions: number;
    rejectedCallbacks: boolean[];
    rejectedError: string;
    ordering: string[];
  };
  managedCapabilities: {
    bindingMode: string;
    toolNames: string[];
    agentflowStatusCallable: boolean;
    backgroundJobLaunched: boolean;
    backgroundJobStopped: boolean;
  };
  failure: {
    sdk: { runtimeCount: number; exitCode: number; wholeHostExited: boolean };
    rpc: { targetExitCode: number; siblingPid: number; siblingReadyAfterCrash: boolean };
  };
  topology: {
    workerPid: number;
    sdk: string;
    rpc: string;
    finalActivity: ActivitySnapshot;
  };
  stderrBoundBytes: number;
  repositoryExtensionTreeUnchanged: boolean;
  cleaned: boolean;
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
    timeout: 240_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(stderr).toBe("");
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as WorkerResult;
}

function expectPositiveMeasurement(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
}

describe("SDK versus RPC process-model Phase 0D spike", () => {
  it("measures topology and contains injected process failure without credentials", async () => {
    const result = await runWorker();

    expect(result.sdkVersion).toBe("0.86.1");
    expect(result.counts).toEqual([1, 4, 8]);
    expect(result.environmentKeys).toEqual([
      "HERDR_ENV",
      "HOME",
      "LANG",
      "LC_ALL",
      "NoDefaultCurrentDirectoryInExePath",
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

    const expectedExtensions = [
      expect.stringMatching(/agent\/extensions\/agentflow\/src\/index\.ts$/),
      expect.stringMatching(/agent\/extensions\/background-processes\/src\/index\.ts$/),
    ];
    expect(result.candidateProfile.sdk).toEqual({
      noExtensions: true,
      additionalExtensionPaths: expectedExtensions,
    });
    expect(result.candidateProfile.rpc).toEqual({
      noExtensions: true,
      extensionPaths: expectedExtensions,
    });

    expect(result.sdk.map((measurement) => measurement.count)).toEqual([1, 4, 8]);
    for (const measurement of result.sdk) {
      expectPositiveMeasurement(measurement.startupMs);
      expectPositiveMeasurement(measurement.rssBefore);
      expectPositiveMeasurement(measurement.rssReady);
      expectPositiveMeasurement(measurement.rssAfterDispose);
      expect(measurement.processIds).toHaveLength(measurement.count);
      expect(new Set(measurement.processIds)).toEqual(new Set([result.topology.workerPid]));
      expect(measurement.loadedPaths).toHaveLength(measurement.count);
      for (const paths of measurement.loadedPaths) expect(paths).toHaveLength(2);
      expect(measurement.handles.afterDispose.handles.ChildProcess ?? 0).toBe(0);
    }

    expect(result.rpc.map((measurement) => measurement.count)).toEqual([1, 4, 8]);
    for (const measurement of result.rpc) {
      expectPositiveMeasurement(measurement.startupMs);
      expect(measurement.individualStartupMs).toHaveLength(measurement.count);
      measurement.individualStartupMs.forEach(expectPositiveMeasurement);
      expect(measurement.ready).toEqual(Array.from({ length: measurement.count }, () => true));
      expect(measurement.rssBytes).toHaveLength(measurement.count);
      measurement.rssBytes.forEach(expectPositiveMeasurement);
      expectPositiveMeasurement(measurement.rssTotal);
      expect(new Set(measurement.processIds).size).toBe(measurement.count);
      expect(measurement.processIds).not.toContain(result.topology.workerPid);
      expect(measurement.parentPids).toEqual(
        Array.from({ length: measurement.count }, () => result.topology.workerPid),
      );
      expect(Number.isInteger(measurement.childHandleDelta)).toBe(true);
      expect(measurement.handles.ready.handles.ChildProcess).toBeGreaterThan(0);
      expect(measurement.stderr.every((text) => text.length <= result.stderrBoundBytes)).toBe(true);
    }

    expect(result.preflight.handledCallbacks).toEqual([true]);
    expect(result.preflight.handledCompletions).toBe(1);
    expect(result.preflight.rejectedCallbacks).toEqual([false]);
    expect(result.preflight.rejectedError.length).toBeGreaterThan(0);
    expect(result.preflight.ordering).toEqual([
      "handler-start",
      "handler-end",
      "preflight:true",
      "prompt-resolved",
    ]);

    expect(result.managedCapabilities).toEqual({
      bindingMode: "rpc",
      toolNames: ["agentflow_status", "background_run", "background_status", "background_stop"],
      agentflowStatusCallable: true,
      backgroundJobLaunched: true,
      backgroundJobStopped: true,
    });

    expect(result.failure).toEqual({
      sdk: { runtimeCount: 2, exitCode: 42, wholeHostExited: true },
      rpc: {
        targetExitCode: 42,
        siblingPid: expect.any(Number),
        siblingReadyAfterCrash: true,
      },
    });
    expectPositiveMeasurement(result.failure.rpc.siblingPid);
    expect(result.topology.sdk).toBe("one-process-many-runtimes");
    expect(result.topology.rpc).toBe("one-child-process-per-runtime");
    expect(result.topology.finalActivity.handles.ChildProcess ?? 0).toBe(0);
    expect(result.repositoryExtensionTreeUnchanged).toBe(true);
    expect(result.cleaned).toBe(true);
  }, 250_000);
});
