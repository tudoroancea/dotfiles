import { randomBytes } from "node:crypto";
import { LIMITS, type InputDelivery, type PendingInput } from "@dotfiles/pi-web-ui-client/wire";

export type BrokerDelivery = Exclude<InputDelivery, "immediate">;

/** The public Pi extension API accepts this text/image shape for user messages. */
export type BrokerPayload =
  | string
  | readonly (
      | { readonly type: "text"; readonly text: string }
      | { readonly type: "image"; readonly data: string; readonly mimeType: string }
    )[];

export interface PendingInputRecord {
  readonly id: string;
  readonly commandId: string;
  readonly commandEpoch: string;
  readonly delivery: BrokerDelivery;
  readonly content: string;
  readonly itemVersion: number;
  readonly attachmentCount: number;
  readonly retainedBytes: number;
  readonly payload: BrokerPayload;
  readonly state: "held" | "releasing" | "handed-off";
}

export type BrokerMutation =
  | {
      readonly action: "edit";
      readonly itemId: string;
      readonly expectedItemVersion: number;
      readonly content: string;
    }
  | { readonly action: "remove"; readonly itemId: string; readonly expectedItemVersion: number };

export type BrokerMutationResult =
  | { readonly status: "accepted"; readonly record?: PendingInputRecord }
  | {
      readonly status: "rejected";
      readonly reason: "stale-item" | "not-found" | "released" | "queue-busy" | "invalid";
      readonly message: string;
    };

export type BrokerReleaseResult =
  | { readonly status: "none" | "busy" }
  | { readonly status: "handed-off"; readonly record: PendingInputRecord }
  | { readonly status: "failed"; readonly record: PendingInputRecord; readonly error: string };

export interface PendingInputBrokerOptions<TPayload extends BrokerPayload> {
  maxItems?: number;
  maxRetainedBytes?: number;
  idFactory?: () => string;
  replacePayloadText?: (payload: TPayload, content: string) => TPayload;
  onChange?: () => void;
}

export interface EnqueueInput<TPayload extends BrokerPayload> {
  commandId: string;
  commandEpoch: string;
  delivery: BrokerDelivery;
  content: string;
  attachmentCount?: number;
  retainedBytes?: number;
  payload: TPayload;
}

const DEFAULT_MAX_RETAINED_BYTES = 2 * LIMITS.maxImageSourceBytesPerEntry;

/**
 * Ordered, session-scoped ownership for browser-originated busy messages.
 *
 * The payload is deliberately not part of the browser DTO. It remains here until
 * the release callback hands it to Pi, so editing text never reconstructs or drops
 * image content. Native Pi/TUI queue entries never enter this model.
 */
export class PendingInputBroker<TPayload extends BrokerPayload = BrokerPayload> {
  readonly #maxItems: number;
  readonly #maxRetainedBytes: number;
  readonly #idFactory: () => string;
  readonly #replacePayloadText: (payload: TPayload, content: string) => TPayload;
  readonly #onChange?: () => void;
  readonly #items: PendingInputRecord[] = [];
  #retainedBytes = 0;
  #releaseTask: Promise<BrokerReleaseResult> | undefined;
  #epoch = 0;

