import { constants } from "node:fs";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import {
  LIMITS,
  type ImageAttachmentCapability,
  type ModelControlCapability,
} from "@dotfiles/pi-web-ui-client/wire";
import { MANAGED_EXTENSION_PATHS, SUPPORTED_PI_VERSION } from "../config/schema.ts";
import { SDK_PROJECTION_LIMITS } from "../observability/sdk-projection-bounds.ts";
import type { SessionCommandInfo, SessionIdentity, ThinkingLevel } from "./session-host.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function supportedThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, unknown>>;
}): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

export function modelControlCapability(
  available: readonly {
    provider: string;
    id: string;
    name: string;
  }[],
  current:
    | {
        reasoning?: boolean;
        thinkingLevelMap?: Partial<Record<ThinkingLevel, unknown>>;
      }
    | undefined,
): ModelControlCapability | undefined {
  if (!current) return undefined;
  const models: ModelControlCapability["models"] = [];
  const identities = new Set<string>();
  for (const model of available) {
    if (
      !model.provider ||
      model.provider.length > LIMITS.maxModelProviderChars ||
      !model.id ||
      model.id.length > LIMITS.maxModelIdChars
    )
      continue;
    const name = model.name.slice(0, LIMITS.maxModelNameChars);
    const identity = `${model.provider}\0${model.id}`;
    if (!name || identities.has(identity)) continue;
    identities.add(identity);
    models.push({ provider: model.provider, id: model.id, name });
    if (models.length === LIMITS.maxModelChoices) break;
  }
  const thinkingLevels = [...new Set(supportedThinkingLevels(current))];
  return models.length > 0 && thinkingLevels.length > 0 ? { models, thinkingLevels } : undefined;
}

function imageAttachmentCapability(
  model: { input?: readonly string[] } | undefined,
): ImageAttachmentCapability | undefined {
  if (!model?.input?.includes("image")) return undefined;
  return {
    supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    maxAttachments: LIMITS.maxImagesPerEntry,
    maxBytesPerImage: LIMITS.maxImageBytes,
    maxTotalBytes: LIMITS.maxImageSourceBytesPerEntry,
    maxWidth: LIMITS.maxImageWidth,
    maxHeight: LIMITS.maxImageHeight,
    maxPixels: LIMITS.maxImagePixels,
    maxTotalPixels: LIMITS.maxImagePixels,
  };
}

export interface SdkImage {
  type: "image";
  data: string;
  mimeType: string;
}

const EXPECTED_REGISTERED_COMMANDS = ["agentflow", "background-tasks"] as const;
const BROWSER_SAFE_COMMANDS = new Set<string>();

export interface SdkBundleOptions {
  cwd: string;
  repositoryRoot: string;
  agentDir?: string;
  sessionFile?: string;
  sessionDirectory?: string;
  noTools?: boolean;
}
export interface SdkBundleSnapshot {
  identity: SessionIdentity;
  idle: boolean;
  pendingMessages: number;
  queueBytes: number;
  model: { provider: string; id: string } | null;
  imageAttachments?: ImageAttachmentCapability;
  modelControl?: ModelControlCapability;
  thinkingLevel: ThinkingLevel;
  loadedExtensionPaths: string[];
  diagnostics: string[];
  agentStarts: number;
  objectIdentities: readonly object[];
}
export interface SdkBundleProjectionRead {
  entries: readonly unknown[];
  totalEntries: number;
  startIndex: number;
  queue: readonly { id: string; content: string; delivery: "steer" | "followUp" }[];
  imageAttachments?: ImageAttachmentCapability;
}
export interface SdkBundleHandle {
  snapshot(): SdkBundleSnapshot;
  projectionRead(maxEntries: number): SdkBundleProjectionRead;
  subscribe(listener: (event: unknown) => void): () => void;
  commands(): readonly SessionCommandInfo[];
  prompt(
    text: string,
    behavior: "prompt" | "steer" | "follow_up",
    preflight: (accepted: boolean) => void,
    images?: readonly SdkImage[],
  ): Promise<void>;
  steer(text: string, images?: readonly SdkImage[]): Promise<void>;
  followUp(text: string, images?: readonly SdkImage[]): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, model: string): Promise<boolean>;
  setThinking(level: ThinkingLevel): ThinkingLevel;
  compact(instructions?: string): Promise<void>;
  entries(): readonly unknown[];
  dispose(): Promise<void>;
}

