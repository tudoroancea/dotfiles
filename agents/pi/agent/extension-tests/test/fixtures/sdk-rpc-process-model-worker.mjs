import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDirectory, "../../../..");
const packageRoot = resolve(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent");
const candidateExtensions = [
  join(repositoryRoot, "agent/extensions/agentflow/src/index.ts"),
  join(repositoryRoot, "agent/extensions/background-processes/src/index.ts"),
];
const environmentAllowlist = new Set(["LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]);
const childDeadlineMs = 30_000;
const stderrLimit = 64 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const cliEntry = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.pi;
assert(typeof cliEntry === "string", "Pi package does not declare bin.pi");
const cliPath = resolve(packageRoot, cliEntry);
assert(
  !relative(packageRoot, cliPath).startsWith(".."),
  `Pi CLI entry escapes its package: ${cliEntry}`,
);

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function configureEnvironment(root) {
  for (const key of Object.keys(process.env)) {
    if (!environmentAllowlist.has(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    TMPDIR: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    HERDR_ENV: "0",
    npm_config_cache: join(root, "cache/npm"),
    NoDefaultCurrentDirectoryInExePath: "1",
  });
}

async function prepareDirectories(root) {
  await Promise.all(
    [
      process.env.HOME,
      process.env.XDG_CACHE_HOME,
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME,
      process.env.TMPDIR,
      process.env.PI_CODING_AGENT_DIR,
      join(root, "work"),
    ].map((path) => mkdir(path, { recursive: true })),
  );
}

function activitySnapshot() {
  const count = (values) =>
    Object.fromEntries(
      [...values]
        .map((value) => value?.constructor?.name ?? "Unknown")
        .sort()
        .reduce((map, name) => map.set(name, (map.get(name) ?? 0) + 1), new Map()),
    );
  return {
    handles: count(process._getActiveHandles()),
    requests: count(process._getActiveRequests()),
  };
}

async function waitForChildHandleCount(expected) {
  const deadline = Date.now() + 5_000;
  while ((activitySnapshot().handles.ChildProcess ?? 0) !== expected) {
    if (Date.now() >= deadline) return activitySnapshot();
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 25));
  }
  return activitySnapshot();
}

async function extensionTreeSnapshot() {
  const entries = [];
  for (const root of candidateExtensions.map((path) => resolve(path, "../.."))) {
    async function visit(path) {
      const stats = await lstat(path);
      entries.push({
        path: relative(repositoryRoot, path),
        type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        size: stats.size,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
      });
      if (stats.isDirectory()) {
        const children = await readdir(path);
        children.sort();
        for (const child of children) await visit(join(path, child));
      }
    }
    await visit(root);
  }
  return entries;
}

async function createSdkHost(sdk, options = {}) {
  const {
    extraExtensionPaths = [],
    extensionFactories = [],
    bindingMode = "json",
    noTools = "all",
  } = options;
  const {
    ModelRuntime,
    SessionManager,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
  } = sdk;
  const cwd = join(process.env.TMPDIR, "../work");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({
      credentials: {
        async read() {
          return undefined;
        },
        async list() {
          return [];
        },
        async modify(_providerId, update) {
          return update(undefined);
        },
        async delete() {},
      },
      modelsPath: null,
      allowModelNetwork: false,
    });
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [...candidateExtensions, ...extraExtensionPaths],
        extensionFactories,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        noTools,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await runtime.session.bindExtensions({
    mode: bindingMode,
    onError: (error) => {
      throw error;
    },
  });
  const loaded = runtime.services.resourceLoader.getExtensions();
  assert(loaded.errors.length === 0, `SDK extension errors: ${JSON.stringify(loaded.errors)}`);
  return runtime;
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length <= stderrLimit ? next : next.slice(next.length - stderrLimit);
}

function createLineClient(args, label) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: join(process.env.TMPDIR, "../work"),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdoutBuffer = "";
  let stderr = "";
  let nextId = 1;
  const waiters = new Map();
  const lines = [];
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      lines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id && waiters.has(message.id)) {
        const waiter = waiters.get(message.id);
        waiters.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  const exit = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${label} exited (${code ?? signal}); stderr=${stderr}`));
      }
      waiters.clear();
      resolveExit({ code, signal });
    });
  });
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  function request(command, timeoutMs = childDeadlineMs) {
    const id = `${label}-${nextId++}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`${label} request timed out: ${command.type}; stderr=${stderr}`));
      }, timeoutMs);
      waiters.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }
  async function stop() {
    let timer;
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      } else child.kill("SIGTERM");
      timer = setTimeout(() => {
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        } else child.kill("SIGKILL");
      }, 2_000);
    }
    const result = await exit;
    await closed;
    if (timer) clearTimeout(timer);
    return result;
  }
  return {
    child,
    exit,
    lines,
    request,
    startedAt,
    stop,
    get stderr() {
      return stderr;
    },
  };
}