  constructor(options: PendingInputBrokerOptions<TPayload> = {}) {
    this.#maxItems = options.maxItems ?? LIMITS.maxPendingInputs;
    this.#maxRetainedBytes = options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
    this.#idFactory = options.idFactory ?? (() => randomBytes(12).toString("base64url"));
    this.#replacePayloadText =
      options.replacePayloadText ??
      (((payload) => payload) as (payload: TPayload, content: string) => TPayload);
    this.#onChange = options.onChange;
    if (!Number.isSafeInteger(this.#maxItems) || this.#maxItems < 1) {
      throw new RangeError("Broker item bound is invalid");
    }
    if (!Number.isSafeInteger(this.#maxRetainedBytes) || this.#maxRetainedBytes < 1) {
      throw new RangeError("Broker memory bound is invalid");
    }
  }

  get size(): number {
    return this.#items.length;
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  enqueue(
    input: EnqueueInput<TPayload>,
  ):
    | { status: "accepted"; record: PendingInputRecord }
    | { status: "rejected"; reason: "queue-busy" | "invalid"; message: string } {
    if (
      !input.commandId ||
      !input.commandEpoch ||
      input.content.length > LIMITS.maxInputChars ||
      (input.attachmentCount ?? 0) < 0 ||
      (input.attachmentCount ?? 0) > LIMITS.maxImagesPerEntry
    ) {
      return { status: "rejected", reason: "invalid", message: "Pending input is invalid" };
    }
    const attachmentCount = input.attachmentCount ?? 0;
    const retainedBytes = input.retainedBytes ?? 0;
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) {
      return { status: "rejected", reason: "invalid", message: "Pending payload size is invalid" };
    }
    if (
      this.#items.length >= this.#maxItems ||
      this.#retainedBytes + retainedBytes > this.#maxRetainedBytes
    ) {
      return {
        status: "rejected",
        reason: "queue-busy",
        message: "The pending input queue is full",
      };
    }
    const record: PendingInputRecord = {
      id: this.#idFactory(),
      commandId: input.commandId,
      commandEpoch: input.commandEpoch,
      delivery: input.delivery,
      content: input.content,
      itemVersion: 1,
      attachmentCount,
      retainedBytes,
      payload: input.payload,
      state: "held",
    };
    this.#items.push(record);
    this.#retainedBytes += retainedBytes;
    this.#changed();
    return { status: "accepted", record };
  }

  snapshot(): PendingInput[] {
    return this.#items.map((item) => ({
      id: item.id,
      content: item.content,
      delivery: item.delivery,
      ...(item.attachmentCount > 0 ? { attachmentCount: item.attachmentCount } : {}),
      itemVersion: item.itemVersion,
      editable: item.state === "held",
      state: item.state === "releasing" ? "releasing" : "held",
    }));
  }

  records(): readonly PendingInputRecord[] {
    return this.#items.map((item) => ({ ...item }));
  }

  mutate(mutation: BrokerMutation): BrokerMutationResult {
    const index = this.#items.findIndex((item) => item.id === mutation.itemId);
    if (index < 0) {
      return { status: "rejected", reason: "not-found", message: "Pending input was not found" };
    }
    const item = this.#items[index]!;
    if (item.state !== "held") {
      return {
        status: "rejected",
        reason: "released",
        message: "Pending input is being handed to Pi",
      };
    }
    if (item.itemVersion !== mutation.expectedItemVersion) {
      return {
        status: "rejected",
        reason: "stale-item",
        message: "Pending input changed; reload and retry",
      };
    }
    if (mutation.action === "remove") {
      this.#items.splice(index, 1);
      this.#retainedBytes -= item.retainedBytes;
      this.#changed();
      return { status: "accepted", record: item };
    }
    if (mutation.content.length > LIMITS.maxInputChars) {
      return { status: "rejected", reason: "invalid", message: "Pending input is too long" };
    }
    const updated: PendingInputRecord = {
      ...item,
      content: mutation.content,
      itemVersion: item.itemVersion + 1,
      payload: this.#replacePayloadText(item.payload as TPayload, mutation.content),
    };
    this.#items[index] = updated;
    this.#changed();
    return { status: "accepted", record: updated };
  }

  async releaseNext(
    delivery: BrokerDelivery,
    handoff: (
      payload: TPayload,
      delivery: BrokerDelivery,
      record: PendingInputRecord,
    ) => void | Promise<void>,
  ): Promise<BrokerReleaseResult> {
    if (this.#releaseTask) {
      await this.#releaseTask;
      return this.releaseNext(delivery, handoff);
    }
    const index = this.#items.findIndex((item) => item.state === "held");
    if (index < 0 || this.#items[index]!.delivery !== delivery) return { status: "none" };
    const previous = this.#items[index]!;
    const releasing: PendingInputRecord = { ...previous, state: "releasing" };
    this.#items[index] = releasing;
    this.#changed();
    const epoch = this.#epoch;
    const task = (async (): Promise<BrokerReleaseResult> => {
      try {
        await handoff(releasing.payload as TPayload, delivery, releasing);
        const handedOff = { ...releasing, state: "handed-off" as const };
        if (epoch !== this.#epoch) return { status: "handed-off", record: handedOff };
        const currentIndex = this.#items.findIndex((item) => item.id === releasing.id);
        if (currentIndex >= 0 && this.#items[currentIndex]!.state === "releasing") {
          this.#items[currentIndex] = handedOff;
          this.#changed();
          this.#items.splice(currentIndex, 1);
          this.#retainedBytes -= releasing.retainedBytes;
          this.#changed();
        }
        return { status: "handed-off", record: handedOff };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Pi did not accept the pending input";
        const currentIndex = this.#items.findIndex((item) => item.id === releasing.id);
        if (epoch === this.#epoch && currentIndex >= 0) {
          this.#items[currentIndex] = { ...previous, state: "held" };
          this.#changed();
        }
        return { status: "failed", record: releasing, error: message };
      }
    })();
    this.#releaseTask = task;
    try {
      return await task;
    } finally {
      if (this.#releaseTask === task) this.#releaseTask = undefined;
    }
  }

  reset(): PendingInputRecord[] {
    this.#epoch += 1;
    const discarded = this.#items.splice(0, this.#items.length);
    this.#retainedBytes = 0;
    if (discarded.length > 0) this.#changed();
    return discarded;
  }

  #changed(): void {
    this.#onChange?.();
  }
}

/** Replace only text parts while retaining every image part byte-for-byte. */
export function replaceBrokerPayloadText(payload: BrokerPayload, content: string): BrokerPayload {
  if (typeof payload === "string") return content;
  const images = payload.filter((part) => part.type === "image");
  return content ? [{ type: "text", text: content }, ...images] : images;
}
