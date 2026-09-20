import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

EventEmitter.defaultMaxListeners = 20;

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDirectory, "../../../..");
const realAgentDirectory = join(repositoryRoot, "agent");
const realResourceNames = ["extensions"];
const discoverySettings = ["extensions"];
const forbiddenNames = ["auth.json", "models.json", "models-store.json", "sessions", "credentials"];
const providerDiscoverEvent = "web-ui:provider-discover";
const providerRegisterEvent = "web-ui:provider-register";
const inheritedEnvironmentAllowlist = new Set(["LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function configureEnvironment(root) {
  for (const key of Object.keys(process.env)) {
    if (!inheritedEnvironmentAllowlist.has(key)) delete process.env[key];
  }
  const cache = join(root, "cache");
  const config = join(root, "config");
  const data = join(root, "data");
  const temp = join(root, "tmp");
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";
  process.env.LANG = "C";
  process.env.HOME = join(root, "home");
  process.env.XDG_CACHE_HOME = cache;
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_DATA_HOME = data;
  process.env.CLAUDE_CONFIG_DIR = join(config, "claude");
  process.env.npm_config_cache = join(cache, "npm");
  process.env.TMPDIR = temp;
  process.env.PI_CODING_AGENT_DIR = join(root, "a");
  process.env.PI_OFFLINE = "1";
  process.env.HERDR_ENV = "0";
  process.env.LC_ALL = "C";
  process.env.TZ = "UTC";
  return [process.env.HOME, cache, config, data, temp];
}

function repositoryStatus() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function entryType(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isSocket()) return "socket";
  if (stats.isFIFO()) return "fifo";
  if (stats.isCharacterDevice()) return "character";
  if (stats.isBlockDevice()) return "block";
  return "other";
}

async function metadataSnapshot(roots) {
  const entries = [];
  async function visit(base, path) {
    const stats = await lstat(path, { bigint: true });
    const type = entryType(stats);
    const name = relative(base, path) || ".";
    entries.push({
      path: name,
      type,
      mode: stats.mode.toString(),
      uid: stats.uid.toString(),
      gid: stats.gid.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
      target: type === "symlink" ? await readlink(path) : undefined,
    });
    if (type !== "directory") return;
    const children = await readdir(path);
    children.sort();
    for (const child of children) await visit(base, join(path, child));
  }
  for (const root of roots) await visit(dirname(root), root);
  return entries;
}

async function optionalMetadataSnapshot(path) {
  return (await exists(path)) ? metadataSnapshot([path]) : [];
}

async function directoryCount(path) {
  if (!(await exists(path))) return 0;
  let count = 1;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await directoryCount(join(path, entry.name));
  }
  return count;
}

async function prepareAgentDirectory(root) {
  const agentDir = join(root, "a");
  const cwd = join(root, "w");
  await mkdir(agentDir);
  await mkdir(cwd);

  const sourceSettings = JSON.parse(
    await readFile(join(realAgentDirectory, "settings.json"), "utf8"),
  );
  const settings = {
    ...Object.fromEntries(
      discoverySettings
        .filter((key) => Object.hasOwn(sourceSettings, key))
        .map((key) => [key, sourceSettings[key]]),
    ),
    packages: [],
  };
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

  for (const resource of realResourceNames) {
    await symlink(join(realAgentDirectory, resource), join(agentDir, resource), "dir");
  }
  for (const forbidden of forbiddenNames) {
    assert(
      !(await exists(join(agentDir, forbidden))),
      `copied forbidden agent resource: ${forbidden}`,
    );
  }
  return { agentDir, cwd, settingsKeys: Object.keys(settings).sort() };
}

function normalizeExtensionPath(path, disposableRoot) {
  return path
    .replaceAll(disposableRoot, "<tmp>")
    .replaceAll(repositoryRoot, "<repo>")
    .replaceAll(realAgentDirectory, "<agent>");
}

function activitySnapshot() {
  const countByType = (values) =>
    Object.fromEntries(
      [...values]
        .map((value) => value?.constructor?.name ?? "Unknown")
        .sort()
        .reduce((counts, name) => counts.set(name, (counts.get(name) ?? 0) + 1), new Map()),
    );
  return {
    handles: countByType(process._getActiveHandles()),
    requests: countByType(process._getActiveRequests()),
  };
}

