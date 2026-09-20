import { describe, expect, it } from "vitest";
import {
  applyOperationBatch,
  createSessionState,
} from "../../../../packages/pi-web-ui-client/src/client/session-state.ts";
import { indexBoundedTranscript } from "../../../../packages/pi-web-ui-client/src/client/transcript-index.ts";
import {
  isOperationBatchEnvelope,
  isResetEnvelope,
  isServerEnvelope,
  isSessionSnapshotEnvelope,
} from "@dotfiles/pi-web-ui-client/wire";
import {
  LiveProjection,
  PROJECTION_LIMITS,
  type ProjectionAttachment,
} from "../../src/projection/live-projection.ts";
import type { HistoryEntry } from "../../src/host/session-host.ts";
import { FakeSessionHost } from "../fixtures/fake-session-host.ts";

const entry = (
  id: string,
  parentId: string | null,
  data: unknown = { type: "message", text: id },
): HistoryEntry => ({
  id,
  parentId,
  type: "message",
  timestamp: 1,
  data,
});

async function ready(history: HistoryEntry[] = []) {
  const host = new FakeSessionHost({ history });
  host.load({ sessionId: "session", sessionFile: "/session.jsonl" });
  const projection = await LiveProjection.create(host, "generation-1");
  return { host, projection };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("live projection", () => {
  it("starts with the chronological latest active-branch window and shared epochs", async () => {
    const history = Array.from({ length: PROJECTION_LIMITS.snapshotEntries + 5 }, (_, index) =>
      entry(`entry-${index}`, index ? `entry-${index - 1}` : null),
    );
    const { projection } = await ready(history);
    const snapshot = projection.attachment().initial;
    expect(isSessionSnapshotEnvelope(snapshot)).toBe(true);
    expect(snapshot.generation).toBe("generation-1");
    expect(snapshot.snapshot.commandEpoch).toBe("session-1");
    expect(snapshot.snapshot.entries).toHaveLength(PROJECTION_LIMITS.snapshotEntries);
    expect(snapshot.snapshot.entries[0]?.id).toBe("entry-5");
    expect(snapshot.snapshot.entries.at(-1)?.id).toBe(`entry-${history.length - 1}`);
    expect(snapshot.snapshot.history.hasMore).toBe(true);
  });

  it("projects schema-valid model controls and authoritative model metadata", async () => {
    const host = new FakeSessionHost({
      modelControl: {
        models: [{ provider: "provider", id: "model", name: "Model" }],
        thinkingLevels: ["off", "max"],
      },
    });
    host.load({ sessionId: "session", sessionFile: "/session.jsonl" });
    const projection = await LiveProjection.create(host, "generation-1");
    const initial = projection.attachment().initial;
    expect(isSessionSnapshotEnvelope(initial)).toBe(true);
    expect(initial.snapshot.modelControl).toEqual({
      models: [{ provider: "provider", id: "model", name: "Model" }],
      thinkingLevels: ["off", "max"],
    });
    let transition = createSessionState(initial);
    projection.attachment().subscribe((envelope) => {
      if (envelope.type === "operations" && transition.status === "applied")
        transition = applyOperationBatch(transition.state, envelope);
    });
    expect(
      transition.status === "applied" && transition.state.snapshot.metadata?.model,
    ).toBeUndefined();
    await host.command({
      type: "set_model",
      commandId: "model-command",
      provider: "provider",
      model: "model",
    });
    expect(transition.status).toBe("applied");
    if (transition.status === "applied")
      expect(transition.state.snapshot.metadata?.model).toEqual({
        provider: "provider",
        id: "model",
        name: "model",
      });
  });

  it("publishes bounded stable live overlays, then appends durable entries exactly once on settled", async () => {
    const { host, projection } = await ready([entry("one", null)]);
    const envelopes: Parameters<Parameters<ProjectionAttachment["subscribe"]>[0]>[0][] = [];
    projection.attachment().subscribe((envelope) => envelopes.push(envelope));
    host.streamMessage("command", ["hello", " world"], { id: "tool-1", name: "read" });
    await tick();
    const live = envelopes
      .filter((envelope) => envelope.type === "operations")
      .flatMap((envelope) => envelope.operations)
      .filter((operation) => operation.kind === "live-tail");
    expect(live.length).toBeGreaterThan(0);
    expect(new Set(live.flatMap((operation) => operation.entries.map(({ id }) => id)))).toEqual(
      new Set(["message:message-command", "tool-call:tool-1", "tool-result:tool-1"]),
    );
    expect(envelopes.every(isServerEnvelope)).toBe(true);
    host.streamMessage("oversized", ["x".repeat(PROJECTION_LIMITS.liveValueBytes + 1)]);
    await tick();
    const oversizedLive = envelopes
      .filter(isOperationBatchEnvelope)
      .flatMap(({ operations }) => operations)
      .filter((operation) => operation.kind === "live-tail")
      .find((operation) =>
        operation.entries.some(
          ({ payload }) =>
            JSON.stringify(payload) ===
            JSON.stringify({ type: "projection_placeholder", reason: "oversized" }),
        ),
      );
    expect(oversizedLive?.entries.at(-1)?.payload).toEqual({
      type: "projection_placeholder",
      reason: "oversized",
    });

    host.appendHistory(entry("two", "one"));
    host.settle("command");
    await tick();
    await projection.settled();
    host.settle("command");
    await tick();
    await projection.settled();
    const appends = envelopes
      .filter(isOperationBatchEnvelope)
      .flatMap(({ operations }) => operations)
      .filter((operation) => operation.kind === "append");
    expect(appends).toHaveLength(1);
    expect(appends[0]?.entries.map(({ id }) => id)).toEqual(["two"]);
    const running = envelopes
      .filter(isOperationBatchEnvelope)
      .flatMap(({ operations }) => operations)
      .filter((operation) => operation.kind === "running");
    expect(running.at(-1)).toEqual({ kind: "running", running: { isRunning: false } });
  });

  it("emits Pi-shaped live messages and tool results accepted by the shared reducer and transcript index", async () => {
    const { host, projection } = await ready();
    let transition = createSessionState(projection.attachment().initial);
    expect(transition.status).toBe("applied");
    let state = transition.status === "applied" ? transition.state : undefined;
    projection.attachment().subscribe((envelope) => {
      if (envelope.type !== "operations" || !state) return;
      transition = applyOperationBatch(state, envelope);
      if (transition.status === "applied") state = transition.state;
    });

    host.streamMessage("visible", ["assistant text"], { id: "call", name: "read" });
    expect(state).toBeDefined();
    const indexed = indexBoundedTranscript(state!.snapshot.liveTail, "l", false);
    expect(indexed.rows.map(({ id }) => id)).toEqual(["message:message-visible", "tool-call:call"]);
    expect(indexed.toolResults.get("call")).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "done" }],
    });
    const assistant = indexed.rows[0]?.payload as Record<string, unknown>;
    expect(assistant).toMatchObject({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "assistant text" }] },
    });
  });

  it("keeps live-text overflow sticky until durable reconciliation", async () => {
    const { host, projection } = await ready();
    host.streamMessage("oversized", ["x".repeat(PROJECTION_LIMITS.liveValueBytes + 1), "small"]);
    expect(projection.attachment().initial.snapshot.liveTail.at(-1)?.payload).toEqual({
      type: "projection_placeholder",
      reason: "oversized",
    });
    host.settle("oversized");
    await tick();
    await projection.settled();
    expect(projection.attachment().initial.snapshot.liveTail).toEqual([]);
  });

  it("bounds synchronous subscriber fanout without queued microtasks", async () => {
    const { host, projection } = await ready();
    let calls = 0;
    for (let index = 0; index < PROJECTION_LIMITS.subscribers; index += 1)
      projection.attachment().subscribe(() => (calls += 1));
    expect(() => projection.attachment().subscribe(() => undefined)).toThrow(/capacity/);
    host.streamMessage("burst", ["a", "b", "c"]);
    expect(calls).toBeGreaterThan(0);
  });

  it("appends a verified shifted latest-window overlap and keeps reconnect equal to shared reduction", async () => {
    const history = Array.from({ length: PROJECTION_LIMITS.snapshotEntries }, (_, index) =>
      entry(`entry-${index}`, index ? `entry-${index - 1}` : null),
    );
    const { host, projection } = await ready(history);
    const initial = projection.attachment().initial;
    let reduced = createSessionState(initial);
    const envelopes: Parameters<Parameters<ProjectionAttachment["subscribe"]>[0]>[0][] = [];
    projection.attachment().subscribe((envelope) => {
      envelopes.push(envelope);
      if (envelope.type === "operations" && reduced.status === "applied")
        reduced = applyOperationBatch(reduced.state, envelope);
    });
    host.appendHistory(entry(`entry-${history.length}`, `entry-${history.length - 1}`));
    host.settle("shifted");
    await tick();
    await projection.settled();
    host.settle("shifted-again");
    await tick();
    await projection.settled();

    expect(envelopes.some((envelope) => envelope.type === "reset")).toBe(true);
    const reconnect = projection.attachment().initial.snapshot;
    expect(reconnect.leafId).toBe(`entry-${history.length}`);
    expect(reconnect.entries).toHaveLength(PROJECTION_LIMITS.snapshotEntries);
    expect(reconnect.history.oldestEntryId).toBe("entry-1");
  });

  it("resets to a bounded latest window before cumulative append growth can diverge", async () => {
    const payload = { type: "message", text: "x".repeat(30_000) };
    const history = Array.from({ length: 40 }, (_, index) =>
      entry(`large-${index}`, index ? `large-${index - 1}` : null, payload),
    );
    const { host, projection } = await ready(history);
    const envelopes: Parameters<Parameters<ProjectionAttachment["subscribe"]>[0]>[0][] = [];
    projection.attachment().subscribe((envelope) => envelopes.push(envelope));
    for (let index = 40; index < 80; index += 1) {
      host.appendHistory(entry(`large-${index}`, `large-${index - 1}`, payload));
      host.settle(`command-${index}`);
      await tick();
      await projection.settled();
    }
    const reconnect = projection.attachment().initial;
    expect(envelopes.some(isResetEnvelope)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(reconnect))).toBeLessThanOrEqual(
      PROJECTION_LIMITS.snapshotBytes,
    );
    expect(reconnect.snapshot.leafId).toBe("large-79");
    expect(reconnect.revision).toBeGreaterThan(0);
  });

  it("does not apply stale settled cleanup when a new run starts during reconciliation", async () => {
    const { host, projection } = await ready([entry("one", null)]);
    const originalRead = host.projectionRead.bind(host);
    let release!: () => void;
    let blockNext = false;
    host.projectionRead = async (request) => {
      const read = await originalRead(request);
      if (blockNext) {
        blockNext = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return read;
    };
    blockNext = true;
    host.appendHistory(entry("two", "one"));
    host.settle("old-run");
    await tick();
    await host.command({ type: "prompt", commandId: "new-run", text: "continue" });
    host.streamMessage("new-run", ["still live"]);
    release();
    await projection.settled();
    const snapshot = projection.attachment().initial.snapshot;
    expect(snapshot.running.isRunning).toBe(true);
  });

  it("reconciles durable changes immediately while the host remains idle", async () => {
    const { host, projection } = await ready([entry("one", null)]);
    host.appendHistory(entry("custom", "one", { type: "custom", value: true }));
    host.durableChange();
    await projection.settled();
    expect(projection.attachment().initial.snapshot.entries.map(({ id }) => id)).toEqual([
      "one",
      "custom",
    ]);
  });

  it("resets on continuity loss and uses explicit placeholders", async () => {
    const oversized = "x".repeat(PROJECTION_LIMITS.entryBytes + 1);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const { host, projection } = await ready([
      entry("one", null, oversized),
      entry("two", "one", circular),
    ]);
    const payloads = projection.attachment().initial.snapshot.entries.map(({ payload }) => payload);
    expect(payloads).toContainEqual({ type: "projection_placeholder", reason: "oversized" });
    expect(JSON.stringify(payloads)).toContain("Circular");

    const envelopes: unknown[] = [];
    projection.attachment().subscribe((envelope) => envelopes.push(envelope));
    host.replaceHistory([entry("branch", null)]);
    host.settle("command");
    await tick();
    await projection.settled();
    expect(envelopes.some(isResetEnvelope)).toBe(true);
    expect(envelopes.every(isServerEnvelope)).toBe(true);
  });

  it("contains synchronous projection failures and closes attachments through the fatal callback", async () => {
    const host = new FakeSessionHost();
    host.load({ sessionId: "session", sessionFile: "/session.jsonl" });
    let dispatch: Parameters<typeof host.subscribe>[0] | undefined;
    host.subscribe = (listener) => {
      dispatch = listener;
      return () => (dispatch = undefined);
    };
    let fatal: Error | undefined;
    const projection = await LiveProjection.create(host, "generation-1", (error) => {
      fatal = error;
    });
    let closed = 0;
    projection.attachment().attach(
      () => undefined,
      () => (closed += 1),
    );
    const state = host.state;
    state.model = {
      get provider(): string {
        throw new Error("synchronous metadata failure");
      },
      id: "model",
    };
    expect(() => dispatch?.({ type: "state", state })).not.toThrow();
    expect(fatal?.message).toBe("synchronous metadata failure");
    expect(closed).toBe(1);
    expect(() => projection.attachment()).toThrow(/not available/);
  });

  it("rejects an initial asynchronous read made stale by a session change", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const host = new FakeSessionHost({ projectionGate: gate });
    host.load({ sessionId: "session", sessionFile: "/session.jsonl" });
    const creating = LiveProjection.create(host, "generation-1");
    await host.transition({ type: "replace", sessionFile: "/replacement.jsonl" });
    release();
    await expect(creating).rejects.toThrow("stale");
  });

  it("bounds and replays validated command completions", async () => {
    const { host, projection } = await ready();
    for (let index = 0; index < PROJECTION_LIMITS.completionReplay + 5; index += 1)
      host.settle(`command-${index}`, index % 2 ? "failed" : "completed");
    await tick();
    const replay = projection.attachment().completionReplay;
    expect(replay).toHaveLength(PROJECTION_LIMITS.completionReplay);
    expect(replay[0]?.commandId).toBe("command-5");
    expect(replay.every(isServerEnvelope)).toBe(true);
  });
});