function rpcArgs(extraExtensions = []) {
  const extensions = [...candidateExtensions, ...extraExtensions];
  return [
    cliPath,
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    ...extensions.flatMap((path) => ["--extension", path]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-builtin-tools",
  ];
}

async function readRss(pid) {
  return new Promise((resolveRss, reject) => {
    execFile(
      "/bin/ps",
      ["-o", "rss=", "-p", String(pid)],
      { env: process.env, timeout: 5_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolveRss(Number.parseInt(stdout.trim(), 10) * 1024);
      },
    );
  });
}

async function readParentPid(pid) {
  return new Promise((resolveParent, reject) => {
    execFile(
      "/bin/ps",
      ["-o", "ppid=", "-p", String(pid)],
      { env: process.env, timeout: 5_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolveParent(Number.parseInt(stdout.trim(), 10));
      },
    );
  });
}

async function measureSdk(sdk, count) {
  const handlesBefore = activitySnapshot();
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const hosts = await Promise.all(Array.from({ length: count }, () => createSdkHost(sdk)));
  const readyAt = performance.now();
  const loadedPaths = hosts.map((host) =>
    host.services.resourceLoader
      .getExtensions()
      .extensions.map((extension) => extension.path)
      .sort(),
  );
  for (const paths of loadedPaths) {
    assert(
      JSON.stringify(paths) === JSON.stringify([...candidateExtensions].sort()),
      `non-candidate SDK extension loaded: ${JSON.stringify(paths)}`,
    );
  }
  const rssReady = process.memoryUsage().rss;
  const handlesReady = activitySnapshot();
  await Promise.all(hosts.map((host) => host.dispose()));
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const rssAfterDispose = process.memoryUsage().rss;
  const handlesAfterDispose = activitySnapshot();
  assert(
    (handlesAfterDispose.handles.ChildProcess ?? 0) === 0,
    "SDK disposal left a child-process handle",
  );
  return {
    count,
    startupMs: readyAt - startedAt,
    rssBefore,
    rssReady,
    rssAfterDispose,
    processIds: hosts.map(() => process.pid),
    loadedPaths,
    handles: { before: handlesBefore, ready: handlesReady, afterDispose: handlesAfterDispose },
  };
}

async function measureRpc(count) {
  const clients = [];
  const handlesBefore = activitySnapshot();
  const startedAt = performance.now();
  try {
    for (let index = 0; index < count; index += 1)
      clients.push(createLineClient(rpcArgs(), `rpc-${count}-${index}`));
    const states = await Promise.all(
      clients.map((client) => client.request({ type: "get_state" })),
    );
    const readyAt = performance.now();
    assert(
      states.every((state) => state.success === true && state.command === "get_state"),
      "RPC child was not ready",
    );
    const handlesReady = activitySnapshot();
    const childHandleDelta =
      (handlesReady.handles.ChildProcess ?? 0) - (handlesBefore.handles.ChildProcess ?? 0);
    assert(
      (handlesReady.handles.ChildProcess ?? 0) > 0,
      "RPC children had no active child-process handles",
    );
    const rssBytes = await Promise.all(clients.map((client) => readRss(client.child.pid)));
    const parentPids = await Promise.all(clients.map((client) => readParentPid(client.child.pid)));
    assert(
      parentPids.every((pid) => pid === process.pid),
      `RPC child had unexpected parent: ${parentPids}`,
    );
    return {
      count,
      startupMs: readyAt - startedAt,
      individualStartupMs: clients.map((client) => readyAt - client.startedAt),
      ready: states.map((state) => state.success),
      rssBytes,
      rssTotal: rssBytes.reduce((sum, value) => sum + value, 0),
      processIds: clients.map((client) => client.child.pid),
      parentPids,
      handles: { before: handlesBefore, ready: handlesReady },
      childHandleDelta,
      stderr: clients.map((client) => client.stderr),
    };
  } finally {
    await Promise.all(clients.map((client) => client.stop()));
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  }
}

async function promptPreflight(sdk) {
  const observations = {
    handledCallbacks: [],
    handledCompletions: 0,
    rejectedCallbacks: [],
    rejectedError: "",
    ordering: [],
  };
  const extension = {
    name: "process-model-preflight",
    factory(pi) {
      pi.registerCommand("phase0d-handled", {
        handler: async () => {
          observations.ordering.push("handler-start");
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
          observations.handledCompletions += 1;
          observations.ordering.push("handler-end");
        },
      });
    },
  };
  const runtime = await createSdkHost(sdk, { extensionFactories: [extension] });
  try {
    await runtime.session.prompt("/phase0d-handled", {
      preflightResult(value) {
        observations.handledCallbacks.push(value);
        observations.ordering.push(`preflight:${value}`);
      },
    });
    observations.ordering.push("prompt-resolved");
    try {
      await runtime.session.prompt("ordinary prompt requiring a model", {
        preflightResult(value) {
          observations.rejectedCallbacks.push(value);
        },
      });
    } catch (error) {
      observations.rejectedError = errorText(error);
    }
  } finally {
    await runtime.dispose();
  }
  assert(
    JSON.stringify(observations.handledCallbacks) === "[true]",
    "handled preflight callback was not true exactly once",
  );
  assert(observations.handledCompletions === 1, "handled command completion was not observed once");
  assert(
    JSON.stringify(observations.ordering) ===
      JSON.stringify(["handler-start", "handler-end", "preflight:true", "prompt-resolved"]),
    `handled command admission ordering changed: ${JSON.stringify(observations.ordering)}`,
  );
  assert(
    JSON.stringify(observations.rejectedCallbacks) === "[false]",
    "rejected preflight callback was not false exactly once",
  );
  assert(observations.rejectedError.length > 0, "no-model rejection did not report an error");
  return observations;
}

async function managedProfileCapabilities(sdk) {
  const handlesBefore = activitySnapshot();
  const runtime = await createSdkHost(sdk, { bindingMode: "rpc", noTools: "builtin" });
  const signal = new AbortController().signal;
  try {
    const toolNames = runtime.session.getAllTools().map((tool) => tool.name);
    for (const name of [
      "agentflow_status",
      "background_run",
      "background_status",
      "background_stop",
    ])
      assert(toolNames.includes(name), `managed profile did not register ${name}`);
    const getTool = (name) => {
      const tool = runtime.session.agent.state.tools.find((candidate) => candidate.name === name);
      assert(tool, `managed profile tool ${name} was not active`);
      return tool;
    };
    const agentflowStatus = await getTool("agentflow_status").execute(
      "managed-agentflow-status",
      {},
      signal,
    );
    assert(Array.isArray(agentflowStatus.details?.snapshot), "agentflow status was not callable");
    const launched = await getTool("background_run").execute(
      "managed-background-run",
      { command: "sleep 30", description: "managed SDK capability probe", timeout: 30 },
      signal,
    );
    const jobId = launched.details?.jobs?.[0]?.jobId;
    assert(typeof jobId === "string", "background launch did not return a job ID");
    const stopped = await getTool("background_stop").execute(
      "managed-background-stop",
      { jobIds: [jobId] },
      signal,
    );
    const stoppedJob = stopped.details?.jobs?.find((job) => job.jobId === jobId);
    assert(stoppedJob?.status === "cancelled", "background stop did not cancel the job");
    assert(
      stoppedJob.requestedTerminalCause === "stop",
      "background stop did not record a stop cause",
    );
    const status = await getTool("background_status").execute(
      "managed-background-status",
      { jobId, tailLines: 0 },
      signal,
    );
    const statusJob = status.details?.jobs?.[0];
    assert(statusJob?.jobId === jobId, "background status lost the stopped job");
    assert(statusJob.status === "cancelled", "background status did not retain cancellation");
    assert(statusJob.requestedTerminalCause === "stop", "background status lost stop cause");
    return {
      bindingMode: "rpc",
      toolNames: ["agentflow_status", "background_run", "background_status", "background_stop"],
      agentflowStatusCallable: true,
      backgroundJobLaunched: true,
      backgroundJobStopped: true,
    };
  } finally {
    await runtime.dispose();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    const handlesAfter = activitySnapshot();
    assert(
      (handlesAfter.handles.ChildProcess ?? 0) <= (handlesBefore.handles.ChildProcess ?? 0),
      "managed profile capability probe left a child-process handle",
    );
  }
}

async function failureBlastRadius(root, crashExtension) {
  const sdkClient = createLineClient(
    [fileURLToPath(import.meta.url), "--sdk-crash-host", crashExtension],
    "sdk-crash",
  );
  let sdkReady;
  try {
    sdkReady = await sdkClient.request({ type: "ready" });
    assert(
      sdkReady.success === true && sdkReady.runtimeCount === 2,
      "SDK crash host did not ready two runtimes",
    );
    sdkClient.child.stdin.write(`${JSON.stringify({ type: "crash" })}\n`);
    const sdkExit = await Promise.race([
      sdkClient.exit,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SDK crash host did not exit")), 5_000),
      ),
    ]);
    assert(sdkExit.code === 42, `SDK crash host exit was ${JSON.stringify(sdkExit)}`);

    const target = createLineClient(rpcArgs([crashExtension]), "rpc-crash-target");
    const sibling = createLineClient(rpcArgs([crashExtension]), "rpc-crash-sibling");
    try {
      const ready = await Promise.all([
        target.request({ type: "get_state" }),
        sibling.request({ type: "get_state" }),
      ]);
      assert(
        ready.every((state) => state.success === true),
        "RPC crash pair was not ready",
      );
      target.child.stdin.write(
        `${JSON.stringify({ id: "crash", type: "prompt", message: "/crash" })}\n`,
      );
      const targetExit = await Promise.race([
        target.exit,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RPC target did not crash")), 5_000),
        ),
      ]);
      assert(targetExit.code === 42, `RPC target exit was ${JSON.stringify(targetExit)}`);
      const siblingState = await sibling.request({ type: "get_state" });
      assert(siblingState.success === true, "RPC sibling stopped answering after target crash");
      return {
        sdk: { runtimeCount: sdkReady.runtimeCount, exitCode: sdkExit.code, wholeHostExited: true },
        rpc: {
          targetExitCode: targetExit.code,
          siblingPid: sibling.child.pid,
          siblingReadyAfterCrash: siblingState.success,
        },
      };
    } finally {
      await Promise.all([target.stop(), sibling.stop()]);
    }
  } finally {
    await sdkClient.stop();
    void root;
  }
}

