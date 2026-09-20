import {
  PROTOCOL_VERSION,
  isResetEnvelope,
  isServerEnvelope,
} from "@dotfiles/pi-web-ui-client/wire";
import { describe, expect, it, vi } from "vitest";
import { SSE_LIMITS, SseClient, SseConnectionSet, type SseSink } from "../../src/api/sse.ts";
import { LiveProjection, type ProjectionAttachment } from "../../src/projection/live-projection.ts";
import { FakeSessionHost } from "../fixtures/fake-session-host.ts";

class FakeSink implements SseSink {
  readonly writes: string[] = [];
  #drain = new Set<() => void>();
  #close = new Set<() => void>();
  writable = true;
  closed = false;

  write(frame: string): boolean {
    this.writes.push(frame);
    return this.writable;
  }
  onDrain(listener: () => void): () => void {
    this.#drain.add(listener);
    return () => this.#drain.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }
  close(): void {
    this.closed = true;
  }
  drain(): void {
    for (const listener of this.#drain) listener();
    this.#drain.clear();
  }
  disconnect(): void {
    for (const listener of this.#close) listener();
  }
}

const frame = (value: string) => JSON.parse(value.slice("data: ".length).trim()) as unknown;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function fixture() {
  const host = new FakeSessionHost();
  host.load({ sessionId: "session", sessionFile: "/session.jsonl" });
  const projection = await LiveProjection.create(host, "generation-1");
  return { host, projection };
}

describe("SSE clients", () => {
  it("reserves bounded daemon-wide and per-launch connection capacity", () => {
    const set = new SseConnectionSet({ daemonClients: 3, launchClients: 2 });
    const first = set.acquire("one");
    const second = set.acquire("one");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(set.acquire("one")).toBeUndefined();
    const third = set.acquire("two");
    expect(third).toBeDefined();
    expect(set.size).toBe(3);
    expect(set.acquire("three")).toBeUndefined();
    first?.release();
    expect(set.acquire("three")).toBeDefined();
    set.close();
    expect(set.size).toBe(0);
    expect(set.acquire("one")).toBeUndefined();
    expect(SSE_LIMITS.daemonClients).toBeGreaterThanOrEqual(SSE_LIMITS.launchClients);
  });

  it("writes a validated snapshot first and current completion replay after it", async () => {
    const { host, projection } = await fixture();
    host.settle("completed-before-connect");
    await tick();
    const sink = new FakeSink();
    const client = new SseClient(projection.attachment(), sink);

    expect(frame(sink.writes[0]!) as { type: string }).toMatchObject({
      type: "snapshot",
      generation: "generation-1",
      revision: 1,
    });
    expect(frame(sink.writes[1]!) as { type: string }).toMatchObject({
      type: "command-completion",
      commandId: "completed-before-connect",
    });
    expect(sink.writes.map(frame).every(isServerEnvelope)).toBe(true);
    client.close();
  });

  it("coalesces only queued replaceable operation batches and preserves revision continuity", async () => {
    const { host, projection } = await fixture();
    const sink = new FakeSink();
    sink.writable = false;
    const client = new SseClient(projection.attachment(), sink);
    host.streamMessage("one", ["a", "b", "c"]);
    await tick();

    expect(client.queuedFrames).toBe(1);
    sink.writable = true;
    sink.drain();
    const streamed = sink.writes.map(frame) as Array<{
      type: string;
      fromRevision?: number;
      revision: number;
    }>;
    const snapshot = streamed[0]!;
    const operations = streamed.at(-1)!;
    expect(operations.type).toBe("operations");
    expect(operations.fromRevision).toBe(snapshot.revision);
    expect(operations.revision).toBeGreaterThan(snapshot.revision);
    client.close();
  });

  it("recovers replaceable overflow with a client-specific current reset", async () => {
    const { projection } = await fixture();
    const base = projection.attachment();
    let emit!: Parameters<ProjectionAttachment["subscribe"]>[0];
    const attachment: ProjectionAttachment = {
      ...base,
      attach(listener) {
        emit = listener;
        return {
          initial: base.initial,
          completionReplay: [],
          unsubscribe() {},
        };
      },
    };
    const sink = new FakeSink();
    sink.writable = false;
    const client = new SseClient(attachment, sink, {
      frameBytes: 10_000,
      queuedBytes: 1_200,
    });
    emit({
      version: PROTOCOL_VERSION,
      type: "operations",
      generation: base.initial.generation,
      fromRevision: base.initial.revision,
      revision: base.initial.revision + 1,
      operations: [
        {
          kind: "live-tail",
          entries: [{ id: "large-live", payload: { text: "x".repeat(2_000) } }],
        },
      ],
    });

    expect(client.closed).toBe(false);
    expect(client.queuedFrames).toBe(1);
    sink.writable = true;
    sink.drain();
    expect(isResetEnvelope(frame(sink.writes.at(-1)!))).toBe(true);
    client.close();
  });

  it("disconnects one slow client on durable overflow or drain timeout", async () => {
    vi.useFakeTimers();
    try {
      const { host, projection } = await fixture();
      const slow = new FakeSink();
      slow.writable = false;
      const client = new SseClient(projection.attachment(), slow, {
        queuedFrames: 1,
        drainTimeoutMs: 25,
      });
      host.settle("one");
      host.settle("two");
      await vi.advanceTimersByTimeAsync(0);
      expect(client.closed).toBe(true);
      expect(slow.closed).toBe(true);

      const timeoutSink = new FakeSink();
      timeoutSink.writable = false;
      const timeoutClient = new SseClient(projection.attachment(), timeoutSink, {
        drainTimeoutMs: 25,
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(timeoutClient.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes when its projection is disposed and can serialize a client recovery reset", async () => {
    const { projection } = await fixture();
    expect(isResetEnvelope(projection.attachment().currentReset())).toBe(true);
    const sink = new FakeSink();
    const client = new SseClient(projection.attachment(), sink);
    projection.dispose();
    expect(client.closed).toBe(true);
    expect(sink.closed).toBe(true);
  });
});
