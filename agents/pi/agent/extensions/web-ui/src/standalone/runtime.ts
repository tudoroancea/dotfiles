import { access } from "node:fs/promises";
import { join } from "node:path";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { LIMITS } from "@dotfiles/pi-web-ui-client/wire";
import type {
  CommandAcceptance,
  ImageAttachmentCapability,
  ModelControlCommand,
  OutboundCommand,
  QueueMutationCommand,
} from "@dotfiles/pi-web-ui-client/wire";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fallbackFileCompletions, mentionCompletions } from "./completion.js";
import {
  PendingInputBroker,
  replaceBrokerPayloadText,
  type BrokerPayload,
} from "./pending-input-broker.js";
import { modelControlCapability, SessionSnapshotProjection } from "./projection/snapshot.js";
import { startServer, type SnapshotTheme, type WebUiServer } from "./server.js";
import { parseAutomaticTheme, themePalette, themePaletteFromFile } from "./theme.js";
import { startTailscaleServe, type TailscaleServe } from "./tailscale.js";

const BROADCAST_DEBOUNCE_MS = 60;
const PROMPT_ADMISSION_TTL_MS = 30_000;
const MAX_UNSETTLED_COMMANDS = 64;
const MAX_UNSETTLED_IMAGE_COMMANDS = 2;
const MAX_UNSETTLED_IMAGE_BYTES = 2 * LIMITS.maxImageSourceBytesPerEntry;
const MAX_UNSETTLED_IMAGE_PIXELS = 2 * LIMITS.maxImagePixels;
const AUTH_ABORTED = Symbol("auth-aborted");
const REMOTE_SERVE_READY_TIMEOUT_MS = 15_000;

type RemoteServeStart =
  | { status: "ready"; origin: string }
  | { status: "failed"; reason: string }
  | { status: "unsettled" };

interface AdmittedCommand {
  commandEpoch: string;
  imageBytes: number;
  imagePixels: number;
  handedOff: boolean;
}

function modelIdentity(context: ExtensionContext): string {
  return context.model ? `${context.model.provider}\0${context.model.id}` : "";
}