async function runSdkCrashHost(crashExtension) {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const runtimes = await Promise.all([
    createSdkHost(sdk, { extraExtensionPaths: [crashExtension] }),
    createSdkHost(sdk, { extraExtensionPaths: [crashExtension] }),
  ]);
  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.type === "ready") {
        process.stdout.write(
          `${JSON.stringify({ id: message.id, success: true, runtimeCount: runtimes.length })}\n`,
        );
      } else if (message.type === "crash") {
        await runtimes[0].session.prompt("/crash");
      }
    }
  });
}

async function main() {
  const root = await mkdtemp("/tmp/pi-pm-");
  configureEnvironment(root);
  await prepareDirectories(root);
  const expectedEnvironment = [
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
  ].sort();
  assert(
    JSON.stringify(Object.keys(process.env).sort()) === JSON.stringify(expectedEnvironment),
    "environment escaped strict allowlist",
  );
  const treeBefore = await extensionTreeSnapshot();
  const crashExtension = join(root, "crash.ts");
  await writeFile(
    crashExtension,
    `export default function (pi) {\n  pi.registerCommand("crash", { handler: () => process.exit(42) });\n}\n`,
  );
  assert(packageJson.version === "0.86.1", `unexpected SDK version ${packageJson.version}`);
  const sdk = await import("@earendil-works/pi-coding-agent");
  const childrenBefore = activitySnapshot().handles.ChildProcess ?? 0;
  let result;
  try {
    const sdkMeasurements = [];
    const rpcMeasurements = [];
    for (const count of [1, 4, 8]) sdkMeasurements.push(await measureSdk(sdk, count));
    for (const count of [1, 4, 8]) rpcMeasurements.push(await measureRpc(count));
    const preflight = await promptPreflight(sdk);
    const managedCapabilities = await managedProfileCapabilities(sdk);
    const failure = await failureBlastRadius(root, crashExtension);
    const finalActivity = await waitForChildHandleCount(childrenBefore);
    assert(
      (finalActivity.handles.ChildProcess ?? 0) === childrenBefore,
      "orphan child-process handles remain",
    );
    const treeAfter = await extensionTreeSnapshot();
    assert(
      JSON.stringify(treeAfter) === JSON.stringify(treeBefore),
      "repository-owned extension tree was mutated",
    );
    result = {
      sdkVersion: packageJson.version,
      counts: [1, 4, 8],
      environmentKeys: Object.keys(process.env).sort(),
      candidateProfile: {
        sdk: { noExtensions: true, additionalExtensionPaths: candidateExtensions },
        rpc: { noExtensions: true, extensionPaths: candidateExtensions },
      },
      sdk: sdkMeasurements,
      rpc: rpcMeasurements,
      preflight,
      managedCapabilities,
      failure,
      topology: {
        workerPid: process.pid,
        sdk: "one-process-many-runtimes",
        rpc: "one-child-process-per-runtime",
        finalActivity,
      },
      stderrBoundBytes: stderrLimit,
      repositoryExtensionTreeUnchanged: true,
      cleaned: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  try {
    await lstat(root);
    throw new Error("disposable root remains");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  result.cleaned = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[2] === "--sdk-crash-host") await runSdkCrashHost(process.argv[3]);
else await main();
