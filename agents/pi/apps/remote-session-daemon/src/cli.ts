#!/usr/bin/env node
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDaemonConfig } from "./config/load.ts";
import { isPathWithinRoot } from "./config/roots.ts";
import { MANAGED_EXTENSION_PATHS } from "./config/schema.ts";
import { createSdkSessionHost } from "./host/sdk-host.ts";
import { startRemoteSessionDaemon, type RemoteSessionDaemon } from "./index.ts";

export interface CompositionOptions {
  repositoryRoot?: string;
}

async function findRepositoryRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  const filesystemRoot = parse(candidate).root;
  while (true) {
    const profileExists = await Promise.all(
      MANAGED_EXTENSION_PATHS.map((path) =>
        access(resolve(candidate, path)).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (profileExists.every(Boolean)) return candidate;
    if (candidate === filesystemRoot)
      throw new Error("Unable to locate the repository-owned managed extension profile");
    candidate = dirname(candidate);
  }
}

export async function startConfiguredDaemon(
  configPath: string,
  options: CompositionOptions = {},
): Promise<RemoteSessionDaemon> {
  const config = await loadDaemonConfig(resolve(configPath));
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const repositoryRoot = options.repositoryRoot
    ? resolve(options.repositoryRoot)
    : await findRepositoryRoot(sourceRoot);
  const agentDir = resolve(repositoryRoot, "agent");
  const sessionsRoot = resolve(config.persistencePath);
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  const trustedProjects = new Set<string>();
  for (const path of config.trustedProjects) {
    const canonical = await realpath(path).catch(() => {
      throw new Error(`Trusted project is unavailable: ${path}`);
    });
    if (!(await stat(canonical)).isDirectory())
      throw new Error(`Trusted project is not a directory: ${path}`);
    const insideApprovedRoot = await Promise.all(
      config.approvedRoots.map(async (root) =>
        isPathWithinRoot(await realpath(root.path), canonical),
      ),
    );
    if (!insideApprovedRoot.some(Boolean))
      throw new Error(`Trusted project is outside every approved root: ${path}`);
    trustedProjects.add(canonical);
  }
  return startRemoteSessionDaemon({
    config,
    priorTrust: {
      isTrusted: ({ canonicalCwd }) => trustedProjects.has(canonicalCwd),
    },
    hostFactory: async (input) => {
      const sessionDirectory = resolve(sessionsRoot, input.launchId);
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      const sessionFile = input.resumeTarget?.sessionFile;
      if (sessionFile && !isPathWithinRoot(sessionDirectory, sessionFile))
        throw new Error("Confirmed resume identity is outside its daemon-owned session directory");
      return createSdkSessionHost({
        launchId: input.launchId,
        hostEpoch: input.hostEpoch,
        cwd: input.cwd,
        repositoryRoot,
        agentDir,
        sessionDirectory,
        ...(sessionFile ? { sessionFile } : {}),
      });
    },
  });
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3)
    throw new Error("usage: remote-session-daemon <absolute-or-relative-config.json>");
  let daemon: RemoteSessionDaemon | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= daemon?.stop() ?? Promise.resolve();
    return stopping;
  };
  const onSignal = () => void stop().then(() => process.exit(0), reportFatal);
  const reportFatal = (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    daemon = await startConfiguredDaemon(configPath);
    process.stdout.write(
      `remote-session-daemon listening on ${daemon.api.host}:${daemon.api.port}\n`,
    );
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
