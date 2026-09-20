import type { ServerResponse } from "node:http";
import {
  isServerEnvelope,
  type OperationBatchEnvelope,
  type ServerEnvelope,
} from "@dotfiles/pi-web-ui-client/wire";
import { OperationJournal } from "./journal.js";
import type { JournalMetrics } from "./metrics.js";

const MAX_QUEUED_FRAMES = 64;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const DRAIN_DEADLINE_MS = 10_000;

interface Frame {
  envelope: ServerEnvelope;
  wire: string;
  bytes: number;
  replaceable: boolean;
}

interface SseClient {
  response: ServerResponse;
  blocked: boolean;
  queue: Frame[];
  queuedBytes: number;
  closed: boolean;
  drainTimer: NodeJS.Timeout | undefined;
}

export class JournalSse {
  private readonly clients = new Set<SseClient>();
  private readonly freshnessTimer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly journal: OperationJournal,
    private readonly metrics: JournalMetrics,
    private readonly drainDeadlineMs = DRAIN_DEADLINE_MS,
  ) {
    this.unsubscribe = journal.subscribe((envelope, reason) =>
      this.broadcastEnvelope(envelope, reason),
    );
    this.freshnessTimer = setInterval(() => journal.poll(), 500);
    this.freshnessTimer.unref?.();
  }

  add(response: ServerResponse): void {
    const envelope = this.journal.snapshotEnvelope();
    const frame = envelope && this.frame(envelope, "initial");
    if (!frame || frame.bytes > MAX_FRAME_BYTES) {
      this.metrics.record("disconnect", 1, "initial-too-large");
      response.statusCode = 500;
      response.setHeader("Cache-Control", "no-store");
      response.end("Invalid or oversized snapshot\n");
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    const client: SseClient = {
      response,
      blocked: false,
      queue: [],
      queuedBytes: 0,
      closed: false,
      drainTimer: undefined,
    };
    const remove = () => this.remove(client);
    response.on("close", remove);
    response.on("error", remove);
    response.on("drain", () => this.drain(client));
    this.clients.add(client);
    this.write(client, frame);
    for (const completion of this.journal.completionEnvelopes()) {
      const completionFrame = this.frame(completion, "command-completion-replay");
      if (completionFrame) this.enqueueOrWrite(client, completionFrame);
    }
  }

  broadcast(mode: "full" | "live" = "full"): void {
    this.journal.observe(undefined, mode === "live");
  }

  reset(reason: string): void {
    this.journal.forceReset(reason);
  }

  close(): void {
    clearInterval(this.freshnessTimer);
    this.unsubscribe();
    for (const client of this.clients) {
      client.closed = true;
      this.clearDrainTimer(client);
      client.response.end();
    }
    this.clients.clear();
  }

  private broadcastEnvelope(envelope: ServerEnvelope, reason: string): void {
    const frame = this.frame(envelope, reason);
    if (!frame) return;
    for (const client of this.clients) {
      if (frame.bytes > MAX_FRAME_BYTES) this.recover(client, "frame-too-large");
      else this.enqueueOrWrite(client, frame);
    }
  }

  private frame(envelope: ServerEnvelope, reason: string): Frame | undefined {
    try {
      if (!isServerEnvelope(envelope)) return undefined;
      const started = performance.now();
      const serialized = JSON.stringify(envelope);
      this.metrics.record("serialization_ms", performance.now() - started, reason);
      const wire = `data: ${serialized}\n\n`;
      const bytes = Buffer.byteLength(wire);
      this.metrics.record("frame_bytes", bytes, reason);
      this.metrics.record("frame_count", 1, reason);
      return { envelope, wire, bytes, replaceable: replaceable(envelope) };
    } catch {
      return undefined;
    }
  }

  private enqueueOrWrite(client: SseClient, frame: Frame): void {
    if (client.closed) return;
    if (!client.blocked && client.queue.length === 0) {
      this.write(client, frame);
      return;
    }
    if (frame.replaceable && this.coalesce(client, frame)) return;
    if (this.fits(client, frame)) {
      client.queue.push(frame);
      client.queuedBytes += frame.bytes;
      return;
    }
    if (frame.replaceable) this.recover(client, "replaceable-queue-overflow");
    else this.disconnect(client, "durable-queue-overflow");
  }

  private coalesce(client: SseClient, incoming: Frame): boolean {
    const incomingEnvelope = incoming.envelope as OperationBatchEnvelope;
    let start = client.queue.length;
    while (start > 0 && client.queue[start - 1].replaceable) start -= 1;
    if (start === client.queue.length) return false;
    const candidates = [...client.queue.slice(start), incoming];
    const first = candidates[0].envelope as OperationBatchEnvelope;
    const latest = new Map<string, OperationBatchEnvelope["operations"][number]>();
    for (const candidate of candidates) {
      for (const operation of (candidate.envelope as OperationBatchEnvelope).operations) {
        latest.set(operation.kind, operation);
      }
    }
    const envelope: OperationBatchEnvelope = {
      version: 1,
      type: "operations",
      generation: incomingEnvelope.generation,
      fromRevision: first.fromRevision,
      revision: incomingEnvelope.revision,
      operations: [...latest.values()],
    };
    const merged = this.frame(envelope, "coalesced");
    if (!merged) return false;
    const removedBytes = client.queue.slice(start).reduce((sum, item) => sum + item.bytes, 0);
    const nextBytes = client.queuedBytes - removedBytes + merged.bytes;
    if (start + 1 > MAX_QUEUED_FRAMES || nextBytes > MAX_QUEUED_BYTES) return false;
    client.queue.splice(start, client.queue.length - start, merged);
    client.queuedBytes = nextBytes;
    this.metrics.record("coalesced", candidates.length - 1, "replaceable-operations");
    return true;
  }

  private recover(client: SseClient, reason: string): void {
    const envelope = this.journal.resetEnvelope(reason);
    const reset = envelope && this.frame(envelope, reason);
    if (!reset || reset.bytes > MAX_FRAME_BYTES) {
      this.disconnect(client, "reset-too-large");
      return;
    }
    client.queue = [reset];
    client.queuedBytes = reset.bytes;
    this.metrics.record("reset", 1, reason);
  }

  private fits(client: SseClient, frame: Frame): boolean {
    return (
      client.queue.length < MAX_QUEUED_FRAMES &&
      client.queuedBytes + frame.bytes <= MAX_QUEUED_BYTES
    );
  }

  private drain(client: SseClient): void {
    if (client.closed) return;
    this.clearDrainTimer(client);
    client.blocked = false;
    while (!client.blocked && client.queue.length > 0) {
      const frame = client.queue.shift()!;
      client.queuedBytes -= frame.bytes;
      this.write(client, frame);
    }
  }

  private write(client: SseClient, frame: Frame): void {
    if (client.closed) return;
    if (frame.bytes > MAX_FRAME_BYTES) {
      this.recover(client, "frame-too-large");
      return;
    }
    try {
      client.blocked = !client.response.write(frame.wire);
      if (client.blocked) this.armDrainTimer(client);
      else this.clearDrainTimer(client);
    } catch {
      this.disconnect(client, "write-error");
    }
  }

  private disconnect(client: SseClient, reason: string): void {
    if (client.closed) return;
    this.metrics.record("disconnect", 1, reason);
    client.closed = true;
    this.clearDrainTimer(client);
    this.clients.delete(client);
    client.response.destroy();
  }

  private remove(client: SseClient): void {
    client.closed = true;
    this.clearDrainTimer(client);
    client.queue = [];
    client.queuedBytes = 0;
    this.clients.delete(client);
  }

  private armDrainTimer(client: SseClient): void {
    if (client.drainTimer || client.closed) return;
    client.drainTimer = setTimeout(() => {
      client.drainTimer = undefined;
      if (client.blocked) this.disconnect(client, "drain-timeout");
    }, this.drainDeadlineMs);
    client.drainTimer.unref?.();
  }

  private clearDrainTimer(client: SseClient): void {
    if (!client.drainTimer) return;
    clearTimeout(client.drainTimer);
    client.drainTimer = undefined;
  }
}

function replaceable(envelope: ServerEnvelope): boolean {
  return (
    envelope.type === "operations" &&
    envelope.operations.every((operation) => operation.kind !== "append")
  );
}
