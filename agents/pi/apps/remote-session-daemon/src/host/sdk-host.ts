import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createSdkBundle, type SdkBundleHandle, type SdkBundleOptions } from "./sdk-bundle.ts";
import { PendingInputBroker, type QueueMutation } from "./pending-input-broker.ts";
import {
  SDK_PROJECTION_LIMITS,
  measureBoundedHistory,
} from "../observability/sdk-projection-bounds.ts";
import { LIMITS, inspectRasterImage } from "@dotfiles/pi-web-ui-client/wire";
import type {
  AdmissionResult,
  HistoryEntry,
  HistoryPage,
  HistoryRequest,
  ProjectionRead,
  ProjectionReadRequest,
  SessionHost,
  SessionHostCommand,
  SessionHostImage,
  SessionCommandInfo,
  SessionHostEvent,
  SessionHostListener,
  SessionHostState,
  SessionTransition,
  TransitionResult,
} from "./session-host.ts";

export interface SdkSessionHostOptions extends SdkBundleOptions {
  launchId: string;
  hostEpoch?: string;
  admissionDeadlineMs?: number;
  disposalDeadlineMs?: number;
  maxPendingAdmissions?: number;
  bundleFactory?: (options: SdkBundleOptions) => Promise<SdkBundleHandle>;
}

interface AcceptedSdkCommand {
  commandId: string;
  abortRequested: boolean;
  imageBytes: number;
  imagePixels: number;
}

interface RunOutcome {
  outcome: "completed" | "failed" | "aborted";
  message?: string;
}

const PROJECTION_STRUCTURAL_CHARS = 512;
const MAX_ACCEPTED_IMAGE_COMMANDS = 2;
const MAX_ACCEPTED_IMAGE_BYTES = 2 * LIMITS.maxImageSourceBytesPerEntry;
const MAX_ACCEPTED_IMAGE_PIXELS = 2 * LIMITS.maxImagePixels;
function projectionStructuralField(
  value: unknown,
  fallback: string,
): { value: string; oversized: boolean } {
  const text = typeof value === "string" ? value : value == null ? fallback : String(value);
  if (text.length <= PROJECTION_STRUCTURAL_CHARS) return { value: text, oversized: false };
  return {
    value: `${fallback}-${createHash("sha256").update(text).digest("hex")}`,
    oversized: true,
  };
}

interface PendingSdkAdmission {
  commandId: string;
  bundle: SdkBundleHandle;
  imageBytes: number;
  imagePixels: number;
  accepted: boolean;
  settled: boolean;
  cancelOnAcceptance: boolean;
  timer: NodeJS.Timeout;
  resolve(result: AdmissionResult): void;
}

export class SdkSessionHost implements SessionHost {
  #bundle: SdkBundleHandle;
  #ownedBundles = new Set<SdkBundleHandle>();
  #options: SdkSessionHostOptions;
  #listeners = new Set<SessionHostListener>();
  #unsubscribe: (() => void) | undefined;
  #state: SessionHostState;
  #disposePromise?: Promise<void>;
  #transitionPromise?: Promise<TransitionResult>;
  #pendingAdmissions = new Map<string, PendingSdkAdmission>();
  #activePrompts = new Map<string, PendingSdkAdmission>();
  #acceptedCommands = new Map<string, AcceptedSdkCommand>();
  #promptTasks = new Set<Promise<void>>();
  #ownedTasks = new Set<Promise<unknown>>();
  #liveMessageIds = new Set<string>();
  #runOutcome?: RunOutcome;
  #acceptedImageCommands = 0;
  #acceptedImageBytes = 0;
  #acceptedImagePixels = 0;
  #broker: PendingInputBroker;
  #brokerEpoch = 0;
  #brokerReleaseTasks = new Set<Promise<void>>();

