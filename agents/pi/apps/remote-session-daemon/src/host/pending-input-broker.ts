import { randomUUID } from "node:crypto";
import { LIMITS, type PendingInput } from "@dotfiles/pi-web-ui-client/wire";
import type { SessionHostImage } from "./session-host.ts";

export type BrokerDelivery = "steer" | "followUp";
const MAX_PROJECTED_CONTENT_BYTES = 32 * 1024;

export interface PendingInputRecord {
  readonly id: string;
  readonly commandId: string;
  readonly commandEpoch: string;
  readonly delivery: BrokerDelivery;
  readonly content: string;
  readonly itemVersion: number;
  readonly state: "held" | "releasing" | "handed-off";
  readonly images: readonly SessionHostImage[];
  readonly retainedBytes: number;
}

export type QueueMutation =
  | {
      readonly action: "edit";
      readonly itemId: string;
      readonly expectedItemVersion: number;
      readonly content: string;
    }
  | { readonly action: "remove"; readonly itemId: string; readonly expectedItemVersion: number };

export type QueueMutationResult =
  | { readonly status: "accepted"; readonly record?: PendingInputRecord }
  | {
      readonly status: "rejected";
      readonly reason: "stale-item" | "not-found" | "released" | "queue-busy" | "invalid";
      readonly message: string;
    };

export type QueueReleaseResult =
  | { readonly status: "none" | "busy" }
  | { readonly status: "handed-off"; readonly record: PendingInputRecord }
  | { readonly status: "failed"; readonly record: PendingInputRecord; readonly error: string };

export class PendingInputBroker {
  readonly #maxItems: number;
  readonly #maxBytes: number;
  readonly #onChange: () => void;
  readonly #items: PendingInputRecord[] = [];
  #bytes = 0;
  #releaseTask: Promise<QueueReleaseResult> | undefined;
  #epoch = 0;