function assertNoActivityGrowth(before, after) {
  for (const category of ["handles", "requests"]) {
    for (const [name, count] of Object.entries(after[category])) {
      assert(
        count <= (before[category][name] ?? 0),
        `active ${category} grew for ${name}: ${before[category][name] ?? 0} -> ${count}`,
      );
    }
  }
  assert((after.handles.ChildProcess ?? 0) === 0, "child process handle remains after disposal");
}

async function assertClosedBackgroundRuntimes(root) {
  if (!(await exists(root))) return { ownerCount: 0, jobArtifacts: 0 };
  let ownerCount = 0;
  let jobArtifacts = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name === "owner.json") {
        ownerCount += 1;
        const owner = JSON.parse(await readFile(child, "utf8"));
        assert(typeof owner.closedAt === "string", `background runtime remains open: ${child}`);
      } else {
        jobArtifacts += 1;
      }
    }
  }
  await visit(root);
  return { ownerCount, jobArtifacts };
}

async function main() {
  const root = await mkdtemp("/tmp/ps-");
  let environmentKeys;
  let statusBefore;
  let realResourceRoots;
  let resourcesBefore;
  try {
    assert(root.startsWith("/tmp/"), `disposable root is not under /tmp: ${root}`);
    assert(root.length < 32, `disposable root is not short: ${root}`);
    await Promise.all(configureEnvironment(root).map((path) => mkdir(path, { recursive: true })));
    environmentKeys = Object.keys(process.env).sort();
    const expectedEnvironmentKeys = [
      ...inheritedEnvironmentAllowlist,
      "CLAUDE_CONFIG_DIR",
      "HERDR_ENV",
      "HOME",
      "PI_CODING_AGENT_DIR",
      "PI_OFFLINE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "npm_config_cache",
    ].sort();
    assert(
      JSON.stringify(environmentKeys) === JSON.stringify(expectedEnvironmentKeys),
      `worker environment is not allowlisted: ${JSON.stringify(environmentKeys)}`,
    );

    statusBefore = repositoryStatus();
    realResourceRoots = realResourceNames.map((name) => join(realAgentDirectory, name));
    resourcesBefore = await metadataSnapshot(realResourceRoots);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(errorText(reason));
  process.on("unhandledRejection", onUnhandled);

  const hosts = new Set();
  const buses = new Set();
  const disposalErrors = [];
  let result;
  try {
    const { agentDir, cwd, settingsKeys } = await prepareAgentDirectory(root);
    const {
      CONFIG_DIR_NAME,
      ModelRuntime,
      SessionManager,
      createAgentSessionFromServices,
      createAgentSessionRuntime,
      createAgentSessionServices,
      createEventBus,
    } = await import("@earendil-works/pi-coding-agent");
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundRoot = join(process.env.HOME, CONFIG_DIR_NAME, "data", "bg");
    const activityBeforeHosts = activitySnapshot();

    async function createHost(name, sessionManager, sessionStartEvent, options = {}) {
      let eventBus;
      let registrations;
      const retiredBindings = [];
      const lifecycle = [];
      const extensionErrors = [];
      let agentStarts = 0;
      const lifecycleExtension = {
        name: `sdk-spike-${name}`,
        factory(pi) {
          pi.on("session_start", (event) => lifecycle.push(`start:${event.reason}`));
          pi.on("session_shutdown", (event) => lifecycle.push(`stop:${event.reason}`));
          pi.on("agent_start", () => {
            agentStarts += 1;
          });
        },
      };
      const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
        if (!eventBus || options.rotateEventBus) {
          if (eventBus) retiredBindings.push({ eventBus, registrations });
          eventBus = createEventBus();
          const nextRegistrations = [];
          registrations = nextRegistrations;
          buses.add(eventBus);
          eventBus.on(providerRegisterEvent, (provider) => nextRegistrations.push(provider));
        }
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
            eventBus,
            extensionFactories: [lifecycleExtension],
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
            noTools: "all",
          })),
          services,
          diagnostics: services.diagnostics,
        };
      };
      const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
      });
      const bindSession = (session) =>
        session.bindExtensions({
          mode: "json",
          onError(error) {
            extensionErrors.push(errorText(error));
          },
        });
      runtime.setRebindSession(bindSession);
      const host = {
        name,
        get eventBus() {
          return eventBus;
        },
        lifecycle,
        extensionErrors,
        get registrations() {
          return registrations;
        },
        retiredBindings,
        runtime,
        get agentStarts() {
          return agentStarts;
        },
      };
      hosts.add(host);
      try {
        await bindSession(runtime.session);
        return host;
      } catch (error) {
        await disposeHost(host);
        eventBus?.clear();
        throw error;
      }
    }

    function discover(host, label) {
      const offset = host.registrations.length;
      host.eventBus.emit(providerDiscoverEvent, { source: label });
      const current = host.registrations.slice(offset);
      return {
        count: current.length,
        ids: current.map((provider) => String(provider?.id)).sort(),
        snapshots: current
          .map((provider) => ({ id: String(provider?.id), snapshot: provider?.getSnapshot?.() }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      };
    }

    function extensionState(host) {
      const loaded = host.runtime.services.resourceLoader.getExtensions();
      return {
        paths: loaded.extensions
          .map((extension) => normalizeExtensionPath(extension.path, root))
          .sort(),
        errors: loaded.errors.map((error) => ({
          path: normalizeExtensionPath(error.path, root),
          error: error.error,
        })),
        diagnostics: host.runtime.diagnostics.map((diagnostic) => diagnostic.message).sort(),
      };
    }

    function modelState(host) {
      const modelRuntime = host.runtime.services.modelRuntime;
      return {
        providers: [...modelRuntime.getProviders()].map((provider) => provider.id).sort(),
        models: [...modelRuntime.getModels()]
          .map((model) => `${model.provider}/${model.id}`)
          .sort(),
      };
    }

    async function siblingSnapshot(host, label) {
      return {
        references: {
          session: host.runtime.session,
          services: host.runtime.services,
          loader: host.runtime.services.resourceLoader,
          runner: host.runtime.session.extensionRunner,
        },
        sessionId: host.runtime.session.sessionId,
        extensions: extensionState(host),
        models: modelState(host),
        providers: discover(host, label),
        storage: {
          background: await metadataSnapshot([
            join(backgroundRoot, host.runtime.session.sessionId),
          ]),
          agentflow: await optionalMetadataSnapshot(join(agentDir, "agentflow")),
        },
      };
    }

    function assertSiblingUnchanged(before, after, label) {
      for (const key of Object.keys(before.references)) {
        assert(
          before.references[key] === after.references[key],
          `sibling ${key} identity changed ${label}`,
        );
      }
      for (const key of ["sessionId", "extensions", "models", "providers", "storage"]) {
        assert(
          JSON.stringify(before[key]) === JSON.stringify(after[key]),
          `sibling ${key} changed ${label}`,
        );
      }
    }

    async function disposeHost(host) {
      if (!hosts.delete(host)) return;
      try {
        await host.runtime.dispose();
      } catch (error) {
        disposalErrors.push(`${host.name}: ${errorText(error)}`);
        host.runtime.session.dispose();
      }
    }

    const [hostA, hostB] = await Promise.all([
      createHost("a", SessionManager.inMemory(cwd)),
      createHost("b", SessionManager.inMemory(cwd)),
    ]);
    const initialServicesDistinct =
      hostA.runtime.services !== hostB.runtime.services &&
      hostA.runtime.services.resourceLoader !== hostB.runtime.services.resourceLoader &&
      hostA.runtime.services.settingsManager !== hostB.runtime.services.settingsManager &&
      hostA.runtime.services.modelRuntime !== hostB.runtime.services.modelRuntime &&
      hostA.eventBus !== hostB.eventBus &&
      hostA.runtime.session !== hostB.runtime.session &&
      hostA.runtime.session.extensionRunner !== hostB.runtime.session.extensionRunner;
    assert(initialServicesDistinct, "concurrent hosts shared SDK runtime state");

    const extensionsA = extensionState(hostA);
    const extensionsB = extensionState(hostB);
    assert(
      extensionsA.errors.length === 0,
      `host a load errors: ${JSON.stringify(extensionsA.errors)}`,
    );
    assert(
      extensionsB.errors.length === 0,
      `host b load errors: ${JSON.stringify(extensionsB.errors)}`,
    );
    assert(
      extensionsA.diagnostics.length === 0,
      `host a diagnostics: ${JSON.stringify(extensionsA.diagnostics)}`,
    );
    assert(
      extensionsB.diagnostics.length === 0,
      `host b diagnostics: ${JSON.stringify(extensionsB.diagnostics)}`,
    );
    assert(extensionsA.paths.length > 2, "current enabled extension configuration was not loaded");
    assert(
      JSON.stringify(extensionsA.paths.filter((path) => !path.startsWith("<inline:"))) ===
        JSON.stringify(extensionsB.paths.filter((path) => !path.startsWith("<inline:"))),
      "hosts loaded different extensions",
    );

    const initialA = discover(hostA, "initial-a");
    const siblingBefore = await siblingSnapshot(hostB, "initial-b");
    assert(
      JSON.stringify(initialA.ids) === JSON.stringify(["agentflow", "background"]),
      `unexpected providers: ${JSON.stringify(initialA.ids)}`,
    );
    assert(
      JSON.stringify(siblingBefore.providers.ids) === JSON.stringify(initialA.ids),
      "provider discovery leaked across hosts",
    );
    const backgroundSnapshot = initialA.snapshots.find(
      (entry) => entry.id === "background",
    )?.snapshot;
    assert(
      Array.isArray(backgroundSnapshot?.jobs) && backgroundSnapshot.jobs.length === 0,
      "background provider did not initialize empty",
    );
    const backgroundDirectories = await directoryCount(backgroundRoot);
    assert(backgroundDirectories >= 3, "background runtime did not initialize under short root");

    const reloads = [];
    for (let index = 1; index <= 2; index += 1) {
      await hostA.runtime.session.reload();
      const discovered = discover(hostA, `reload-${index}`);
      reloads.push({ index, count: discovered.count, ids: discovered.ids });
      const siblingAfterReload = await siblingSnapshot(hostB, `sibling-reload-${index}`);
      assertSiblingUnchanged(siblingBefore, siblingAfterReload, `after reload ${index}`);
    }
    assert(
      JSON.stringify(reloads.map((entry) => entry.count)) === JSON.stringify([2, 2]),
      `reload listener cleanup changed: ${JSON.stringify(reloads)}`,
    );
    assert(
      JSON.stringify(reloads.map((entry) => entry.ids)) ===
        JSON.stringify([
          ["agentflow", "background"],
          ["agentflow", "background"],
        ]),
      `reload provider identities changed: ${JSON.stringify(reloads)}`,
    );

    await disposeHost(hostA);
    const staleAfterDispose = discover(hostA, "after-dispose");
    hostA.eventBus.clear();
    const afterClear = discover(hostA, "after-clear");
    assert(
      staleAfterDispose.count === 0,
      `disposed bus cleanup changed: ${JSON.stringify(staleAfterDispose)}`,
    );
    assert(
      afterClear.count === 0,
      `cleared bus still registered providers: ${JSON.stringify(afterClear)}`,
    );

    const replacement = await createHost("a-replacement", SessionManager.inMemory(cwd));
    assert(
      replacement.eventBus !== hostA.eventBus &&
        replacement.runtime.services.resourceLoader !== hostA.runtime.services.resourceLoader &&
        replacement.runtime.session.extensionRunner !== hostA.runtime.session.extensionRunner,
      "whole-host replacement reused old host resources",
    );
    const replacementDiscovery = discover(replacement, "replacement");
    assert(replacementDiscovery.count === 2, "fresh host retained reload listeners");
    const siblingAfterReplacement = await siblingSnapshot(hostB, "sibling-replacement");
    assertSiblingUnchanged(siblingBefore, siblingAfterReplacement, "after replacement");

    await disposeHost(replacement);
    replacement.eventBus.clear();

    const transitionSessionDirectory = join(root, "transitions");
    await mkdir(transitionSessionDirectory);
    const transitionManager = SessionManager.create(cwd, transitionSessionDirectory);
    const transitionTimestamp = Date.now();
    transitionManager.appendMessage({
      role: "user",
      content: "first transition fixture request",
      timestamp: transitionTimestamp,
    });
    const firstAssistantId = transitionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first settled transition response" }],
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
      timestamp: transitionTimestamp,
    });
    const secondUserId = transitionManager.appendMessage({
      role: "user",
      content: "second transition fixture request",
      timestamp: transitionTimestamp,
    });
    transitionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second settled transition response" }],
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
      timestamp: transitionTimestamp,
    });
    const transitionSourceFile = transitionManager.getSessionFile();
    assert(typeof transitionSourceFile === "string", "transition fixture was not persisted");
    const transitionHost = await createHost("transitions", transitionManager);
    const transitionInitial = discover(transitionHost, "transition-initial");
    assert(transitionInitial.count === 2, "transition host did not start with one provider set");
    const transitionSteps = [];

    async function exerciseTransition(label, operation, expectedRegistrations) {
      const previous = {
        session: transitionHost.runtime.session,
        services: transitionHost.runtime.services,
        loader: transitionHost.runtime.services.resourceLoader,
        runner: transitionHost.runtime.session.extensionRunner,
      };
      const operationResult = await operation();
      const current = {
        session: transitionHost.runtime.session,
        services: transitionHost.runtime.services,
        loader: transitionHost.runtime.services.resourceLoader,
        runner: transitionHost.runtime.session.extensionRunner,
      };
      assert(current.session !== previous.session, `${label} reused the previous session`);
      assert(current.services !== previous.services, `${label} reused the previous services`);
      assert(current.loader !== previous.loader, `${label} reused the previous resource loader`);
      assert(current.runner !== previous.runner, `${label} reused the previous extension runner`);
      const providers = discover(transitionHost, `transition-${label}`);
      assert(
        providers.count === expectedRegistrations,
        `${label} provider ownership changed: ${JSON.stringify(providers)}`,
      );
      const siblingAfter = await siblingSnapshot(hostB, `sibling-transition-${label}`);
      assertSiblingUnchanged(siblingBefore, siblingAfter, `after transition ${label}`);
      transitionSteps.push({
        label,
        providerCount: providers.count,
        providerIds: providers.ids,
        sessionId: transitionHost.runtime.session.sessionId,
        sessionFile: transitionHost.runtime.session.sessionFile,
        operationResult,
        freshRuntimeObjects: Object.keys(previous).every((key) => previous[key] !== current[key]),
      });
      return operationResult;
    }

    await exerciseTransition("new", () => transitionHost.runtime.newSession(), 2);
    await exerciseTransition(
      "switch",
      () => transitionHost.runtime.switchSession(transitionSourceFile),
      2,
    );
    const forkResult = await exerciseTransition(
      "fork",
      () => transitionHost.runtime.fork(secondUserId),
      2,
    );
    assert(
      forkResult.selectedText === "second transition fixture request",
      `fork selected unexpected text: ${JSON.stringify(forkResult)}`,
    );
    await exerciseTransition(
      "clone",
      () => transitionHost.runtime.fork(firstAssistantId, { position: "at" }),
      2,
    );
    const importDirectory = join(root, "import");
    await mkdir(importDirectory);
    const importManager = SessionManager.create(cwd, importDirectory);
    importManager.appendMessage({
      role: "user",
      content: "imported transition fixture",
      timestamp: transitionTimestamp,
    });
    importManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "settled imported response" }],
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
      timestamp: transitionTimestamp,
    });
    importManager.appendCustomEntry("sdk-import-marker", { imported: true });
    const importSource = importManager.getSessionFile();
    assert(typeof importSource === "string", "import fixture was not persisted");
    await exerciseTransition(
      "import",
      () => transitionHost.runtime.importFromJsonl(importSource),
      2,
    );
    assert(
      new Set(transitionSteps.map((step) => step.sessionId)).size === transitionSteps.length,
      "session replacement reused a session ID",
    );
    await disposeHost(transitionHost);
    const transitionLifecycle = [...transitionHost.lifecycle];
    const transitionStaleAfterDispose = discover(transitionHost, "transition-after-dispose");
    assert(
      transitionStaleAfterDispose.count === 0,
      "session replacement did not clean extension-owned event-bus listeners",
    );
    transitionHost.eventBus.clear();
    const transitionAfterClear = discover(transitionHost, "transition-after-clear");
    assert(transitionAfterClear.count === 0, "discarded transition bus did not clear");

    const rotatingHost = await createHost(
      "rotating-transitions",
      SessionManager.open(transitionSourceFile),
      undefined,
      { rotateEventBus: true },
    );
    assert(discover(rotatingHost, "rotating-initial").count === 2, "rotating host was not clean");
    const rotatingSteps = [];

    async function exerciseRotatingTransition(label, operation) {
      const previous = {
        session: rotatingHost.runtime.session,
        services: rotatingHost.runtime.services,
        loader: rotatingHost.runtime.services.resourceLoader,
        runner: rotatingHost.runtime.session.extensionRunner,
        eventBus: rotatingHost.eventBus,
      };
      const retiredCount = rotatingHost.retiredBindings.length;
      const operationResult = await operation();
      assert(
        rotatingHost.retiredBindings.length === retiredCount + 1,
        `${label} did not retire a bus`,
      );
      assert(rotatingHost.eventBus !== previous.eventBus, `${label} reused the event bus`);
      assert(rotatingHost.runtime.session !== previous.session, `${label} reused the session`);
      assert(rotatingHost.runtime.services !== previous.services, `${label} reused services`);
      assert(
        rotatingHost.runtime.services.resourceLoader !== previous.loader,
        `${label} reused the loader`,
      );
      assert(
        rotatingHost.runtime.session.extensionRunner !== previous.runner,
        `${label} reused the runner`,
      );
      const current = discover(rotatingHost, `rotating-${label}`);
      assert(current.count === 2, `${label} current bus contains stale providers`);
      const retired = rotatingHost.retiredBindings.at(-1);
      const retiredOffset = retired.registrations.length;
      retired.eventBus.emit(providerDiscoverEvent, { source: `retired-${label}` });
      const retiredBeforeClear = retired.registrations.length - retiredOffset;
      assert(retiredBeforeClear === 0, `${label} retained listeners on the retired bus`);
      retired.eventBus.clear();
      const clearedOffset = retired.registrations.length;
      retired.eventBus.emit(providerDiscoverEvent, { source: `cleared-${label}` });
      const retiredAfterClear = retired.registrations.length - clearedOffset;
      assert(retiredAfterClear === 0, `${label} retired bus did not clear`);
      const siblingAfter = await siblingSnapshot(hostB, `sibling-rotating-${label}`);
      assertSiblingUnchanged(siblingBefore, siblingAfter, `after rotating transition ${label}`);
      rotatingSteps.push({
        label,
        providerCount: current.count,
        providerIds: current.ids,
        retiredBeforeClear,
        retiredAfterClear,
        operationResult,
      });
      return operationResult;
    }

    await exerciseRotatingTransition("new", () => rotatingHost.runtime.newSession());
    await exerciseRotatingTransition("switch", () =>
      rotatingHost.runtime.switchSession(transitionSourceFile),
    );
    await exerciseRotatingTransition("fork", () => rotatingHost.runtime.fork(secondUserId));
    await exerciseRotatingTransition("clone", () =>
      rotatingHost.runtime.fork(firstAssistantId, { position: "at" }),
    );
    await exerciseRotatingTransition("import", () =>
      rotatingHost.runtime.importFromJsonl(importSource),
    );
    await disposeHost(rotatingHost);
    const rotatingLifecycle = [...rotatingHost.lifecycle];
    const rotatingDisposed = discover(rotatingHost, "rotating-after-dispose");
    assert(rotatingDisposed.count === 0, "rotating current bus cleanup behavior changed");
    rotatingHost.eventBus.clear();
    const rotatingAfterClear = discover(rotatingHost, "rotating-after-clear");
    assert(rotatingAfterClear.count === 0, "rotating current bus did not clear");

    await disposeHost(hostB);
    hostB.eventBus.clear();

    const persistentSessionDirectory = join(root, "s");
    await mkdir(persistentSessionDirectory);
    const persistentManager = SessionManager.create(cwd, persistentSessionDirectory);
    const markerType = "sdk-idle-session-marker";
    const markerData = { value: "persisted-without-model-call" };
    const timestamp = Date.now();
    persistentManager.appendMessage({
      role: "user",
      content: "deterministic persisted fixture",
      timestamp,
    });
    persistentManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "settled fixture response" }],
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
      timestamp,
    });
    persistentManager.appendCustomEntry(markerType, markerData);
    persistentManager.appendSessionInfo("SDK idle reopen spike");
    const persistedFile = persistentManager.getSessionFile();
    assert(typeof persistedFile === "string", "persistent session did not create a file");
    assert(
      dirname(persistedFile) === persistentSessionDirectory,
      `persistent session escaped short directory: ${persistedFile}`,
    );
    assert(await exists(persistedFile), "settled session was not durably flushed by Pi");
    const persistentHost = await createHost("persistent", persistentManager);
    assert(persistentHost.runtime.session.isIdle, "loaded persistent host is not idle");
    assert(
      persistentHost.runtime.session.pendingMessageCount === 0,
      "loaded persistent host has pending messages",
    );
    assert(
      persistentHost.runtime.session.messages.length === 2,
      "loaded persistent host did not restore settled messages",
    );
    const persistedState = {
      sessionId: persistentManager.getSessionId(),
      file: persistedFile,
      name: persistentManager.getSessionName(),
      entryCount: persistentManager.getEntries().length,
      leaf: persistentManager.getLeafId(),
      marker: persistentManager
        .getEntries()
        .find((entry) => entry.type === "custom" && entry.customType === markerType),
      references: {
        sessionManager: persistentManager,
        session: persistentHost.runtime.session,
        services: persistentHost.runtime.services,
        loader: persistentHost.runtime.services.resourceLoader,
        modelRuntime: persistentHost.runtime.services.modelRuntime,
        bus: persistentHost.eventBus,
        runner: persistentHost.runtime.session.extensionRunner,
      },
    };
    assert(persistentHost.agentStarts === 0, "persistent idle host emitted agent_start");
    await disposeHost(persistentHost);
    persistentHost.eventBus.clear();

    const reopenedManager = SessionManager.open(persistedFile);
    const reopenedHost = await createHost("persistent-reopen", reopenedManager, {
      type: "session_start",
      reason: "resume",
      previousSessionFile: persistedFile,
    });
    const reopenedEntries = reopenedManager.getEntries();
    const reopenedMarker = reopenedEntries.find(
      (entry) => entry.type === "custom" && entry.customType === markerType,
    );
    const persistedSession = {
      sameSessionId: reopenedManager.getSessionId() === persistedState.sessionId,
      sameFile: reopenedManager.getSessionFile() === persistedState.file,
      fileInDisposableDirectory:
        dirname(reopenedManager.getSessionFile()) === persistentSessionDirectory,
      name: reopenedManager.getSessionName(),
      sameName: reopenedManager.getSessionName() === persistedState.name,
      entryCount: reopenedEntries.length,
      sameEntryCount: reopenedEntries.length === persistedState.entryCount,
      markerType: reopenedMarker?.customType,
      markerData: reopenedMarker?.data,
      sameMarker:
        JSON.stringify(reopenedMarker?.data) === JSON.stringify(persistedState.marker?.data),
      sameLeaf: reopenedManager.getLeafId() === persistedState.leaf,
      idle: reopenedHost.runtime.session.isIdle,
      pendingMessages: reopenedHost.runtime.session.pendingMessageCount,
      restoredMessages: reopenedHost.runtime.session.messages.length,
      agentStarts: persistentHost.agentStarts + reopenedHost.agentStarts,
      freshRuntimeObjects:
        reopenedManager !== persistedState.references.sessionManager &&
        reopenedHost.runtime.session !== persistedState.references.session &&
        reopenedHost.runtime.services !== persistedState.references.services &&
        reopenedHost.runtime.services.resourceLoader !== persistedState.references.loader &&
        reopenedHost.runtime.services.modelRuntime !== persistedState.references.modelRuntime &&
        reopenedHost.eventBus !== persistedState.references.bus &&
        reopenedHost.runtime.session.extensionRunner !== persistedState.references.runner,
    };
    assert(
      persistedSession.sameSessionId &&
        persistedSession.sameFile &&
        persistedSession.fileInDisposableDirectory &&
        persistedSession.sameName &&
        persistedSession.sameEntryCount &&
        persistedSession.sameMarker &&
        persistedSession.sameLeaf,
      `persistent session state changed: ${JSON.stringify(persistedSession)}`,
    );
    assert(persistedSession.idle, "reopened persistent session is not idle");
    assert(persistedSession.pendingMessages === 0, "reopened session has pending messages");
    assert(persistedSession.restoredMessages === 2, "reopened session context changed");
    assert(persistedSession.agentStarts === 0, "idle persistence spike emitted agent_start");
    assert(persistedSession.freshRuntimeObjects, "reopened host reused runtime objects");
    await disposeHost(reopenedHost);
    reopenedHost.eventBus.clear();

    for (const bus of buses) bus.clear();
    await new Promise((resolve) => setImmediate(resolve));

    const activityAfterHosts = activitySnapshot();
    assertNoActivityGrowth(activityBeforeHosts, activityAfterHosts);
    const closedBackground = await assertClosedBackgroundRuntimes(backgroundRoot);
    assert(closedBackground.ownerCount >= 7, "not all background runtimes were accounted for");
    assert(closedBackground.jobArtifacts === 0, "background job artifacts remain after disposal");
    assert(disposalErrors.length === 0, `host disposal errors: ${JSON.stringify(disposalErrors)}`);
    const extensionErrors = [
      ...hostA.extensionErrors,
      ...hostB.extensionErrors,
      ...replacement.extensionErrors,
      ...transitionHost.extensionErrors,
      ...rotatingHost.extensionErrors,
      ...persistentHost.extensionErrors,
      ...reopenedHost.extensionErrors,
    ];
    assert(extensionErrors.length === 0, `extension errors: ${JSON.stringify(extensionErrors)}`);

    const resourcesAfter = await metadataSnapshot(realResourceRoots);
    assert(
      JSON.stringify(resourcesAfter) === JSON.stringify(resourcesBefore),
      "symlink-exposed real extension/package resources were mutated",
    );
    assert(repositoryStatus() === statusBefore, "worker changed repository status");
    assert(unhandled.length === 0, `unhandled rejections: ${JSON.stringify(unhandled)}`);

    result = {
      sdk: "0.86.1",
      settingsKeys,
      environmentKeys,
      rootKind: "short-/tmp",
      isolation: {
        distinct: initialServicesDistinct,
        extensionCount: extensionsA.paths.length,
        providers: initialA.ids,
        siblingChecks: ["reload-1", "reload-2", "replacement"],
      },
      lifecycle: {
        inPlace: hostA.lifecycle,
        replacement: replacement.lifecycle,
        sibling: hostB.lifecycle,
      },
      reloads,
      disposedBus: {
        beforeClear: { count: staleAfterDispose.count, ids: staleAfterDispose.ids },
        afterClear: { count: afterClear.count, ids: afterClear.ids },
      },
      replacement: {
        providerCount: replacementDiscovery.count,
        providerIds: replacementDiscovery.ids,
        siblingProviderCount: siblingAfterReplacement.providers.count,
      },
      sessionTransitions: {
        steps: transitionSteps.map(({ sessionId: _sessionId, sessionFile, ...step }) => ({
          ...step,
          persisted: typeof sessionFile === "string",
        })),
        lifecycle: transitionLifecycle,
        uniqueSessionIds: new Set(transitionSteps.map((step) => step.sessionId)).size,
        staleProvidersAfterDispose: transitionStaleAfterDispose.count,
        crossedDefaultListenerWarningThreshold: transitionStaleAfterDispose.count > 10,
        providersAfterBusClear: transitionAfterClear.count,
      },
      rotatingSessionTransitions: {
        steps: rotatingSteps,
        lifecycle: rotatingLifecycle,
        staleProvidersAfterDispose: rotatingDisposed.count,
        providersAfterBusClear: rotatingAfterClear.count,
      },
      persistedSession,
      background: {
        initialized: true,
        directoryCount: backgroundDirectories,
        jobs: backgroundSnapshot.jobs.length,
        closedRuntimes: closedBackground.ownerCount,
        remainingJobArtifacts: closedBackground.jobArtifacts,
      },
      activity: { before: activityBeforeHosts, after: activityAfterHosts },
      resourceEntries: resourcesBefore.length,
      extensions: extensionsA.paths,
      extensionErrors,
      disposalErrors,
      cleaned: false,
      repositoryUnchanged: true,
      resourcesUnchanged: true,
    };
  } finally {
    for (const host of hosts) {
      try {
        await host.runtime.dispose();
      } catch (error) {
        disposalErrors.push(`${host.name}: ${errorText(error)}`);
        host.runtime.session.dispose();
      } finally {
        hosts.delete(host);
      }
    }
    for (const bus of buses) bus.clear();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onUnhandled);
    await rm(root, { recursive: true, force: true });
  }

  assert(!(await exists(root)), `disposable root was not removed: ${root}`);
  result.cleaned = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