async function waitForProviderAuth<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof AUTH_ABORTED> {
  if (signal.aborted) return AUTH_ABORTED;
  let abort: (() => void) | undefined;
  const aborted = new Promise<typeof AUTH_ABORTED>((resolve) => {
    abort = () => resolve(AUTH_ABORTED);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function imageAttachmentCapability(
  context: ExtensionContext,
): ImageAttachmentCapability | undefined {
  if (!context.model?.input?.includes("image")) return undefined;
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

export interface StandaloneRuntimeDependencies {
  startServer: typeof startServer;
  startTailscaleServe: typeof startTailscaleServe;
}

const defaultDependencies: StandaloneRuntimeDependencies = { startServer, startTailscaleServe };

export class StandaloneSessionRuntime {
  private readonly broker: PendingInputBroker<BrokerPayload>;
  private readonly projection: SessionSnapshotProjection;
  private server: WebUiServer | undefined;
  private tailscaleServe: TailscaleServe | undefined;
  private remoteOrigin: string | undefined;
  private remoteServeStarting: Promise<RemoteServeStart> | undefined;
  private resolveRemoteServeStarting: ((start: RemoteServeStart) => void) | undefined;
  private remoteServeCopyPending = false;
  private broadcastTimer: NodeJS.Timeout | undefined;
  private broadcastMode: "full" | "live" = "full";
  private autocompleteProvider: AutocompleteProvider | undefined;
  private promptAdmission = false;
  private promptAdmissionTimer: NodeJS.Timeout | undefined;
  private readonly admittedCommands = new Map<string, AdmittedCommand>();
  private unsettledImageCommands = 0;
  private unsettledImageBytes = 0;
  private unsettledImagePixels = 0;
  private imageCapabilityKey: string;
  private modelIdentityKey: string;
  private agentFailure: string | undefined;
  private closed = false;
  private starting: Promise<void> | undefined;
  private serverStarting: Promise<WebUiServer | undefined> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    readonly context: ExtensionContext,
    private readonly isCurrent: () => boolean,
    private readonly dependencies: StandaloneRuntimeDependencies = defaultDependencies,
  ) {
    this.broker = new PendingInputBroker<BrokerPayload>({
      replacePayloadText: replaceBrokerPayloadText,
      onChange: () => this.scheduleBroadcast(),
    });
    this.projection = new SessionSnapshotProjection(context, () => this.broker.snapshot(), {
      edit: true,
      remove: true,
    });
    this.imageCapabilityKey = JSON.stringify(imageAttachmentCapability(context));
    this.modelIdentityKey = modelIdentity(context);
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.closed) return Promise.resolve();
    this.starting = this.startInternal();
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    await this.configureTheme();
    if (!this.active()) return;
    await this.configureAutocomplete();
  }

  private ensureServer(): Promise<WebUiServer | undefined> {
    if (this.server) return Promise.resolve(this.server);
    if (!this.active()) return Promise.resolve(undefined);
    if (this.serverStarting) return this.serverStarting;
    const starting = this.startServer();
    this.serverStarting = starting;
    void starting.then(
      () => {
        if (this.serverStarting === starting) this.serverStarting = undefined;
      },
      () => {
        if (this.serverStarting === starting) this.serverStarting = undefined;
      },
    );
    return starting;
  }

  private async startServer(): Promise<WebUiServer | undefined> {
    const server = await this.dependencies.startServer(
      () => {
        const snapshot = this.projection.snapshot();
        const attachments = imageAttachmentCapability(this.context);
        const modelControl = modelControlCapability(this.context);
        return {
          ...snapshot,
          ...(attachments ? { imageAttachments: attachments } : {}),
          ...(modelControl ? { modelControl } : {}),
        };
      },
      {
        submitInput: (command, signal) => this.submitInput(command, signal),
        mutatePendingInput: (command, signal) => this.mutatePendingInput(command, signal),
        modelControl: (command, signal, tryHandoff) =>
          this.modelControl(command, signal, tryHandoff),
        onCommandEpochReset: (reason) => this.onCommandEpochReset(reason),
        getPollKey: () => this.projection.pollKey(),
        getEntries: () => this.projection.entries(),
        getLiveEntries: () => this.projection.liveEntries(),
        completeMention: (query, signal) =>
          this.autocompleteProvider
            ? mentionCompletions(this.autocompleteProvider, query, signal)
            : fallbackFileCompletions(this.context.cwd, query, signal),
      },
    );
    if (!this.active()) {
      await server.close();
      return undefined;
    }
    this.server = server;
    return server;
  }

  async copyUrl(commandContext: ExtensionCommandContext, remote: boolean): Promise<void> {
    if (!this.active()) {
      commandContext.ui.notify("Pi Web UI (simple) is not running in this mode.", "error");
      return;
    }
    let server: WebUiServer | undefined;
    try {
      server = await this.ensureServer();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "server unavailable";
      commandContext.ui.notify(`Could not start Pi Web UI: ${reason}`, "error");
      return;
    }
    if (!server || !this.active()) {
      commandContext.ui.notify("Pi Web UI (simple) is not running in this mode.", "error");
      return;
    }
    if (remote && !this.remoteOrigin) {
      this.remoteServeCopyPending = true;
      const start = await this.waitForRemoteOrigin(server);
      this.remoteServeCopyPending = false;
      if (start.status === "failed") {
        commandContext.ui.notify(`The remote Web UI is unavailable: ${start.reason}`, "error");
        return;
      }
      if (start.status !== "ready" || !this.active() || this.server !== server) {
        commandContext.ui.notify(
          "The remote Web UI is still starting. Try again shortly.",
          "error",
        );
        return;
      }
    }
    const origin = remote ? this.remoteOrigin : undefined;
    const url = server.bootstrapUrl(origin);
    if (commandContext.mode === "rpc") {
      commandContext.ui.notify(url, "info");
      return;
    }
    try {
      await copyToClipboard(url);
      commandContext.ui.notify(
        remote ? "Remote Web UI link copied." : "Local Web UI link copied.",
        "info",
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "clipboard unavailable";
      commandContext.ui.notify(`Could not copy Web UI link: ${reason}`, "error");
    }
  }

  private async waitForRemoteOrigin(server: WebUiServer): Promise<RemoteServeStart> {
    const starting = this.startRemoteServe(server);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<RemoteServeStart>((resolve) => {
      timer = setTimeout(() => resolve({ status: "unsettled" }), REMOTE_SERVE_READY_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([starting, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private settleRemoteServeStarting(start: RemoteServeStart): void {
    const resolve = this.resolveRemoteServeStarting;
    this.resolveRemoteServeStarting = undefined;
    this.remoteServeStarting = undefined;
    resolve?.(start);
  }

  private startRemoteServe(server: WebUiServer): Promise<RemoteServeStart> {
    if (this.remoteServeStarting) return this.remoteServeStarting;
    let resolveStart: (start: RemoteServeStart) => void = () => {};
    const starting = new Promise<RemoteServeStart>((resolve) => {
      resolveStart = resolve;
    });
    this.remoteServeStarting = starting;
    this.resolveRemoteServeStarting = resolveStart;
    const tailscaleServe = this.dependencies.startTailscaleServe(
      server.origin,
      server.port,
      (origin) => {
        if (!this.active() || this.server !== server) {
          this.settleRemoteServeStarting({ status: "unsettled" });
          return;
        }
        this.remoteOrigin = origin;
        const copyPending = this.remoteServeCopyPending;
        this.remoteServeCopyPending = false;
        this.settleRemoteServeStarting({ status: "ready", origin });
        if (copyPending) return;
        if (this.context.mode === "tui") {
          this.context.ui.notify("Remote Web UI ready — use /copy-remote-url.", "info");
        } else {
          process.stderr.write(`Pi Web UI (simple, tailnet): ${origin}\n`);
        }
      },
      (reason) => {
        if (!this.active() || this.server !== server) {
          this.settleRemoteServeStarting({ status: "unsettled" });
          return;
        }
        this.tailscaleServe = undefined;
        this.remoteOrigin = undefined;
        const copyPending = this.remoteServeCopyPending;
        this.remoteServeCopyPending = false;
        this.settleRemoteServeStarting({ status: "failed", reason });
        if (copyPending) return;
        const message = `Remote Web UI unavailable: ${reason}`;
        if (this.context.mode === "tui") this.context.ui.notify(message, "warning");
        else process.stderr.write(`Pi Web UI (simple): ${message}\n`);
      },
    );
    if (!this.active() || this.server !== server) {
      void tailscaleServe.close();
      this.settleRemoteServeStarting({ status: "unsettled" });
      return starting;
    }
    this.tailscaleServe = tailscaleServe;
    return starting;
  }

  onAgentStart(): void {
    this.releasePromptAdmission();
    this.agentFailure = undefined;
    this.scheduleBroadcast();
  }

  async onTurnEnd(): Promise<void> {
    await this.releaseBroker("steer");
  }

  async onAgentEnd(event: unknown): Promise<void> {
    const outcome = agentFailure(event);
    this.agentFailure = outcome?.message;
    if (!outcome?.aborted) await this.releaseBroker("followUp");
  }

  onWorkingWord(data: unknown): void {
    this.projection.live.setWorkingWord(data);
    this.scheduleBroadcast("live");
  }

  onMessageStart(event: unknown): void {
    this.projection.live.messageStart(event);
    this.scheduleBroadcast("live");
  }

  onMessageUpdate(event: unknown): void {
    this.projection.live.messageUpdate(event);
    this.scheduleBroadcast("live");
  }

  onMessageEnd(event: unknown): void {
    this.projection.live.messageEnd(event);
    this.scheduleBroadcast();
  }

  onToolStart(event: unknown): void {
    this.projection.live.toolStart(event);
    this.scheduleBroadcast("live");
  }

  onToolUpdate(event: unknown): void {
    this.projection.live.toolUpdate(event);
    this.scheduleBroadcast("live");
  }

  onToolEnd(event: unknown): void {
    this.projection.live.toolEnd(event);
    this.scheduleBroadcast();
  }

  onModelSelect(): void {
    const nextCapabilityKey = JSON.stringify(imageAttachmentCapability(this.context));
    const nextModelIdentity = modelIdentity(this.context);
    const modelChanged = nextModelIdentity !== this.modelIdentityKey;
    const capabilityChanged = nextCapabilityKey !== this.imageCapabilityKey;
    this.modelIdentityKey = nextModelIdentity;
    this.imageCapabilityKey = nextCapabilityKey;
    if (modelChanged || capabilityChanged) {
      this.settleAdmittedCommands(
        "failed",
        modelChanged ? "Model changed" : "Image capability changed",
      );
      this.broker.reset();
      this.server?.reset(modelChanged ? "model changed" : "image attachment capability changed");
      return;
    }
    this.scheduleBroadcast();
  }

  onAgentSettled(): void {
    this.projection.live.reset();
    this.scheduleBroadcast();
    this.settleAdmittedCommands(
      this.agentFailure ? "failed" : "completed",
      this.agentFailure,
      false,
    );
    this.agentFailure = undefined;
  }

  onSessionTree(): void {
    this.projection.live.reset();
    this.settleAdmittedCommands("failed", "Session branch changed");
    this.broker.reset();
    this.server?.reset("session tree changed");
  }

  onCommandEpochReset(reason: string): void {
    this.settleAdmittedCommands("failed", reason);
    this.broker.reset();
  }

  onSessionCompact(): void {
    this.projection.live.clearLive();
    this.settleAdmittedCommands("failed", "Session compacted");
    this.broker.reset();
    this.server?.reset("session compacted");
  }

  scheduleBroadcast(mode: "full" | "live" = "full"): void {
    if (!this.active() || !this.server) return;
    if (mode === "full") this.broadcastMode = "full";
    else if (!this.broadcastTimer) this.broadcastMode = "live";
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      const nextMode = this.broadcastMode;
      this.broadcastMode = "full";
      if (this.active()) this.server?.broadcast(nextMode);
    }, BROADCAST_DEBOUNCE_MS);
    this.broadcastTimer.unref?.();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.releasePromptAdmission();
    this.settleAdmittedCommands("failed", "Session closed");
    this.broker.reset();
    this.projection.live.reset();
    this.autocompleteProvider = undefined;
    this.remoteOrigin = undefined;
    this.remoteServeCopyPending = false;
    this.settleRemoteServeStarting({ status: "unsettled" });
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = undefined;
    await this.closeResources();
    await Promise.allSettled([this.starting, this.serverStarting]);
    await this.closeResources();
  }

  private async closeResources(): Promise<void> {
    const tailscaleServe = this.tailscaleServe;
    const server = this.server;
    this.tailscaleServe = undefined;
    this.server = undefined;
    await Promise.allSettled([tailscaleServe?.close(), server?.close()]);
  }

  private active(): boolean {
    return !this.closed && this.isCurrent();
  }

  private async configureTheme(): Promise<void> {
    const settings = SettingsManager.create(this.context.cwd, getAgentDir(), {
      projectTrusted: this.context.isProjectTrusted(),
    });
    let automaticTheme = parseAutomaticTheme(settings.getThemeSetting());
    let automaticPalette: SnapshotTheme | undefined;
    if (automaticTheme) {
      const lightTheme = this.context.ui.getTheme(automaticTheme[0]);
      const darkTheme = this.context.ui.getTheme(automaticTheme[1]);
      const light =
        (lightTheme && themePalette(lightTheme, true)) ??
        (await themePaletteFromFile(automaticTheme[0], true));
      if (!this.active()) return;
      const dark =
        (darkTheme && themePalette(darkTheme, false)) ??
        (await themePaletteFromFile(automaticTheme[1], false));
      if (light && dark) automaticPalette = { auto: true, light, dark };
      else automaticTheme = undefined;
    }
    this.projection.setAutomaticTheme(automaticTheme, automaticPalette);
  }

  private async configureAutocomplete(): Promise<void> {
    this.context.ui.addAutocompleteProvider((current) => {
      this.autocompleteProvider = current;
      return current;
    });
    if (this.autocompleteProvider) return;
    const managedFd = join(getAgentDir(), "bin", process.platform === "win32" ? "fd.exe" : "fd");
    let fdPath: string | undefined;
    try {
      await access(managedFd);
      fdPath = managedFd;
    } catch {
      const lookup = await this.pi.exec(process.platform === "win32" ? "where" : "which", ["fd"]);
      if (lookup.code === 0) fdPath = lookup.stdout.trim().split(/\r?\n/)[0];
    }
    if (fdPath && this.active()) {
      this.autocompleteProvider = new CombinedAutocompleteProvider([], this.context.cwd, fdPath);
    }
  }

  private commandIsCurrent(
    command: OutboundCommand | QueueMutationCommand | ModelControlCommand,
    signal?: AbortSignal,
  ): boolean {
    const server = this.server;
    if (
      signal?.aborted ||
      !this.active() ||
      server === undefined ||
      command.generation !== server.generation ||
      command.commandEpoch !== server.commandEpoch
    ) {
      return false;
    }
    if (command.type === "image-command") {
      const current = imageAttachmentCapability(this.context);
      return (
        current !== undefined &&
        JSON.stringify(current) === JSON.stringify(server.imageAttachmentCapability)
      );
    }
    return true;
  }

  private async modelControl(
    command: ModelControlCommand,
    signal: AbortSignal,
    tryHandoff: () => boolean,
  ): Promise<CommandAcceptance> {
    const unavailable = this.modelControlUnavailable(command);
    if (unavailable) return unavailable;

    if (command.type === "set-thinking") {
      if (this.pi.getThinkingLevel() === command.thinkingLevel) return { accepted: true };
      const freshUnavailable = this.modelControlUnavailable(command);
      if (freshUnavailable) return freshUnavailable;
      if (!this.commandIsCurrent(command, signal) || !tryHandoff()) {
        return { accepted: false, error: "Session changed", reason: "session-changed" };
      }
      this.pi.setThinkingLevel(command.thinkingLevel);
      return { accepted: true };
    }
    if (
      this.context.model?.provider === command.provider &&
      this.context.model.id === command.modelId
    ) {
      return { accepted: true };
    }
    const model = this.context.modelRegistry.find(command.provider, command.modelId);
    if (!model) return { accepted: false, error: "Model is unavailable", reason: "invalid" };
    const freshUnavailable = this.modelControlUnavailable(command);
    if (freshUnavailable) return freshUnavailable;
    if (!this.commandIsCurrent(command, signal) || !tryHandoff()) {
      return { accepted: false, error: "Session changed", reason: "session-changed" };
    }
    const changed = await this.pi.setModel(model);
    return changed
      ? { accepted: true }
      : { accepted: false, error: "Model authentication is unavailable", reason: "invalid" };
  }

  private modelControlUnavailable(command: ModelControlCommand): CommandAcceptance | undefined {
    const capability = modelControlCapability(this.context);
    if (!capability) {
      return { accepted: false, error: "Model control is unavailable", reason: "capability-off" };
    }
    const available =
      command.type === "set-thinking"
        ? capability.thinkingLevels.includes(command.thinkingLevel)
        : capability.models.some(
            (model) => model.provider === command.provider && model.id === command.modelId,
          );
    if (available) return undefined;
    return {
      accepted: false,
      error:
        command.type === "set-thinking" ? "Thinking level is unavailable" : "Model is unavailable",
      reason: "invalid",
    };
  }

  private async submitInput(
    command: OutboundCommand,
    signal: AbortSignal,
  ): Promise<CommandAcceptance> {
    if (!this.commandIsCurrent(command, signal)) {
      return { accepted: false, error: "Session changed" };
    }
    if (this.admittedCommands.size >= MAX_UNSETTLED_COMMANDS) {
      return { accepted: false, error: "Too many commands are awaiting run settlement" };
    }
    const imageBudget =
      command.type === "image-command"
        ? {
            imageBytes: command.attachments.reduce((sum, item) => sum + item.byteLength, 0),
            imagePixels: command.attachments.reduce(
              (sum, item) => sum + item.width * item.height,
              0,
            ),
          }
        : { imageBytes: 0, imagePixels: 0 };
    if (!this.imageBudgetAvailable(imageBudget)) {
      return { accepted: false, error: "Too many image attachments are awaiting run settlement" };
    }
    if (command.type === "image-command" && !imageAttachmentCapability(this.context)) {
      return { accepted: false, error: "Image attachments are unavailable for this model" };
    }
    const { content, delivery } = command;
    const message: BrokerPayload =
      command.type === "image-command"
        ? [
            ...(content ? [{ type: "text" as const, text: content }] : []),
            ...command.attachments.map((attachment) => ({
              type: "image" as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            })),
          ]
        : content;
    const idle = this.context.isIdle();
    if (delivery === "immediate") {
      if (!idle || this.promptAdmission) {
        return { accepted: false, error: "Pi is busy; choose Steer or Queue" };
      }
      const selectedModel = this.context.model;
      if (!selectedModel) return { accepted: false, error: "No model is selected" };
      const selectedModelIdentity = modelIdentity(this.context);
      const auth = await waitForProviderAuth(
        this.context.modelRegistry.getProviderAuth(selectedModel.provider),
        signal,
      );
      if (auth === AUTH_ABORTED) return { accepted: false, error: "Session changed" };
      if (!auth) return { accepted: false, error: "The selected model is not authenticated" };
      if (
        selectedModelIdentity !== modelIdentity(this.context) ||
        !this.commandIsCurrent(command, signal)
      ) {
        return { accepted: false, error: "Session changed" };
      }
      if (!this.context.isIdle() || this.promptAdmission) {
        return { accepted: false, error: "Pi is busy; choose Steer or Queue" };
      }
      this.promptAdmission = true;
      this.promptAdmissionTimer = setTimeout(
        () => this.releasePromptAdmission(),
        PROMPT_ADMISSION_TTL_MS,
      );
      this.promptAdmissionTimer.unref?.();
      try {
        if (!this.commandIsCurrent(command, signal)) {
          this.releasePromptAdmission();
          return { accepted: false, error: "Session changed" };
        }
        if (!this.imageBudgetAvailable(imageBudget)) {
          this.releasePromptAdmission();
          return {
            accepted: false,
            error: "Too many image attachments are awaiting run settlement",
          };
        }
        this.reserveCommand(command, imageBudget);
        try {
          this.pi.sendUserMessage(message as never);
        } catch (error) {
          this.releaseCommand(command.commandId);
          throw error;
        }
      } catch (error) {
        this.releasePromptAdmission();
        throw error;
      }
    } else {
      if (!this.commandIsCurrent(command, signal)) {
        return { accepted: false, error: "Session changed" };
      }
      if (idle) return { accepted: false, error: "Pi is idle; send a prompt instead" };
      if (!this.imageBudgetAvailable(imageBudget)) {
        return { accepted: false, error: "Too many image attachments are awaiting run settlement" };
      }
      const queued = this.broker.enqueue({
        commandId: command.commandId,
        commandEpoch: command.commandEpoch,
        delivery,
        content,
        attachmentCount: command.type === "image-command" ? command.attachments.length : 0,
        retainedBytes: imageBudget.imageBytes,
        payload: message,
      });
      if (queued.status !== "accepted") {
        return { accepted: false, error: queued.message, reason: queued.reason };
      }
      this.reserveCommand(command, imageBudget, queued.record.id);
    }
    return { accepted: true };
  }

  private async mutatePendingInput(
    command: QueueMutationCommand,
    signal: AbortSignal,
  ): Promise<CommandAcceptance> {
    if (!this.commandIsCurrent(command, signal))
      return { accepted: false, error: "Session changed", reason: "session-changed" };
    const result = this.broker.mutate(
      command.type === "queue-edit"
        ? {
            action: "edit",
            itemId: command.itemId,
            expectedItemVersion: command.expectedItemVersion,
            content: command.content,
          }
        : {
            action: "remove",
            itemId: command.itemId,
            expectedItemVersion: command.expectedItemVersion,
          },
    );
    if (result.status !== "accepted")
      return { accepted: false, error: result.message, reason: result.reason };
    if (command.type === "queue-remove" && result.record) {
      const admitted = this.admittedCommands.get(result.record.commandId);
      if (admitted) {
        this.server?.completeCommand(
          result.record.commandId,
          admitted.commandEpoch,
          "failed",
          "Pending input was removed before delivery",
        );
        this.releaseCommand(result.record.commandId);
      }
    }
    return { accepted: true };
  }

  private async releaseBroker(delivery: "steer" | "followUp"): Promise<void> {
    if (!this.active()) return;
    const result = await this.broker.releaseNext(delivery, (payload, mode) => {
      this.pi.sendUserMessage(payload as never, { deliverAs: mode });
    });
    if (result.status === "handed-off") {
      const admitted = this.admittedCommands.get(result.record.commandId);
      if (admitted) admitted.handedOff = true;
    }
    this.scheduleBroadcast();
  }

  private imageBudgetAvailable(budget: { imageBytes: number; imagePixels: number }): boolean {
    if (budget.imageBytes === 0) return true;
    return (
      this.unsettledImageCommands < MAX_UNSETTLED_IMAGE_COMMANDS &&
      this.unsettledImageBytes + budget.imageBytes <= MAX_UNSETTLED_IMAGE_BYTES &&
      this.unsettledImagePixels + budget.imagePixels <= MAX_UNSETTLED_IMAGE_PIXELS
    );
  }

  private reserveCommand(
    command: OutboundCommand,
    budget: { imageBytes: number; imagePixels: number },
    brokerItemId?: string,
  ): void {
    this.admittedCommands.set(command.commandId, {
      commandEpoch: command.commandEpoch,
      handedOff: brokerItemId === undefined,
      ...budget,
    });
    if (budget.imageBytes > 0) this.unsettledImageCommands += 1;
    this.unsettledImageBytes += budget.imageBytes;
    this.unsettledImagePixels += budget.imagePixels;
  }

  private releaseCommand(commandId: string): void {
    const command = this.admittedCommands.get(commandId);
    if (!command) return;
    this.admittedCommands.delete(commandId);
    if (command.imageBytes > 0) this.unsettledImageCommands -= 1;
    this.unsettledImageBytes -= command.imageBytes;
    this.unsettledImagePixels -= command.imagePixels;
  }

  private settleAdmittedCommands(
    status: "completed" | "failed",
    error?: string,
    includeHeld = true,
  ): void {
    const server = this.server;
    for (const [commandId, command] of this.admittedCommands) {
      if (!includeHeld && !command.handedOff) continue;
      server?.completeCommand?.(commandId, command.commandEpoch, status, error);
      this.releaseCommand(commandId);
    }
  }

  private releasePromptAdmission(): void {
    this.promptAdmission = false;
    if (this.promptAdmissionTimer) clearTimeout(this.promptAdmissionTimer);
    this.promptAdmissionTimer = undefined;
  }
}

function agentFailure(event: unknown): { message?: string; aborted: boolean } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const messages = (event as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const rawMessage = messages[index];
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const value = rawMessage as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (value.role !== "assistant") continue;
    if (value.stopReason !== "error" && value.stopReason !== "aborted") return undefined;
    const aborted = value.stopReason === "aborted";
    const displayMessage =
      typeof value.errorMessage === "string" && value.errorMessage.trim()
        ? value.errorMessage.slice(0, LIMITS.maxErrorChars)
        : aborted
          ? "Command was aborted"
          : "Command failed";
    return { message: displayMessage, aborted };
  }
  return undefined;
}