  constructor(
    onChange: () => void,
    maxItems = LIMITS.maxPendingInputs,
    maxBytes = 2 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1)
      throw new RangeError("Invalid broker item bound");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("Invalid broker byte bound");
    this.#maxItems = maxItems;
    this.#maxBytes = maxBytes;
    this.#onChange = onChange;
  }

  enqueue(
    commandId: string,
    commandEpoch: string,
    delivery: BrokerDelivery,
    content: string,
    images: readonly SessionHostImage[] = [],
  ):
    | { status: "accepted"; record: PendingInputRecord }
    | { status: "rejected"; reason: "queue-busy" | "invalid"; message: string } {
    const retainedBytes = images.reduce((bytes, image) => bytes + image.byteLength, 0);
    const bytes = Buffer.byteLength(content) + retainedBytes;
    if (
      !commandId ||
      !commandEpoch ||
      content.length > LIMITS.maxInputChars ||
      Buffer.byteLength(content) > MAX_PROJECTED_CONTENT_BYTES ||
      images.length > LIMITS.maxImagesPerEntry ||
      retainedBytes > LIMITS.maxImageSourceBytesPerEntry
    )
      return { status: "rejected", reason: "invalid", message: "Pending input is invalid" };
    if (this.#items.length >= this.#maxItems || this.#bytes + bytes > this.#maxBytes)
      return {
        status: "rejected",
        reason: "queue-busy",
        message: "The pending input queue is full",
      };
    const record: PendingInputRecord = {
      id: randomUUID(),
      commandId,
      commandEpoch,
      delivery,
      content,
      itemVersion: 1,
      state: "held",
      images: structuredClone(images),
      retainedBytes,
    };
    this.#items.push(record);
    this.#bytes += bytes;
    this.#changed();
    return { status: "accepted", record };
  }

  snapshot(): PendingInput[] {
    return this.#items.map((item) => ({
      id: item.id,
      content: item.content,
      delivery: item.delivery,
      ...(item.images.length > 0 ? { attachmentCount: item.images.length } : {}),
      itemVersion: item.itemVersion,
      editable: item.state === "held",
      state: item.state === "releasing" ? "releasing" : "held",
    }));
  }

  nativeQueue(items: readonly PendingInput[]): PendingInput[] {
    return items.map((item) => ({ ...item, editable: false }));
  }

  mutate(mutation: QueueMutation): QueueMutationResult {
    const index = this.#items.findIndex((item) => item.id === mutation.itemId);
    if (index < 0)
      return { status: "rejected", reason: "not-found", message: "Pending input was not found" };
    const current = this.#items[index]!;
    if (current.state !== "held")
      return {
        status: "rejected",
        reason: "released",
        message: "Pending input is being handed to Pi",
      };
    if (current.itemVersion !== mutation.expectedItemVersion)
      return {
        status: "rejected",
        reason: "stale-item",
        message: "Pending input changed; retry after review",
      };
    if (mutation.action === "remove") {
      this.#items.splice(index, 1);
      this.#bytes -= Buffer.byteLength(current.content) + current.retainedBytes;
      this.#changed();
      return { status: "accepted", record: current };
    }
    if (
      mutation.content.length > LIMITS.maxInputChars ||
      Buffer.byteLength(mutation.content) > MAX_PROJECTED_CONTENT_BYTES
    )
      return { status: "rejected", reason: "invalid", message: "Pending input is too long" };
    const nextBytes =
      this.#bytes + Buffer.byteLength(mutation.content) - Buffer.byteLength(current.content);
    if (nextBytes > this.#maxBytes)
      return {
        status: "rejected",
        reason: "queue-busy",
        message: "The pending input queue is full",
      };
    const updated = { ...current, content: mutation.content, itemVersion: current.itemVersion + 1 };
    this.#items[index] = updated;
    this.#bytes += Buffer.byteLength(mutation.content) - Buffer.byteLength(current.content);
    this.#changed();
    return { status: "accepted", record: updated };
  }

  async releaseNext(
    delivery: BrokerDelivery,
    handoff: (
      content: string,
      delivery: BrokerDelivery,
      images: readonly SessionHostImage[],
    ) => void | Promise<void>,
  ): Promise<QueueReleaseResult> {
    if (this.#releaseTask) {
      await this.#releaseTask;
      return this.releaseNext(delivery, handoff);
    }
    const index = this.#items.findIndex((item) => item.state === "held");
    if (index < 0 || this.#items[index]!.delivery !== delivery) return { status: "none" };
    const previous = this.#items[index]!;
    const releasing = { ...previous, state: "releasing" as const };
    this.#items[index] = releasing;
    this.#changed();
    const epoch = this.#epoch;
    const task = (async (): Promise<QueueReleaseResult> => {
      try {
        await handoff(releasing.content, delivery, releasing.images);
        const handedOff = { ...releasing, state: "handed-off" as const };
        if (epoch === this.#epoch) {
          const currentIndex = this.#items.findIndex((item) => item.id === releasing.id);
          if (currentIndex >= 0) {
            this.#items[currentIndex] = handedOff;
            this.#changed();
            this.#items.splice(currentIndex, 1);
            this.#bytes -= Buffer.byteLength(releasing.content) + releasing.retainedBytes;
            this.#changed();
          }
        }
        return { status: "handed-off", record: handedOff };
      } catch (error) {
        if (epoch === this.#epoch) {
          const currentIndex = this.#items.findIndex((item) => item.id === releasing.id);
          if (currentIndex >= 0) {
            this.#items[currentIndex] = previous;
            this.#changed();
          }
        }
        return {
          status: "failed",
          record: releasing,
          error: error instanceof Error ? error.message : "Pending input handoff failed",
        };
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
    this.#bytes = 0;
    if (discarded.length > 0) this.#changed();
    return discarded;
  }

  #changed(): void {
    this.#onChange();
  }
}