  private constructor(options: SdkSessionHostOptions, bundle: SdkBundleHandle) {
    this.#options = options;
    this.#bundle = bundle;
    this.#ownedBundles.add(bundle);
    const snapshot = bundle.snapshot();
    this.#state = {
      launchId: options.launchId,
      hostEpoch: options.hostEpoch ?? randomUUID(),
      sessionEpoch: randomUUID(),
      lifecycle: snapshot.idle ? "ready" : "running",
      ready: true,
      running: !snapshot.idle,
      settled: snapshot.idle,
      pendingMessages: snapshot.pendingMessages,
      queueCount: snapshot.pendingMessages,
      queueBytes: snapshot.queueBytes,
      dialog: null,
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      identity: snapshot.identity,
    };
    this.#broker = new PendingInputBroker(
      () => this.#patchQueueFromBundle(),
      100,
      LIMITS.maxImageSourceBytesPerEntry + 2 * LIMITS.maxInputChars,
    );
    this.#patchQueueFromBundle();
    this.#bind();
  }
  static async create(options: SdkSessionHostOptions): Promise<SdkSessionHost> {
    const boundedOption = (value: number | undefined, name: string, maximum: number) => {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum))
        throw new RangeError(`${name} is invalid`);
    };
    boundedOption(options.admissionDeadlineMs, "Admission deadline", 10 * 60_000);
    boundedOption(options.disposalDeadlineMs, "Disposal deadline", 10 * 60_000);
    boundedOption(options.maxPendingAdmissions, "Pending admission count", 256);
    const factory = options.bundleFactory ?? createSdkBundle;
    const bundle = await factory(options);
    return new SdkSessionHost(options, bundle);
  }
  get state(): SessionHostState {
    return structuredClone(this.#state);
  }
  subscribe(listener: SessionHostListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(event: SessionHostEvent): void {
    for (const listener of this.#listeners) listener(structuredClone(event));
  }
  #patch(patch: Partial<SessionHostState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit({ type: "state", state: this.state });
  }
  #queueItems() {
    const native = this.#bundle.projectionRead(1_000).queue.map((item) => ({
      ...item,
      editable: false,
    }));
    return [...this.#broker.snapshot(), ...native];
  }
  #patchQueueFromBundle(): void {
    const queue = this.#queueItems();
    const queueBytes = queue.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0);
    this.#patch({
      pendingMessages: queue.length,
      queueCount: queue.length,
      queueBytes,
    });
    this.#emit({ type: "queue", count: queue.length, bytes: queueBytes });
  }
  #discardBroker(message: string): void {
    this.#brokerEpoch += 1;
    for (const record of this.#broker.reset()) {
      this.#emit({
        type: "command_completed",
        commandId: record.commandId,
        outcome: "failed",
        message,
      });
    }
  }
  async #releaseBroker(delivery: "steer" | "followUp"): Promise<void> {
    const bundle = this.#bundle;
    const brokerEpoch = this.#brokerEpoch;
    const result = await this.#broker.releaseNext(delivery, (content, mode, images) => {
      if (brokerEpoch !== this.#brokerEpoch || bundle !== this.#bundle || this.#disposePromise)
        throw new Error("Pending input release was fenced");
      const sdkImages = images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      }));
      return mode === "steer"
        ? bundle.steer(content, sdkImages)
        : bundle.followUp(content, sdkImages);
    });
    if (
      result.status === "handed-off" &&
      brokerEpoch === this.#brokerEpoch &&
      bundle === this.#bundle &&
      !this.#disposePromise
    ) {
      this.#acceptedCommands.set(result.record.commandId, {
        commandId: result.record.commandId,
        abortRequested: false,
        imageBytes: result.record.retainedBytes,
        imagePixels: result.record.images.reduce(
          (pixels, image) => pixels + image.width * image.height,
          0,
        ),
      });
      if (result.record.images.length > 0) {
        this.#acceptedImageCommands += 1;
        this.#acceptedImageBytes += result.record.retainedBytes;
        this.#acceptedImagePixels += result.record.images.reduce(
          (pixels, image) => pixels + image.width * image.height,
          0,
        );
      }
    }
    if (brokerEpoch === this.#brokerEpoch && bundle === this.#bundle && !this.#disposePromise)
      this.#patchQueueFromBundle();
  }
  #startBrokerRelease(delivery: "steer" | "followUp"): void {
    const task = this.#releaseBroker(delivery);
    this.#brokerReleaseTasks.add(task);
    void task.finally(() => this.#brokerReleaseTasks.delete(task)).catch(() => undefined);
    void this.#own(task).catch(() => undefined);
  }
  async #waitForBrokerReleases(deadlineMs: number): Promise<boolean> {
    const expiresAt = Date.now() + deadlineMs;
    while (this.#brokerReleaseTasks.size > 0) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) return false;
      const settled = await Promise.race([
        Promise.allSettled(this.#brokerReleaseTasks).then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), remaining);
          timer.unref();
        }),
      ]);
      if (!settled) return false;
    }
    return true;
  }

  #bind(): void {
    this.#unsubscribe?.();
    const boundBundle = this.#bundle;
    this.#unsubscribe = boundBundle.subscribe((raw) => {
      if (boundBundle !== this.#bundle || raw === null || typeof raw !== "object") return;
      const event = raw as Record<string, unknown>;
      const type = String(event.type ?? "");
      if (type === "agent_start") {
        this.#runOutcome = undefined;
        this.#patch({ running: true, settled: false, lifecycle: "running" });
      } else if (type === "agent_settled") {
        this.#liveMessageIds.clear();
        this.#patch({
          running: false,
          settled: true,
          lifecycle: "ready",
        });
        this.#patchQueueFromBundle();
        this.#emit({ type: "settled" });
        this.#completeAcceptedCommands();
      } else if (type === "turn_end") {
        this.#startBrokerRelease("steer");
      } else if (type === "agent_end") {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message && typeof message === "object" && message.role === "assistant") {
            this.#captureAssistantOutcome(message as Record<string, unknown>);
            break;
          }
        }
        if (!this.#runOutcome || this.#runOutcome.outcome !== "aborted")
          this.#startBrokerRelease("followUp");
      } else if (type === "entry_appended" || type === "session_info_changed") {
        this.#emit({ type: "durable_change" });
      } else if (type === "queue_update") {
        this.#patchQueueFromBundle();
      } else if (type === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        const mapped = this.#messageBoundary(message);
        if (mapped && !this.#liveMessageIds.has(mapped.messageId)) {
          this.#liveMessageIds.add(mapped.messageId);
          this.#emit({ type: "message_start", ...mapped });
        }
      } else if (type === "message_update") {
        const rawMessage = event.message as Record<string, unknown> | undefined;
        const message = rawMessage ? { role: "assistant", ...rawMessage } : undefined;
        const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
        const mapped = this.#messageBoundary(message);
        if (!mapped) return;
        if (!this.#liveMessageIds.has(mapped.messageId)) {
          this.#liveMessageIds.add(mapped.messageId);
          this.#emit({ type: "message_start", ...mapped });
        }
        if (delta?.type === "text_delta" && typeof delta.delta === "string")
          this.#emit({ type: "message_delta", messageId: mapped.messageId, text: delta.delta });
      } else if (type === "message_end") {
        const message = event.message as Record<string, unknown> | undefined;
        const mapped = this.#messageBoundary(message);
        if (!mapped) return;
        this.#liveMessageIds.delete(mapped.messageId);
        if (mapped.role === "assistant") this.#captureAssistantOutcome(message);
        this.#emit({ type: "message_end", ...mapped });
      } else if (type === "thinking_level_changed") {
        const level = event.level;
        if (
          level === "off" ||
          level === "minimal" ||
          level === "low" ||
          level === "medium" ||
          level === "high" ||
          level === "xhigh" ||
          level === "max"
        ) {
          this.#patch({ thinkingLevel: level });
          this.#emit({ type: "thinking", level });
        }
      } else if (type === "compaction_start") {
        this.#emit({ type: "compaction", phase: "started" });
      } else if (type === "compaction_end") {
        this.#emit({
          type: "compaction",
          phase: event.errorMessage ? "failed" : "completed",
          ...(typeof event.errorMessage === "string" ? { message: event.errorMessage } : {}),
        });
      } else if (type === "tool_execution_start") {
        this.#emit({
          type: "tool_start",
          toolCallId: String(event.toolCallId),
          name: String(event.toolName),
          input: event.args,
        });
      } else if (type === "tool_execution_update") {
        this.#emit({
          type: "tool_update",
          toolCallId: String(event.toolCallId),
          update: event.partialResult,
        });
      } else if (type === "tool_execution_end") {
        this.#emit({
          type: "tool_end",
          toolCallId: String(event.toolCallId),
          output: event.result,
          error: event.isError ? "Tool failed" : undefined,
        });
      }
    });
  }
  #messageBoundary(
    message: Record<string, unknown> | undefined,
  ): { messageId: string; role: "user" | "assistant" | "tool" } | undefined {
    const rawRole = message?.role;
    const role = rawRole === "toolResult" ? "tool" : rawRole;
    if (role !== "user" && role !== "assistant" && role !== "tool") return undefined;
    const stablePart =
      typeof message?.id === "string"
        ? message.id
        : role === "tool" && typeof message?.toolCallId === "string"
          ? `${message.toolCallId}:${String(message.timestamp ?? "")}`
          : String(message?.timestamp ?? role);
    return { messageId: `${role}:${stablePart}`, role };
  }
  #captureAssistantOutcome(message: Record<string, unknown> | undefined): void {
    const stopReason = message?.stopReason;
    if (stopReason !== "aborted" && stopReason !== "error") return;
    const outcome = stopReason === "aborted" ? "aborted" : "failed";
    this.#runOutcome = {
      outcome,
      ...(outcome === "failed" && typeof message?.errorMessage === "string"
        ? { message: message.errorMessage }
        : {}),
    };
  }
  #completeAcceptedCommands(): void {
    if (this.#acceptedCommands.size === 0) return;
    const aborted = [...this.#acceptedCommands.values()].some((command) => command.abortRequested);
    this.#settleAcceptedCommands(
      this.#runOutcome ?? { outcome: aborted ? "aborted" : "completed" },
    );
  }
  #settleAcceptedCommands(outcome: RunOutcome): void {
    const commands = [...this.#acceptedCommands.values()];
    for (const command of commands) {
      if (command.imageBytes > 0) {
        this.#acceptedImageCommands = Math.max(0, this.#acceptedImageCommands - 1);
        this.#acceptedImageBytes = Math.max(0, this.#acceptedImageBytes - command.imageBytes);
        this.#acceptedImagePixels = Math.max(0, this.#acceptedImagePixels - command.imagePixels);
      }
    }
    this.#acceptedCommands.clear();
    this.#activePrompts.clear();
    this.#runOutcome = undefined;
    for (const command of commands)
      this.#emit({
        type: "command_completed",
        commandId: command.commandId,
        outcome: outcome.outcome,
        ...(outcome.message ? { message: outcome.message } : {}),
      });
  }
  commands(): readonly SessionCommandInfo[] {
    if (!this.#state.ready || this.#disposePromise || this.#transitionPromise) return [];
    return this.#bundle.commands().map((command) => ({ ...command }));
  }
  async command(command: SessionHostCommand): Promise<AdmissionResult> {
    if (!this.#state.ready || this.#disposePromise || this.#transitionPromise)
      return this.#admission({
        status: "rejected",
        commandId: command.commandId,
        code: "host_not_ready",
        message: "Host is fenced",
      });
    if (command.type === "queue_edit" || command.type === "queue_remove")
      return this.#queueMutation(command);
    if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
      const imageError = this.#validateImages(command.images ?? []);
      if (imageError)
        return this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "image_rejected",
          message: imageError,
        });
      if (command.type !== "prompt" && this.#state.running) {
        const queued = this.#broker.enqueue(
          command.commandId,
          this.#state.sessionEpoch,
          command.type === "steer" ? "steer" : "followUp",
          command.text,
          command.images,
        );
        if (queued.status !== "accepted")
          return this.#admission({
            status: "rejected",
            commandId: command.commandId,
            code: queued.reason,
            message: queued.message,
          });
        this.#patchQueueFromBundle();
        return this.#admission({ status: "queued", commandId: command.commandId });
      }
      return this.#promptAdmission(command);
    }
    if (command.type === "abort") {
      this.#fencePendingAdmissions("Command admission was interrupted by abort", true);
      this.#discardBroker("Pending input was cancelled by abort");
      await this.#waitForBrokerReleases(this.#options.admissionDeadlineMs ?? 30_000);
      await this.#own(this.#bundle.abort());
      return this.#admission({ status: "accepted", commandId: command.commandId });
    }
    if (command.type === "set_model") {
      if (!(await this.#waitForBrokerReleases(this.#options.admissionDeadlineMs ?? 30_000)))
        return this.#admission({
          status: "ambiguous",
          commandId: command.commandId,
          message: "Pending input release did not settle before model change",
        });
      const bundle = this.#bundle;
      const snapshot = bundle.snapshot();
      const capability = snapshot.modelControl;
      if (!capability)
        return this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "capability_off",
          message: "Managed model control is unavailable",
        });
      if (
        !capability.models.some(
          (model) => model.provider === command.provider && model.id === command.model,
        )
      )
        return this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "invalid_control",
          message: "Model is not an advertised managed target",
        });
      if (snapshot.model?.provider === command.provider && snapshot.model.id === command.model)
        return this.#admission({ status: "handled", commandId: command.commandId });
      const previous = snapshot.model;
      const found = await this.#own(bundle.setModel(command.provider, command.model));
      if (this.#disposePromise || bundle !== this.#bundle)
        return this.#admission({
          status: "ambiguous",
          commandId: command.commandId,
          message: "Host changed during model admission",
        });
      const effective = bundle.snapshot().model;
      const identityChanged =
        previous?.provider !== effective?.provider || previous?.id !== effective?.id;
      if (identityChanged) {
        this.#settleAcceptedCommands({ outcome: "failed", message: "Model changed" });
        this.#discardBroker("Model changed before pending input delivery");
      }
      this.#patch({
        ...(identityChanged ? { sessionEpoch: randomUUID() } : {}),
        model: effective,
      });
      this.#emit({ type: "model", model: effective });
      if (this.#state.settled && !this.#state.running) this.#emit({ type: "durable_change" });
      if (!found || effective?.provider !== command.provider || effective.id !== command.model)
        return this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "invalid_control",
          message: "Requested model was not applied",
        });
      return this.#admission({ status: "handled", commandId: command.commandId });
    }
    if (command.type === "set_thinking") {
      const snapshot = this.#bundle.snapshot();
      const capability = snapshot.modelControl;
      if (!capability)
        return this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "capability_off",
          message: "Managed thinking control is unavailable",
        });
      if (!capability.thinkingLevels.includes(command.level))
        return this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "invalid_control",
          message: "Thinking level is not an advertised managed target",
        });
      if (snapshot.thinkingLevel === command.level)
        return this.#admission({ status: "handled", commandId: command.commandId });
      const effective = this.#bundle.setThinking(command.level);
      this.#patch({ thinkingLevel: effective });
      this.#emit({ type: "thinking", level: effective });
      if (this.#state.settled && !this.#state.running) this.#emit({ type: "durable_change" });
      if (effective !== command.level)
        return this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "invalid_control",
          message: "Requested thinking level was not applied",
        });
      return this.#admission({ status: "handled", commandId: command.commandId });
    }
    if (command.type === "compact") {
      for (const pending of this.#activePrompts.values()) pending.cancelOnAcceptance = true;
      for (const accepted of this.#acceptedCommands.values()) accepted.abortRequested = true;
      if (!(await this.#waitForBrokerReleases(this.#options.admissionDeadlineMs ?? 30_000)))
        return this.#admission({
          status: "ambiguous",
          commandId: command.commandId,
          message: "Pending input release did not settle before compaction",
        });
      const bundle = this.#bundle;
      await this.#own(bundle.compact(command.instructions));
      this.#discardBroker("Session compacted before pending input delivery");
      if (this.#disposePromise || bundle !== this.#bundle)
        return this.#admission({
          status: "ambiguous",
          commandId: command.commandId,
          message: "Host changed during compaction admission",
        });
      return this.#admission({ status: "handled", commandId: command.commandId });
    }
    if (command.type === "dialog_response" || command.type === "dialog_cancel")
      return this.#admission({
        status: "rejected",
        commandId: command.commandId,
        code: "dialogs_disabled",
        message: "Managed dialogs are disabled",
      });

    throw new Error("Unhandled SDK host command");
  }
  #imageBudget(images: readonly SessionHostImage[]): { bytes: number; pixels: number } {
    return images.reduce(
      (total, image) => ({
        bytes: total.bytes + image.byteLength,
        pixels: total.pixels + image.width * image.height,
      }),
      { bytes: 0, pixels: 0 },
    );
  }
  #validateImages(images: readonly SessionHostImage[]): string | undefined {
    if (images.length === 0) return undefined;
    const capability = this.#bundle.snapshot().imageAttachments;
    if (!capability || images.length > capability.maxAttachments)
      return "Image attachments are unavailable for this model";
    let totalBytes = 0;
    let totalPixels = 0;
    for (const image of images) {
      if (
        !capability.supportedMimeTypes.includes(image.mimeType) ||
        image.byteLength > capability.maxBytesPerImage ||
        image.width > capability.maxWidth ||
        image.height > capability.maxHeight
      )
        return "Image attachment exceeds the managed capability";
      const content = Buffer.from(image.data, "base64");
      if (content.length !== image.byteLength) return "Image attachment data is invalid";
      const inspected = inspectRasterImage(content, image.mimeType);
      if (typeof inspected === "string") return "Image attachment is invalid";
      if (inspected.width !== image.width || inspected.height !== image.height)
        return "Image attachment dimensions do not match";
      totalBytes += content.length;
      totalPixels += inspected.width * inspected.height;
      if (totalBytes > capability.maxTotalBytes || totalPixels > capability.maxTotalPixels)
        return "Image attachments exceed the managed aggregate limit";
    }
    return undefined;
  }

  #queueMutation(
    command: Extract<SessionHostCommand, { type: "queue_edit" | "queue_remove" }>,
  ): Promise<AdmissionResult> {
    const mutation: QueueMutation =
      command.type === "queue_edit"
        ? {
            action: "edit",
            itemId: command.itemId,
            expectedItemVersion: command.expectedItemVersion,
            content: command.text,
          }
        : {
            action: "remove",
            itemId: command.itemId,
            expectedItemVersion: command.expectedItemVersion,
          };
    const result = this.#broker.mutate(mutation);
    if (result.status !== "accepted")
      return Promise.resolve(
        this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: result.reason,
          message: result.message,
        }),
      );
    this.#patchQueueFromBundle();
    if (command.type === "queue_remove" && result.record)
      this.#emit({
        type: "command_completed",
        commandId: result.record.commandId,
        outcome: "aborted",
        message: "Pending input was removed before delivery",
      });
    return Promise.resolve(this.#admission({ status: "handled", commandId: command.commandId }));
  }

  #promptAdmission(
    command: Extract<SessionHostCommand, { type: "prompt" | "steer" | "follow_up" }>,
  ): Promise<AdmissionResult> {
    if (this.#pendingAdmissions.has(command.commandId))
      return Promise.resolve(
        this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "duplicate",
          message: "Command admission is already pending",
        }),
      );
    const maxPending = this.#options.maxPendingAdmissions ?? 1;
    if (this.#pendingAdmissions.size >= maxPending || this.#acceptedCommands.size >= 256)
      return Promise.resolve(
        this.#admission({
          status: "rejected",
          commandId: command.commandId,
          code: "admission_limit_exhausted",
          message: "SDK admission limit is exhausted",
        }),
      );
    const bundle = this.#bundle;
    const knownCommand = command.text.startsWith("/")
      ? new Set(bundle.commands().map((item) => item.name)).has(
          command.text.slice(1).split(/\s/, 1)[0] ?? "",
        )
      : false;
    const disposition =
      command.type === "prompt"
        ? knownCommand
          ? "handled"
          : "accepted"
        : this.#state.running
          ? "queued"
          : "accepted";
    return new Promise<AdmissionResult>((resolve) => {
      const imageBudget = this.#imageBudget(command.images ?? []);
      if (
        imageBudget.bytes > 0 &&
        (this.#acceptedImageCommands >= MAX_ACCEPTED_IMAGE_COMMANDS ||
          this.#acceptedImageBytes + imageBudget.bytes > MAX_ACCEPTED_IMAGE_BYTES ||
          this.#acceptedImagePixels + imageBudget.pixels > MAX_ACCEPTED_IMAGE_PIXELS)
      ) {
        return Promise.resolve(
          this.#admission({
            status: "rejected",
            commandId: command.commandId,
            code: "image_admission_limit",
            message: "Too many image commands are awaiting run settlement",
          }),
        );
      }
      const pending: PendingSdkAdmission = {
        commandId: command.commandId,
        bundle,
        imageBytes: imageBudget.bytes,
        imagePixels: imageBudget.pixels,
        accepted: false,
        settled: false,
        cancelOnAcceptance: false,
        timer: setTimeout(() => {
          if (pending.settled) return;
          this.#settleSdkAdmission(pending, {
            status: "ambiguous",
            commandId: command.commandId,
            message: "SDK prompt admission deadline expired after invocation",
          });
          this.#patch({
            lifecycle: "failed",
            ready: false,
            failure: {
              code: "admission_timeout",
              message: "SDK prompt admission outcome is unknown",
              ambiguous: true,
            },
          });
          this.#emit({ type: "host_lost", ambiguousCommandId: command.commandId });
        }, this.#options.admissionDeadlineMs ?? 30_000),
        resolve,
      };
      pending.timer.unref();
      this.#pendingAdmissions.set(command.commandId, pending);
      let completion: Promise<void>;
      try {
        completion = bundle.prompt(
          command.text,
          command.type,
          (accepted) => {
            if (pending.settled) {
              if (accepted && pending.cancelOnAcceptance) {
                pending.accepted = true;
                this.#activePrompts.set(command.commandId, pending);
                void this.#own(bundle.abort()).catch(() => undefined);
              }
              return;
            }
            if (bundle !== this.#bundle) {
              this.#settleSdkAdmission(pending, {
                status: "ambiguous",
                commandId: command.commandId,
                message: "SDK host changed during command admission",
              });
              return;
            }
            pending.accepted = accepted;
            if (accepted && disposition !== "handled") {
              this.#activePrompts.set(command.commandId, pending);
              this.#acceptedCommands.set(command.commandId, {
                commandId: command.commandId,
                abortRequested: pending.cancelOnAcceptance,
                imageBytes: pending.imageBytes,
                imagePixels: pending.imagePixels,
              });
              if (pending.imageBytes > 0) {
                this.#acceptedImageCommands += 1;
                this.#acceptedImageBytes += pending.imageBytes;
                this.#acceptedImagePixels += pending.imagePixels;
              }
            }
            this.#settleSdkAdmission(
              pending,
              accepted
                ? { status: disposition, commandId: command.commandId }
                : {
                    status: "rejected",
                    commandId: command.commandId,
                    code: "preflight_rejected",
                    message: "SDK rejected command preflight",
                  },
            );
          },
          command.images?.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        );
      } catch {
        this.#settleSdkAdmission(pending, {
          status: "ambiguous",
          commandId: command.commandId,
          message: "SDK prompt failed before authoritative admission",
        });
        return;
      }
      const observed = completion.then(
        () => {
          if (!pending.settled)
            this.#settleSdkAdmission(pending, {
              status: "ambiguous",
              commandId: command.commandId,
              message: "SDK prompt completed without an admission callback",
            });
          const accepted = this.#acceptedCommands.get(command.commandId);
          if (accepted && pending.cancelOnAcceptance) accepted.abortRequested = true;
        },
        () => {
          if (!pending.settled)
            this.#settleSdkAdmission(pending, {
              status: "ambiguous",
              commandId: command.commandId,
              message: "SDK prompt failed without an authoritative admission callback",
            });
          const accepted = this.#acceptedCommands.get(command.commandId);
          if (accepted)
            this.#runOutcome = pending.cancelOnAcceptance
              ? { outcome: "aborted" }
              : { outcome: "failed", message: "SDK prompt failed" };
        },
      );
      this.#promptTasks.add(observed);
      this.#own(observed);
      void observed.finally(() => {
        this.#promptTasks.delete(observed);
      });
    });
  }
  #settleSdkAdmission(pending: PendingSdkAdmission, result: AdmissionResult): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.#pendingAdmissions.delete(pending.commandId);
    pending.resolve(this.#admission(result));
  }
  #fencePendingAdmissions(message: string, cancelOnAcceptance = false): void {
    if (cancelOnAcceptance) {
      for (const pending of this.#activePrompts.values()) pending.cancelOnAcceptance = true;
      for (const accepted of this.#acceptedCommands.values()) accepted.abortRequested = true;
    }
    for (const pending of this.#pendingAdmissions.values()) {
      pending.cancelOnAcceptance ||= cancelOnAcceptance;
      this.#settleSdkAdmission(pending, {
        status: "ambiguous",
        commandId: pending.commandId,
        message,
      });
    }
  }
  #own<T>(task: Promise<T>): Promise<T> {
    this.#ownedTasks.add(task);
    void task.then(
      () => this.#ownedTasks.delete(task),
      () => this.#ownedTasks.delete(task),
    );
    return task;
  }
  #admission(result: AdmissionResult): AdmissionResult {
    this.#emit({ type: "admission", result });
    return result;
  }
  transition(transition: SessionTransition): Promise<TransitionResult> {
    if (this.#transitionPromise) return this.#transitionPromise;
    this.#transitionPromise = this.#performTransition(transition).finally(() => {
      this.#transitionPromise = undefined;
    });
    return this.#transitionPromise;
  }
  async #performTransition(transition: SessionTransition): Promise<TransitionResult> {
    const lifecycle =
      transition.type === "unload"
        ? "unloading"
        : transition.type === "restart"
          ? "restarting"
          : "transitioning";
    this.#patch({ lifecycle, ready: false });
    this.#emit({ type: "transition", phase: "started", transition });
    if (
      transition.type !== "unload" &&
      transition.type !== "replace" &&
      transition.type !== "restart"
    ) {
      const message = "SDK session transitions are enabled in Phase 5";
      this.#patch({ lifecycle: "ready", ready: true });
      this.#emit({ type: "transition", phase: "failed", transition, message });
      return { status: "failed", message };
    }
    if (transition.type === "unload") {
      if (!(await this.#waitForBrokerReleases(this.#options.disposalDeadlineMs ?? 5_000))) {
        const message = "Pending input release did not stop before unload";
        this.#patch({
          lifecycle: "failed",
          failure: { code: "release_timeout", message, ambiguous: true },
        });
        this.#emit({ type: "transition", phase: "failed", transition, message });
        return { status: "failed", message };
      }
      this.#discardBroker("Host unloaded before pending input delivery");
      await this.#retireBundle();
      this.#patch({ lifecycle: "unloaded", running: false, settled: true, identity: null });
      this.#emit({ type: "transition", phase: "completed", transition });
      return { status: "completed" };
    }
    const previous = this.#bundle;
    if (!(await this.#waitForBrokerReleases(this.#options.disposalDeadlineMs ?? 5_000))) {
      const message = "Pending input release did not stop before replacement";
      this.#patch({
        lifecycle: "failed",
        failure: { code: "release_timeout", message, ambiguous: true },
      });
      this.#emit({ type: "transition", phase: "failed", transition, message });
      return { status: "failed", message };
    }
    this.#discardBroker("Session host replaced before pending input delivery");
    let candidate: SdkBundleHandle | undefined;
    try {
      const factory = this.#options.bundleFactory ?? createSdkBundle;
      const sessionFile = transition.sessionFile ?? this.#state.identity?.sessionFile ?? undefined;
      candidate = await factory({ ...this.#options, sessionFile });
      this.#ownedBundles.add(candidate);
      const snapshot = candidate.snapshot();
      if (!snapshot.idle || snapshot.pendingMessages !== 0)
        throw new Error("Replacement host is not safely idle");
      this.#unsubscribe?.();
      this.#bundle = candidate;
      this.#bind();
      this.#patch({
        hostEpoch: randomUUID(),
        sessionEpoch: randomUUID(),
        lifecycle: "ready",
        ready: true,
        running: false,
        settled: true,
        pendingMessages: 0,
        queueCount: 0,
        queueBytes: 0,
        model: snapshot.model,
        thinkingLevel: snapshot.thinkingLevel,
        identity: snapshot.identity,
      });
      this.#patchQueueFromBundle();
      try {
        await previous.dispose();
        this.#ownedBundles.delete(previous);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#patch({
          lifecycle: "failed",
          failure: { code: "retirement_failed", message, ambiguous: false },
        });
        this.#emit({ type: "transition", phase: "failed", transition, message });
        return { status: "failed", identity: snapshot.identity, message };
      }
      this.#emit({ type: "transition", phase: "completed", transition });
      return { status: "completed", identity: snapshot.identity };
    } catch (error) {
      if (candidate && candidate !== this.#bundle) {
        try {
          await candidate.dispose();
          this.#ownedBundles.delete(candidate);
        } catch {
          // Ownership is retained for final host disposal.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#patch({
        lifecycle: "failed",
        failure: { code: "replacement_failed", message, ambiguous: false },
      });
      this.#emit({ type: "transition", phase: "failed", transition, message });
      return { status: "failed", message };
    }
  }
  async projectionRead(request: ProjectionReadRequest): Promise<ProjectionRead> {
    if (
      !Number.isSafeInteger(request.maxEntries) ||
      request.maxEntries < 1 ||
      request.maxEntries > 1_000 ||
      !Number.isSafeInteger(request.byteLimit) ||
      request.byteLimit < 1024 ||
      request.byteLimit > 16 * 1024 * 1024
    )
      throw new RangeError("Invalid projection read bounds");
    const source = this.#bundle.projectionRead(request.maxEntries);
    const mapped = source.entries.map((value, offset): HistoryEntry => {
      const raw = value as Record<string, unknown>;
      const fallbackId = `entry-${source.startIndex + offset}`;
      const id = projectionStructuralField(raw.id, fallbackId);
      const parentId =
        raw.parentId == null ? undefined : projectionStructuralField(raw.parentId, "parent");
      const type = projectionStructuralField(raw.type, "unknown");
      const oversizedField = id.oversized
        ? "id"
        : parentId?.oversized
          ? "parentId"
          : type.oversized
            ? "type"
            : undefined;
      let data: unknown;
      if (oversizedField)
        data = { type: "projection_placeholder", reason: "oversized", field: oversizedField };
      else
        try {
          data = structuredClone(value);
        } catch {
          data = { type: "projection_placeholder", reason: "unserializable" };
        }
      const timestamp =
        typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
          ? raw.timestamp
          : typeof raw.timestamp === "string"
            ? Date.parse(raw.timestamp) || 0
            : 0;
      return {
        id: id.value,
        parentId: parentId?.value ?? null,
        type: type.value,
        timestamp,
        data,
      };
    });
    const entries: HistoryEntry[] = [];
    let bytes = 2;
    for (let index = mapped.length - 1; index >= 0; index -= 1) {
      let entry = mapped[index]!;
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
      } catch {
        entry = { ...entry, data: { type: "projection_placeholder", reason: "unserializable" } };
        size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
      }
      if (size + bytes > request.byteLimit) {
        entry = { ...entry, data: { type: "projection_placeholder", reason: "oversized" } };
        size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
      }
      if (size + bytes > request.byteLimit) break;
      entries.unshift(entry);
      bytes += size;
    }
    const omitted = source.totalEntries - entries.length;
    const queue: ProjectionRead["queue"] = [];
    let queueBytes = 2;
    const projectedQueue = [
      ...this.#broker.snapshot(),
      ...source.queue.map((item) => ({ ...item, editable: false })),
    ];
    for (const item of projectedQueue.slice(0, 100)) {
      let content = item.content;
      if (Buffer.byteLength(content) > 32 * 1024)
        content = "[Projection placeholder: oversized queued input]";
      const projected = { ...item, content };
      const size = Buffer.byteLength(JSON.stringify(projected)) + (queue.length ? 1 : 0);
      if (queueBytes + size > 128 * 1024) break;
      queue.push(projected);
      queueBytes += size;
    }
    return {
      sessionEpoch: this.#state.sessionEpoch,
      entries,
      beforeCursor: omitted > 0 ? String(omitted) : null,
      hasMore: omitted > 0,
      queue,
      ...(this.#bundle.snapshot().imageAttachments === undefined
        ? {}
        : { imageAttachments: this.#bundle.snapshot().imageAttachments }),
      ...(this.#bundle.snapshot().modelControl === undefined
        ? {}
        : { modelControl: this.#bundle.snapshot().modelControl }),
      pendingInputBroker: { edit: true, remove: true },
    };
  }
  async history(request: HistoryRequest): Promise<HistoryPage> {
    const all = this.#bundle.entries();
    const cursorValid = request.cursor === undefined || /^(0|[1-9]\d*)$/.test(request.cursor);
    const start = request.cursor === undefined ? 0 : Number(request.cursor);
    if (
      !cursorValid ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > SDK_PROJECTION_LIMITS.historyPageEntries ||
      !Number.isSafeInteger(request.byteLimit) ||
      request.byteLimit < 2 ||
      request.byteLimit > SDK_PROJECTION_LIMITS.historyPageBytes
    )
      throw new RangeError("Invalid or unsafe history bounds");
    const entries: HistoryEntry[] = [];
    const reasons = new Set<string>();
    let bytes = 2;
    let scanned = 0;
    while (start + scanned < all.length && scanned < request.limit) {
      const index = start + scanned;
      scanned += 1;
      const raw = all[index] as Record<string, unknown>;
      const entry: HistoryEntry = {
        id: String(raw.id ?? index),
        parentId: raw.parentId == null ? null : String(raw.parentId),
        type: String(raw.type ?? "unknown"),
        timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
        data: structuredClone(raw),
      };
      const inspected = measureBoundedHistory([entry], 0);
      if (inspected.degraded) {
        for (const reason of inspected.reasons) reasons.add(reason);
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length === 0 ? 0 : 1);
      if (bytes + size > request.byteLimit) {
        reasons.add("page_bytes");
        continue;
      }
      entries.push(entry);
      bytes += size;
    }
    const next = start + scanned;
    return {
      entries,
      nextCursor: next < all.length ? String(next) : null,
      degraded: reasons.size > 0,
      ...(reasons.size > 0 ? { degradedReasons: [...reasons] } : {}),
      omittedEntries: Math.max(0, all.length - start - entries.length),
    };
  }
  async #retireBundle(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#bundle.dispose();
    this.#ownedBundles.delete(this.#bundle);
  }
  async #waitForOwnedTasks(deadlineMs: number): Promise<boolean> {
    const expiresAt = Date.now() + deadlineMs;
    while (this.#ownedTasks.size > 0) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) return false;
      const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining);
        timer.unref();
        void Promise.allSettled(this.#ownedTasks).then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!settled) return false;
    }
    return true;
  }
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = (async () => {
      this.#patch({ lifecycle: "stopping", ready: false });
      const brokerStopped = await this.#waitForBrokerReleases(
        this.#options.disposalDeadlineMs ?? 5_000,
      );
      this.#discardBroker("Host disposed before pending input delivery");
      const shouldAbort =
        this.#state.running ||
        this.#pendingAdmissions.size > 0 ||
        this.#promptTasks.size > 0 ||
        this.#ownedTasks.size > 0;
      this.#fencePendingAdmissions("Host stopped before admission became authoritative", true);
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      const errors: string[] = brokerStopped
        ? []
        : ["Pending input release did not stop before disposal"];
      if (shouldAbort)
        await this.#bundle.abort().catch((error: unknown) => {
          errors.push(error instanceof Error ? error.message : String(error));
        });
      const tasksStopped = await this.#waitForOwnedTasks(this.#options.disposalDeadlineMs ?? 5000);
      if (!tasksStopped) errors.push("Active SDK operation did not stop before disposal");
      if (tasksStopped) {
        const owned = [...this.#ownedBundles];
        const results = await Promise.allSettled(owned.map((bundle) => bundle.dispose()));
        results.forEach((result, index) => {
          if (result.status === "fulfilled") this.#ownedBundles.delete(owned[index]!);
          else
            errors.push(
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            );
        });
      }
      this.#listeners.clear();
      this.#state = {
        ...this.#state,
        lifecycle: errors.length === 0 ? "stopped" : "failed",
        running: false,
        settled: true,
        failure: errors.length
          ? { code: "dispose_failed", message: errors.join("; "), ambiguous: false }
          : undefined,
      };
      if (errors.length > 0)
        throw new AggregateError(
          errors.map((message) => new Error(message)),
          "SDK host disposal failed",
        );
    })().catch((error: unknown) => {
      this.#disposePromise = undefined;
      throw error;
    });
    return this.#disposePromise;
  }
}

export const createSdkSessionHost = (options: SdkSessionHostOptions): Promise<SessionHost> =>
  SdkSessionHost.create(options);