interface SessionFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
function sameSessionFile(a: SessionFileIdentity, b: SessionFileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
export async function inspectSessionFile(path: string): Promise<SessionFileIdentity> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    throw new Error("Resume session must be a no-follow regular file", { cause: error });
  });
  try {
    const initial = await handle.stat();
    const pathname = await lstat(path);
    if (
      !initial.isFile() ||
      !pathname.isFile() ||
      initial.dev !== pathname.dev ||
      initial.ino !== pathname.ino
    )
      throw new Error("Resume session must be a stable no-follow regular file");
    if (initial.size > SDK_PROJECTION_LIMITS.sessionBytes)
      throw new Error("Resume session exceeds the persisted session byte limit");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let lineBytes = 0;
    let lines = 0;
    while (position < initial.size) {
      const length = Math.min(buffer.length, initial.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error("Resume session changed while being inspected");
      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) {
          lines += 1;
          lineBytes = 0;
          if (lines > SDK_PROJECTION_LIMITS.sessionEntries + 1)
            throw new Error("Resume session exceeds the persisted entry limit");
        } else {
          lineBytes += 1;
          if (lineBytes > SDK_PROJECTION_LIMITS.sessionLineBytes)
            throw new Error("Resume session contains an oversized JSONL line");
        }
      }
    }
    if (lineBytes > 0) lines += 1;
    if (lines > SDK_PROJECTION_LIMITS.sessionEntries + 1)
      throw new Error("Resume session exceeds the persisted entry limit");
    const final = await handle.stat();
    const identity = {
      dev: initial.dev,
      ino: initial.ino,
      size: initial.size,
      mtimeMs: initial.mtimeMs,
      ctimeMs: initial.ctimeMs,
    };
    if (
      !sameSessionFile(identity, {
        dev: final.dev,
        ino: final.ino,
        size: final.size,
        mtimeMs: final.mtimeMs,
        ctimeMs: final.ctimeMs,
      })
    )
      throw new Error("Resume session changed while being inspected");
    return identity;
  } finally {
    await handle.close();
  }
}
async function assertStableSessionFile(path: string, expected: SessionFileIdentity): Promise<void> {
  const actual = await inspectSessionFile(path);
  if (!sameSessionFile(actual, expected))
    throw new Error("Resume session identity changed during SDK load");
}

