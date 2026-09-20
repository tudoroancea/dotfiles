import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import {
  isOperationBatchEnvelope,
  isServerEnvelope,
  type OperationBatchEnvelope,
  type ServerEnvelope,
  type SessionOperation,
} from "@dotfiles/pi-web-ui-client/wire";
import type { ProjectionAttachment } from "../projection/live-projection.ts";

export const SSE_LIMITS = Object.freeze({
  frameBytes: 2 * 1024 * 1024 + 256,
  queuedFrames: 256,
  queuedBytes: 4 * 1024 * 1024,
  drainTimeoutMs: 15_000,
  daemonClients: 64,
  launchClients: 8,
});

export interface SseSink {
  write(frame: string): boolean;
  onDrain(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface SseClientLimits {
  frameBytes: number;
  queuedFrames: number;
  queuedBytes: number;
  drainTimeoutMs: number;
}

interface SerializedFrame {
  readonly envelope: ServerEnvelope;
  readonly encoded: string;
  readonly bytes: number;
  readonly replaceable: boolean;
}

function serialize(envelope: ServerEnvelope, frameBytes: number): SerializedFrame {
  if (!isServerEnvelope(envelope)) throw new Error("Invalid shared SSE envelope");
  const encoded = `data: ${JSON.stringify(envelope)}\n\n`;
  const bytes = Buffer.byteLength(encoded);
  if (bytes > frameBytes) throw new RangeError("SSE frame exceeds its byte limit");
  return {
    envelope,
    encoded,
    bytes,
    replaceable:
      isOperationBatchEnvelope(envelope) &&
      envelope.operations.every((operation) => operation.kind !== "append"),
  };
}

function coalesce(
  left: SerializedFrame,
  right: SerializedFrame,
  frameBytes: number,
): SerializedFrame | undefined {
  if (!left.replaceable || !right.replaceable) return undefined;
  const first = left.envelope as OperationBatchEnvelope;
  const second = right.envelope as OperationBatchEnvelope;
  if (first.generation !== second.generation || first.revision !== second.fromRevision)
    return undefined;
  const latest = new Map<SessionOperation["kind"], SessionOperation>();
  for (const operation of [...first.operations, ...second.operations])
    latest.set(operation.kind, operation);
  return serialize(
    {
      version: first.version,
      type: "operations",
      generation: first.generation,
      fromRevision: first.fromRevision,
      revision: second.revision,
      operations: [...latest.values()],
    },
    frameBytes,
  );
}

export class NodeSseSink implements SseSink {
  readonly #response: ServerResponse;

  constructor(response: ServerResponse) {
    this.#response = response;
  }

  write(frame: string): boolean {
    return this.#response.write(frame);
  }

  onDrain(listener: () => void): () => void {
    this.#response.once("drain", listener);
    return () => this.#response.off("drain", listener);
  }

  onClose(listener: () => void): () => void {
    this.#response.once("close", listener);
    return () => this.#response.off("close", listener);
  }

  close(): void {
    if (!this.#response.destroyed) this.#response.destroy();
    if (this.#response.socket && !this.#response.socket.destroyed) this.#response.socket.destroy();
  }
}

export class SseClient {
  readonly #attachment: ProjectionAttachment;
  readonly #sink: SseSink;
  readonly #limits: SseClientLimits;
  readonly #onClosed?: () => void;
  readonly #queue: SerializedFrame[] = [];
  #queuedBytes = 0;
  #draining = false;
  #closed = false;
  #drainTimer?: ReturnType<typeof setTimeout>;
  #removeDrain?: () => void;
  #removeSinkClose?: () => void;
  #unsubscribe?: () => void;
  #stateGeneration?: string;
  #stateRevision?: number;

  constructor(
    attachment: ProjectionAttachment,
    sink: SseSink,
    options: Partial<SseClientLimits> & { onClosed?: () => void } = {},
  ) {
    this.#attachment = attachment;
    this.#sink = sink;
    this.#limits = {
      frameBytes: options.frameBytes ?? SSE_LIMITS.frameBytes,
      queuedFrames: options.queuedFrames ?? SSE_LIMITS.queuedFrames,
      queuedBytes: options.queuedBytes ?? SSE_LIMITS.queuedBytes,
      drainTimeoutMs: options.drainTimeoutMs ?? SSE_LIMITS.drainTimeoutMs,
    };
    if (
      !Number.isSafeInteger(this.#limits.frameBytes) ||
      this.#limits.frameBytes < 1 ||
      this.#limits.frameBytes > SSE_LIMITS.frameBytes ||
      !Number.isSafeInteger(this.#limits.queuedFrames) ||
      this.#limits.queuedFrames < 1 ||
      this.#limits.queuedFrames > SSE_LIMITS.queuedFrames ||
      !Number.isSafeInteger(this.#limits.queuedBytes) ||
      this.#limits.queuedBytes < 1 ||
      this.#limits.queuedBytes > SSE_LIMITS.queuedBytes ||
      !Number.isSafeInteger(this.#limits.drainTimeoutMs) ||
      this.#limits.drainTimeoutMs < 1 ||
      this.#limits.drainTimeoutMs > SSE_LIMITS.drainTimeoutMs
    )
      throw new RangeError("SSE client limits are invalid");
    this.#onClosed = options.onClosed;
    this.#removeSinkClose = sink.onClose(() => this.close());
    try {
      const attached = attachment.attach(
        (envelope) => this.#receive(envelope),
        () => this.close(),
      );
      this.#unsubscribe = attached.unsubscribe;
      this.#enqueue(serialize(attached.initial, this.#limits.frameBytes));
      for (const completion of attached.completionReplay)
        this.#enqueue(serialize(completion, this.#limits.frameBytes));
    } catch {
      this.close();
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get queuedFrames(): number {
    return this.#queue.length;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#drainTimer) clearTimeout(this.#drainTimer);
    this.#drainTimer = undefined;
    this.#removeDrain?.();
    this.#removeDrain = undefined;
    this.#removeSinkClose?.();
    this.#removeSinkClose = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#sink.close();
    this.#onClosed?.();
  }

  #receive(envelope: ServerEnvelope): void {
    if (this.#closed) return;
    try {
      this.#enqueue(serialize(envelope, this.#limits.frameBytes));
    } catch {
      if (
        isOperationBatchEnvelope(envelope) &&
        envelope.operations.every((op) => op.kind !== "append")
      )
        this.#recover();
      else this.close();
    }
  }

  #enqueue(frame: SerializedFrame): void {
    if (this.#closed) return;
    if (
      isOperationBatchEnvelope(frame.envelope) &&
      (frame.envelope.generation !== this.#stateGeneration ||
        frame.envelope.fromRevision !== this.#stateRevision)
    )
      return this.#recover();
    const tail = this.#queue.at(-1);
    if (tail) {
      let merged: SerializedFrame | undefined;
      try {
        merged = coalesce(tail, frame, this.#limits.frameBytes);
      } catch {
        if (frame.replaceable) return this.#recover();
        return this.close();
      }
      if (merged) {
        this.#queue[this.#queue.length - 1] = merged;
        this.#queuedBytes += merged.bytes - tail.bytes;
        this.#recordState(merged.envelope);
        if (this.#overLimit()) this.#recover();
        return;
      }
    }
    this.#queue.push(frame);
    this.#queuedBytes += frame.bytes;
    this.#recordState(frame.envelope);
    if (this.#overLimit()) {
      if (frame.replaceable) this.#recover();
      else this.close();
      return;
    }
    this.#pump();
  }

  #overLimit(): boolean {
    return (
      this.#queue.length > this.#limits.queuedFrames || this.#queuedBytes > this.#limits.queuedBytes
    );
  }

  #recover(): void {
    if (this.#closed) return;
    while (this.#queue.at(-1)?.replaceable) {
      const removed = this.#queue.pop()!;
      this.#queuedBytes -= removed.bytes;
    }
    try {
      const reset = serialize(
        this.#attachment.currentReset("slow client stream continuity recovery"),
        this.#limits.frameBytes,
      );
      this.#queue.push(reset);
      this.#queuedBytes += reset.bytes;
      this.#recordState(reset.envelope);
      if (this.#overLimit()) return this.close();
      this.#pump();
    } catch {
      this.close();
    }
  }

  #recordState(envelope: ServerEnvelope): void {
    if (
      envelope.type === "snapshot" ||
      envelope.type === "reset" ||
      envelope.type === "operations"
    ) {
      this.#stateGeneration = envelope.generation;
      this.#stateRevision = envelope.revision;
    }
  }

  #pump(): void {
    if (this.#closed || this.#draining) return;
    while (this.#queue.length > 0) {
      const frame = this.#queue.shift()!;
      this.#queuedBytes -= frame.bytes;
      let accepted: boolean;
      try {
        accepted = this.#sink.write(frame.encoded);
      } catch {
        this.close();
        return;
      }
      if (!accepted) {
        this.#draining = true;
        const drained = () => {
          if (this.#closed) return;
          this.#draining = false;
          if (this.#drainTimer) clearTimeout(this.#drainTimer);
          this.#drainTimer = undefined;
          this.#removeDrain = undefined;
          this.#pump();
        };
        this.#removeDrain = this.#sink.onDrain(drained);
        this.#drainTimer = setTimeout(() => this.close(), this.#limits.drainTimeoutMs);
        this.#drainTimer.unref?.();
        return;
      }
    }
  }
}

export interface SseAdmission {
  open(attachment: ProjectionAttachment, response: ServerResponse): SseClient;
  release(): void;
}

export class SseConnectionSet {
  readonly #clients = new Set<SseClient>();
  readonly #perLaunch = new Map<string, number>();
  readonly #pendingReleases = new Set<() => void>();
  readonly #daemonLimit: number;
  readonly #launchLimit: number;
  #reservations = 0;
  #closed = false;

  constructor(limits: { daemonClients?: number; launchClients?: number } = {}) {
    this.#daemonLimit = limits.daemonClients ?? SSE_LIMITS.daemonClients;
    this.#launchLimit = limits.launchClients ?? SSE_LIMITS.launchClients;
    if (
      !Number.isSafeInteger(this.#daemonLimit) ||
      this.#daemonLimit < 1 ||
      this.#daemonLimit > SSE_LIMITS.daemonClients ||
      !Number.isSafeInteger(this.#launchLimit) ||
      this.#launchLimit < 1 ||
      this.#launchLimit > SSE_LIMITS.launchClients ||
      this.#launchLimit > this.#daemonLimit
    )
      throw new RangeError("SSE connection limits are invalid");
  }

  get size(): number {
    return this.#reservations;
  }

  acquire(launchId: string): SseAdmission | undefined {
    if (
      this.#closed ||
      this.#reservations >= this.#daemonLimit ||
      (this.#perLaunch.get(launchId) ?? 0) >= this.#launchLimit
    )
      return undefined;
    this.#reservations += 1;
    this.#perLaunch.set(launchId, (this.#perLaunch.get(launchId) ?? 0) + 1);
    let released = false;
    let opened = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#reservations -= 1;
      const remaining = (this.#perLaunch.get(launchId) ?? 1) - 1;
      if (remaining === 0) this.#perLaunch.delete(launchId);
      else this.#perLaunch.set(launchId, remaining);
      this.#pendingReleases.delete(release);
    };
    this.#pendingReleases.add(release);
    return {
      open: (attachment, response) => {
        if (released || opened || this.#closed) {
          release();
          throw new Error("SSE admission is no longer active");
        }
        opened = true;
        this.#pendingReleases.delete(release);
        let client!: SseClient;
        client = new SseClient(attachment, new NodeSseSink(response), {
          onClosed: () => {
            this.#clients.delete(client);
            release();
          },
        });
        if (!client.closed) this.#clients.add(client);
        return client;
      },
      release,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const release of this.#pendingReleases) release();
    for (const client of this.#clients) client.close();
    this.#clients.clear();
  }
}