async function assertSdkVersion(): Promise<void> {
  const entryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const packagePath = resolve(dirname(entryPath), "../package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string };
  if (manifest.version !== SUPPORTED_PI_VERSION)
    throw new Error(
      `Unsupported Pi SDK ${String(manifest.version)}; expected ${SUPPORTED_PI_VERSION}`,
    );
}

export async function createSdkBundle(options: SdkBundleOptions): Promise<SdkBundleHandle> {
  await assertSdkVersion();
  const repositoryRoot = resolve(options.repositoryRoot);
  const expectedPaths = MANAGED_EXTENSION_PATHS.map((path) => resolve(repositoryRoot, path));
  const agentDir = resolve(options.agentDir ?? resolve(repositoryRoot, "agent"));
  const eventBus = createEventBus();
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  let disposed: Promise<void> | undefined;
  let lifecycleUnsubscribe: (() => void) | undefined;
  let agentStarts = 0;
  const extensionErrors: string[] = [];
  try {
    const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [] });
    const modelRuntime = await ModelRuntime.create({
      authPath: resolve(agentDir, "auth.json"),
      modelsPath: resolve(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const sessionFile = options.sessionFile ? resolve(options.sessionFile) : undefined;
    const sessionFileIdentity = sessionFile ? await inspectSessionFile(sessionFile) : undefined;
    const manager = sessionFile
      ? SessionManager.open(sessionFile)
      : options.sessionDirectory
        ? SessionManager.create(resolve(options.cwd), resolve(options.sessionDirectory))
        : SessionManager.inMemory(resolve(options.cwd));
    if (!sessionFile && options.sessionDirectory) {
      const createdFile = manager.getSessionFile();
      const header = manager.getHeader();
      if (!createdFile || !header) throw new Error("Persistent SDK session has no identity");
      await writeFile(createdFile, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
    }
    if (sessionFile && sessionFileIdentity)
      await assertStableSessionFile(sessionFile, sessionFileIdentity);
    if (manager.getEntries().length > SDK_PROJECTION_LIMITS.sessionEntries)
      throw new Error("Reopened session exceeds the post-open entry limit");
    const createRuntime = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }: Parameters<Parameters<typeof createAgentSessionRuntime>[0]>[0]) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          eventBus,
          noExtensions: true,
          additionalExtensionPaths: expectedPaths,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        noTools: options.noTools ? "all" : undefined,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const createdRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd: resolve(options.cwd),
      agentDir,
      sessionManager: manager,
      sessionStartEvent: sessionFile
        ? {
            type: "session_start",
            reason: "resume",
            previousSessionFile: sessionFile,
          }
        : undefined,
    });
    runtime = createdRuntime;
    lifecycleUnsubscribe = createdRuntime.session.subscribe((event) => {
      if (event.type === "agent_start") agentStarts += 1;
    });
    const bind = (session: typeof createdRuntime.session) =>
      session.bindExtensions({
        mode: "rpc",
        onError(error) {
          extensionErrors.push(error instanceof Error ? error.message : String(error));
        },
      });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    const registeredCommands = runtime.session.extensionRunner
      .getRegisteredCommands()
      .map((command) => command.invocationName)
      .sort();
    const expectedCommands = [...EXPECTED_REGISTERED_COMMANDS].sort();
    if (JSON.stringify(registeredCommands) !== JSON.stringify(expectedCommands))
      throw new Error(`Managed command profile drift: ${JSON.stringify(registeredCommands)}`);

    const loaded = runtime.services.resourceLoader.getExtensions();
    const loadedPaths = loaded.extensions.map((extension) => resolve(extension.path)).sort();
    if (loaded.errors.length > 0)
      throw new Error(
        `Extension load failed: ${loaded.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
      );
    const expectedSorted = [...expectedPaths].sort();
    if (JSON.stringify(loadedPaths) !== JSON.stringify(expectedSorted))
      throw new Error(`Managed extension profile drift: ${JSON.stringify(loadedPaths)}`);
    const diagnostics = runtime.diagnostics.map(
      (diagnostic) => `${diagnostic.type}: ${diagnostic.message}`,
    );
    if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error"))
      throw new Error(`SDK diagnostics failed: ${diagnostics.join("; ")}`);
    if (extensionErrors.length > 0)
      throw new Error(`Extension binding failed: ${extensionErrors.join("; ")}`);
    if (sessionFile && resolve(runtime.session.sessionFile ?? "") !== sessionFile)
      throw new Error("Reopened session file identity did not match the confirmed file");
    if (runtime.session.sessionManager.getEntries().length > SDK_PROJECTION_LIMITS.sessionEntries)
      throw new Error("Reopened session exceeds the readiness entry limit");
    if (!runtime.session.sessionId) throw new Error("SDK session has no confirmed identity");

    const activeRuntime = runtime;
    return {
      snapshot() {
        const currentLoaded = activeRuntime.services.resourceLoader.getExtensions();
        const queued = [
          ...activeRuntime.session.getSteeringMessages(),
          ...activeRuntime.session.getFollowUpMessages(),
        ];
        return {
          identity: {
            sessionId: activeRuntime.session.sessionId,
            sessionFile: activeRuntime.session.sessionFile ?? null,
          },
          idle: activeRuntime.session.isIdle,
          pendingMessages: activeRuntime.session.pendingMessageCount,
          queueBytes: queued.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0),
          model: activeRuntime.session.model
            ? {
                provider: activeRuntime.session.model.provider,
                id: activeRuntime.session.model.id,
              }
            : null,
          imageAttachments: imageAttachmentCapability(activeRuntime.session.model),
          modelControl: modelControlCapability(
            modelRuntime.getAvailableSnapshot(),
            activeRuntime.session.model,
          ),
          thinkingLevel: activeRuntime.session.thinkingLevel,
          loadedExtensionPaths: currentLoaded.extensions
            .map((extension) => resolve(extension.path))
            .sort(),
          diagnostics: [...diagnostics, ...extensionErrors],
          agentStarts,
          objectIdentities: [
            settingsManager,
            modelRuntime,
            activeRuntime.services,
            activeRuntime.services.resourceLoader,
            eventBus,
            activeRuntime.session,
            activeRuntime.session.extensionRunner,
          ],
        };
      },
      projectionRead(maxEntries) {
        const branch = activeRuntime.session.sessionManager.getBranch();
        const startIndex = Math.max(0, branch.length - maxEntries);
        const steering = activeRuntime.session.getSteeringMessages();
        const followUp = activeRuntime.session.getFollowUpMessages();
        return {
          entries: branch.slice(startIndex),
          totalEntries: branch.length,
          startIndex,
          queue: [
            ...steering.map((content, index) => ({
              id: `steer-${index}`,
              content,
              delivery: "steer" as const,
            })),
            ...followUp.map((content, index) => ({
              id: `follow-up-${index}`,
              content,
              delivery: "followUp" as const,
            })),
          ],
          imageAttachments: imageAttachmentCapability(activeRuntime.session.model),
        };
      },
      subscribe(listener) {
        return activeRuntime.session.subscribe(
          listener as Parameters<typeof activeRuntime.session.subscribe>[0],
        );
      },
      commands() {
        return activeRuntime.session.extensionRunner
          .getRegisteredCommands()
          .filter((command) => BROWSER_SAFE_COMMANDS.has(command.invocationName))
          .slice(0, 256)
          .flatMap((command) => {
            const name = command.invocationName;
            if (!/^[A-Za-z0-9:_-]{1,128}$/.test(name)) return [];
            const description = command.description?.slice(0, 512);
            return [
              {
                name,
                ...(description ? { description } : {}),
                source: "extension" as const,
              },
            ];
          });
      },
      async prompt(text, behavior, preflight, images = []) {
        const commandName = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : undefined;
        if (
          commandName &&
          activeRuntime.session.extensionRunner.getCommand(commandName) &&
          !BROWSER_SAFE_COMMANDS.has(commandName)
        ) {
          preflight(false);
          throw new Error("Managed browser command is not supported");
        }
        await activeRuntime.session.prompt(text, {
          source: "rpc",
          streamingBehavior:
            behavior === "prompt" ? undefined : behavior === "steer" ? "steer" : "followUp",
          ...(images.length > 0 ? { images: [...images] } : {}),
          preflightResult: preflight,
        });
      },
      async steer(text, images = []) {
        await activeRuntime.session.steer(text, images.length > 0 ? [...images] : undefined);
      },
      async followUp(text, images = []) {
        await activeRuntime.session.followUp(text, images.length > 0 ? [...images] : undefined);
      },
      async abort() {
        activeRuntime.session.abortCompaction();
        await activeRuntime.session.abort();
      },
      async setModel(provider, model) {
        const selected = activeRuntime.services.modelRuntime.getModel(provider, model);
        if (!selected) return false;
        await activeRuntime.session.setModel(selected);
        return true;
      },
      setThinking(level) {
        activeRuntime.session.setThinkingLevel(level);
        return activeRuntime.session.thinkingLevel;
      },
      async compact(instructions) {
        await activeRuntime.session.compact(instructions);
      },
      entries() {
        return activeRuntime.session.sessionManager.getEntries();
      },
      dispose() {
        disposed ??= (async () => {
          try {
            lifecycleUnsubscribe?.();
            lifecycleUnsubscribe = undefined;
            await activeRuntime.dispose();
          } finally {
            eventBus.clear();
          }
        })().catch((error: unknown) => {
          disposed = undefined;
          throw error;
        });
        return disposed;
      },
    };
  } catch (error) {
    try {
      lifecycleUnsubscribe?.();
      lifecycleUnsubscribe = undefined;
      await runtime?.dispose();
    } finally {
      eventBus.clear();
    }
    throw error;
  }
}
