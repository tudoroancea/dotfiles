import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  LIMITS,
  type ImageAttachmentCapability,
  type ModelControlCommand,
} from "@dotfiles/pi-web-ui-client/wire";
import { startServer, type Snapshot, type StartServerOptions } from "../src/index.js";
import { LiveSessionProjection } from "../src/standalone/projection/live.js";
import { modelControlCapability } from "../src/standalone/projection/snapshot.js";
import { StandaloneSessionRuntime } from "../src/standalone/runtime.js";
import { OperationJournal } from "../src/standalone/server/journal.js";
import { JournalMetrics } from "../src/standalone/server/metrics.js";
import { JournalSse } from "../src/standalone/server/sse.js";
import {
  DisposableSlot,
  SessionRuntimeLifecycle,
  type SessionRuntime,
} from "../src/standalone/lifecycle.js";

test("model control projection bounds scoped choices without exposing model internals", () => {
  const models = Array.from({ length: LIMITS.maxModelChoices + 10 }, (_, index) => ({
    provider: "provider",
    id: `model-${index}`,
    name: `Model ${index}`,
    reasoning: true,
    thinkingLevelMap: { max: index === 0 ? "max" : undefined },
    apiKey: "must-not-leak",
  }));
  let availableReads = 0;
  const context = {
    model: models[0],
    scopedModels: models.map((model) => ({ model })),
    modelRegistry: {
      getAvailable() {
        availableReads += 1;
        return [];
      },
    },
  } as unknown as ExtensionContext;

  const capability = modelControlCapability(context);
  expect(capability?.models).toHaveLength(LIMITS.maxModelChoices);
  expect(capability?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
  expect(availableReads).toBe(0);
  expect(JSON.stringify(capability)).not.toContain("must-not-leak");
});

test("model control projection omits overlong model identities instead of aliasing them", () => {
  const valid = { provider: "valid", id: "model", name: "Valid", reasoning: true };
  const context = {
    model: valid,
    scopedModels: [
      {
        model: {
          ...valid,
          provider: "p".repeat(LIMITS.maxModelProviderChars + 1),
          id: "overlong-provider",
        },
      },
      {
        model: { ...valid, provider: "valid", id: "i".repeat(LIMITS.maxModelIdChars + 1) },
      },
      { model: valid },
    ],
    modelRegistry: { getAvailable: () => [] },
  } as unknown as ExtensionContext;

  expect(modelControlCapability(context)?.models).toEqual([
    { provider: "valid", id: "model", name: "Valid" },
  ]);
});

test("model control projection falls back to authenticated available models", () => {
  const selected = {
    provider: "available",
    id: "selected",
    name: "Selected",
    reasoning: false,
  };
  const context = {
    model: selected,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [selected] },
  } as unknown as ExtensionContext;
  expect(modelControlCapability(context)).toEqual({
    models: [{ provider: "available", id: "selected", name: "Selected" }],
    thinkingLevels: ["off"],
  });
});

class Gate {
  readonly promise: Promise<void>;
  private resolvePromise!: () => void;

  constructor(resolved = false) {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
    if (resolved) this.resolve();
  }

  resolve(): void {
    this.resolvePromise();
  }
}

interface RuntimeRecord {
  label: string;
  starts: number;
  serverOpened: number;
  serverClosed: number;
  tailscaleOpened: number;
  tailscaleClosed: number;
  closes: number;
  acceptedCallbacks: string[];
}

class TrackingRuntime implements SessionRuntime {
  readonly record: RuntimeRecord;
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private serverStartPromise: Promise<void> | undefined;
  private serverOpen = false;
  private tailscaleOpen = false;

  constructor(
    label: string,
    private readonly gate: Gate,
    private readonly isCurrent: () => boolean,
  ) {
    this.record = {
      label,
      starts: 0,
      serverOpened: 0,
      serverClosed: 0,
      tailscaleOpened: 0,
      tailscaleClosed: 0,
      closes: 0,
      acceptedCallbacks: [],
    };
  }

  start(): Promise<void> {
    this.startPromise ??= Promise.resolve().then(() => {
      this.record.starts += 1;
    });
    return this.startPromise;
  }

  demandServer(): Promise<void> {
    if (!this.active()) return Promise.resolve();
    this.serverStartPromise ??= this.startServer();
    return this.serverStartPromise;
  }

  private async startServer(): Promise<void> {
    await this.gate.promise;
    this.serverOpen = true;
    this.record.serverOpened += 1;
    if (!this.active()) this.closeServer();
  }

  demandRemote(): void {
    if (!this.active() || !this.serverOpen || this.tailscaleOpen) return;
    this.tailscaleOpen = true;
    this.record.tailscaleOpened += 1;
  }

  lateServerCallback(): void {
    if (this.active() && this.serverOpen) this.record.acceptedCallbacks.push("server");
  }

  lateTailscaleCallback(): void {
    if (this.active() && this.tailscaleOpen) this.record.acceptedCallbacks.push("tailscale");
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.record.closes += 1;
    this.closePromise = (async () => {
      await Promise.all([this.startPromise, this.serverStartPromise]);
      if (this.tailscaleOpen) {
        this.tailscaleOpen = false;
        this.record.tailscaleClosed += 1;
      }
      this.closeServer();
    })();
    return this.closePromise;
  }

  private active(): boolean {
    return !this.closed && this.isCurrent();
  }

  private closeServer(): void {
    if (!this.serverOpen) return;
    this.serverOpen = false;
    this.record.serverClosed += 1;
  }
}

function lifecycleHarness() {
  const records: TrackingRuntime[] = [];
  const gates = new Map<string, Gate>();
  const lifecycle = new SessionRuntimeLifecycle<string, TrackingRuntime>((label, isCurrent) => {
    const runtime = new TrackingRuntime(label, gates.get(label) ?? new Gate(true), isCurrent);
    records.push(runtime);
    return runtime;
  });
  return { lifecycle, records, gates };
}

test("allocates opaque generations per server runtime and closes journal resources", async () => {
  const snapshot: Snapshot = {
    header: { id: "generation-lifecycle" },
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const first = await startServer(() => snapshot);
  const second = await startServer(() => snapshot);
  try {
    expect(first.generation).not.toBe(second.generation);
    expect(first.generation).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.metrics()).toMatchObject({ frameCount: 0, disconnects: 0 });
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("keeps append cursors stable and invalidates them on reset", () => {
  const entries = Array.from({ length: 250 }, (_, index) => ({
    id: `history-${index}`,
    parentId: index === 0 ? null : `history-${index - 1}`,
    type: "message",
    message: { role: "user", content: `message ${index}` },
  }));
  const snapshot: Snapshot = {
    header: { id: "history-lifecycle" },
    leafId: "history-249",
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries,
  };
  let liveEntries: unknown[] = [];
  const journal = new OperationJournal(
    {
      getSnapshot: () => snapshot,
      getPersistedEntries: () => entries,
      getLiveEntries: () => liveEntries,
    },
    new JournalMetrics(),
  );
  const initial = journal.snapshotEnvelope();
  expect(initial?.type).toBe("snapshot");
  if (initial?.type !== "snapshot") throw new Error("Expected snapshot");
  const cursor = initial.snapshot.history.beforeCursor;
  const historyGeneration = initial.snapshot.history.historyGeneration;
  expect(cursor).not.toBeNull();

  snapshot.isRunning = true;
  journal.observe();
  liveEntries = [{ id: "live-history-probe", payload: "partial" }];
  journal.observe();

  entries.push({
    id: "history-250",
    parentId: "history-249",
    type: "message",
    message: { role: "user", content: "strict append" },
  });
  snapshot.leafId = "history-250";
  journal.observe();
  const page = journal.historyPage({
    version: 1,
    type: "history-request",
    generation: journal.generation,
    revision: initial.revision,
    historyGeneration,
    beforeCursor: cursor!,
    beforeId: "history-50",
    limit: 100,
  });
  expect(page.revision).toBe(journal.revision);
  expect(page.entries.map((entry) => entry.id)).toEqual(
    Array.from({ length: 50 }, (_, index) => `history-${index}`),
  );
  expect(() =>
    journal.historyPage({
      version: 1,
      type: "history-request",
      generation: journal.generation,
      revision: initial.revision,
      historyGeneration,
      beforeCursor: `${cursor!.slice(0, -1)}x`,
      beforeId: "history-50",
      limit: 100,
    }),
  ).toThrow(/invalid or stale/);

  journal.forceReset("tree changed");
  expect(() =>
    journal.historyPage({
      version: 1,
      type: "history-request",
      generation: journal.generation,
      revision: journal.revision,
      historyGeneration,
      beforeCursor: cursor!,
      beforeId: "history-50",
      limit: 100,
    }),
  ).toThrow(/invalid or stale/);
});

test("initial and reset snapshots serialize model control capabilities", () => {
  const snapshot: Snapshot = {
    header: { id: "model-control-snapshot" },
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
    modelControl: {
      models: [{ provider: "fixture", id: "first", name: "First" }],
      thinkingLevels: ["off", "high"],
    },
  };
  const journal = new OperationJournal({ getSnapshot: () => snapshot }, new JournalMetrics());
  const initial = journal.snapshotEnvelope();
  expect(initial?.type).toBe("snapshot");
  if (initial?.type !== "snapshot") throw new Error("Expected snapshot");
  expect(initial.snapshot.modelControl).toEqual(snapshot.modelControl);

  let reset: ReturnType<OperationJournal["resetEnvelope"]>;
  journal.subscribe((envelope) => {
    if (envelope.type === "reset") reset = envelope;
  });
  snapshot.modelControl = {
    models: [{ provider: "fixture", id: "second", name: "Second" }],
    thinkingLevels: ["off"],
  };
  journal.forceReset("model capability changed");
  expect(reset?.type).toBe("reset");
  if (reset?.type !== "reset") throw new Error("Expected reset");
  expect(reset.snapshot.modelControl).toEqual(snapshot.modelControl);
  const resetInitial = journal.snapshotEnvelope();
  expect(resetInitial?.type).toBe("snapshot");
  expect(
    resetInitial?.type === "snapshot" ? resetInitial.snapshot.modelControl : undefined,
  ).toEqual(snapshot.modelControl);
});

test("rejects reset projections without mutating journal state or history lineage", () => {
  const entries = Array.from({ length: 250 }, (_, index) => ({
    id: `atomic-${index}`,
    value: index,
  }));
  let header: Record<string, unknown> = { id: "valid-header" };
  const snapshot: Snapshot = {
    header,
    leafId: "atomic-249",
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries,
  };
  const journal = new OperationJournal(
    { getSnapshot: () => ({ ...snapshot, header }), getPersistedEntries: () => entries },
    new JournalMetrics(),
  );
  const initial = journal.snapshotEnvelope();
  if (initial?.type !== "snapshot") throw new Error("Expected snapshot");
  const revision = journal.revision;
  const cursor = initial.snapshot.history.beforeCursor!;
  const historyGeneration = initial.snapshot.history.historyGeneration;

  header = { toJSON: () => "invalid projected header" };
  journal.forceReset("invalid projection");

  expect(journal.revision).toBe(revision);
  expect(journal.snapshotEnvelope()).toBe(initial);
  expect(
    journal.historyPage({
      version: 1,
      type: "history-request",
      generation: journal.generation,
      revision,
      historyGeneration,
      beforeCursor: cursor,
      beforeId: "atomic-50",
      limit: 100,
    }).entries,
  ).toHaveLength(50);
});

test("does not reserialize immutable persisted history during live observations", () => {
  let serializations = 0;
  const entries = Array.from({ length: 1_000 }, (_, index) => ({
    id: `large-${index}`,
    toJSON() {
      serializations += 1;
      return { id: `large-${index}`, payload: "x".repeat(1_024) };
    },
  }));
  const live: unknown[] = [];
  let persistedReads = 0;
  const snapshot: Snapshot = {
    header: { id: "large-history" },
    leafId: "large-999",
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries,
  };
  const journal = new OperationJournal(
    {
      getSnapshot: () => snapshot,
      getPersistedEntries: () => {
        persistedReads += 1;
        return entries;
      },
      getLiveEntries: () => live,
    },
    new JournalMetrics(),
  );
  journal.snapshotEnvelope();
  const initialSerializations = serializations;
  expect(persistedReads).toBe(1);
  live.push({ id: "live-probe", value: "streaming" });
  journal.observe(undefined, true);
  live[0] = { id: "live-probe", value: "streaming again" };
  journal.observe(undefined, true);
  expect(initialSerializations).toBe(entries.length);
  expect(serializations).toBe(initialSerializations);
  expect(persistedReads).toBe(1);
});

test("polls an O(1) lineage key without rebuilding unchanged observations", () => {
  let snapshotReads = 0;
  let pollKey = "leaf-0";
  const snapshot: Snapshot = {
    header: { id: "poll-key" },
    leafId: "leaf-0",
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [{ id: "leaf-0" }],
  };
  const journal = new OperationJournal(
    {
      getSnapshot: () => {
        snapshotReads += 1;
        return snapshot;
      },
      getPollKey: () => pollKey,
      getPersistedEntries: () => snapshot.entries,
    },
    new JournalMetrics(),
  );
  journal.snapshotEnvelope();
  journal.poll();
  journal.poll();
  expect(snapshotReads).toBe(1);

  pollKey = "leaf-1";
  snapshot.entries.push({ id: "leaf-1" });
  snapshot.leafId = "leaf-1";
  journal.poll();
  expect(snapshotReads).toBe(2);
});

test("resets instead of emitting an oversized append frame", () => {
  const entries: Array<Record<string, unknown>> = [{ id: "bounded-0", payload: "initial" }];
  const snapshot: Snapshot = {
    header: { id: "bounded-append" },
    leafId: "bounded-0",
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries,
  };
  const journal = new OperationJournal(
    { getSnapshot: () => snapshot, getPersistedEntries: () => entries },
    new JournalMetrics(),
  );
  journal.snapshotEnvelope();
  const emitted: string[] = [];
  journal.subscribe((envelope) => emitted.push(envelope.type));

  for (let index = 1; index <= 40; index += 1) {
    entries.push({ id: `bounded-${index}`, payload: "x".repeat(500_000) });
  }
  snapshot.leafId = "bounded-40";
  journal.observe();

  expect(emitted).toEqual(["reset"]);
  expect(journal.snapshotEnvelope()?.type).toBe("snapshot");
});

test("omits empty assistant starts and preserves one live timestamp across updates", () => {
  const live = new LiveSessionProjection();
  live.messageStart({ message: { role: "assistant", content: [] } });
  expect(live.projectLiveEntries([])).toEqual([]);

  live.messageUpdate({
    message: { role: "assistant", content: [{ type: "text", text: "streaming" }] },
  });
  const first = live.projectLiveEntries([]) as Array<{ timestamp?: string }>;
  live.messageUpdate({
    message: { role: "assistant", content: [{ type: "text", text: "streaming more" }] },
  });
  const second = live.projectLiveEntries([]) as Array<{ timestamp?: string }>;
  expect(first).toHaveLength(1);
  expect(second[0].timestamp).toBe(first[0].timestamp);
});

test("keeps live tool timestamps stable across unchanged projections", () => {
  const live = new LiveSessionProjection();
  live.toolEnd({ toolCallId: "stable", toolName: "read", result: "done", isError: false });
  const first = live.projectLiveEntries([]);
  const second = live.projectLiveEntries([]);
  expect(second).toEqual(first);

  const snapshot: Snapshot = {
    header: { id: "stable-live" },
    leafId: null,
    isRunning: true,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const journal = new OperationJournal(
    {
      getSnapshot: () => snapshot,
      getPersistedEntries: () => [],
      getLiveEntries: () => live.projectLiveEntries([]),
    },
    new JournalMetrics(),
  );
  journal.snapshotEnvelope();
  journal.observe();
  expect(journal.revision).toBe(0);
});

test("bounds completion replay without rotating the command epoch or dropping the newest event", () => {
  const snapshot: Snapshot = {
    header: { id: "completion-bound" },
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const journal = new OperationJournal({ getSnapshot: () => snapshot }, new JournalMetrics());
  journal.snapshotEnvelope();
  const epoch = journal.commandEpoch;
  for (let index = 0; index < 70; index += 1) {
    journal.publishCommandCompletion(`command-${index}`, epoch, "completed");
  }
  expect(journal.commandEpoch).toBe(epoch);
  expect(journal.completionEnvelopes()).toHaveLength(64);
  expect(journal.completionEnvelopes().at(-1)?.commandId).toBe("command-69");
});

test("replays a full completion ledger after transient initial backpressure", () => {
  class BackpressuredResponse extends EventEmitter {
    statusCode = 0;
    readonly frames: string[] = [];
    private blocked = true;
    setHeader(): void {}
    write(value: string): boolean {
      this.frames.push(value);
      if (this.blocked) {
        this.blocked = false;
        return false;
      }
      return true;
    }
    end(): void {}
  }

  const snapshot: Snapshot = {
    header: { id: "completion-backpressure" },
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const metrics = new JournalMetrics();
  const journal = new OperationJournal({ getSnapshot: () => snapshot }, metrics);
  journal.snapshotEnvelope();
  for (let index = 0; index < 64; index += 1) {
    journal.publishCommandCompletion(`command-${index}`, journal.commandEpoch, "completed");
  }
  const sse = new JournalSse(journal, metrics);
  const response = new BackpressuredResponse();
  try {
    sse.add(response as unknown as ServerResponse);
    response.emit("drain");
    expect(response.frames).toHaveLength(65);
    expect(
      response.frames.filter((frame) => frame.includes('"type":"command-completion"')),
    ).toHaveLength(64);
    expect(metrics.snapshot().disconnects).toBe(0);
  } finally {
    sse.close();
  }
});

test("replays bounded command completion events after the reconnect snapshot", () => {
  class CapturingResponse extends EventEmitter {
    statusCode = 0;
    readonly frames: string[] = [];
    setHeader(): void {}
    write(value: string): boolean {
      this.frames.push(value);
      return true;
    }
    end(): void {}
  }

  const snapshot: Snapshot = {
    header: { id: "completion-replay" },
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const metrics = new JournalMetrics();
  const journal = new OperationJournal({ getSnapshot: () => snapshot }, metrics);
  journal.snapshotEnvelope();
  journal.publishCommandCompletion("command-1", journal.commandEpoch, "completed");
  journal.publishCommandCompletion("command-1", journal.commandEpoch, "completed");
  const sse = new JournalSse(journal, metrics);
  const response = new CapturingResponse();
  try {
    sse.add(response as unknown as ServerResponse);
    expect(response.frames).toHaveLength(2);
    expect(response.frames[0]).toContain('"type":"snapshot"');
    expect(response.frames[1]).toContain('"type":"command-completion"');
  } finally {
    sse.close();
  }
});

test("disconnects blocked event streams at the drain deadline", async () => {
  class BlockedResponse extends EventEmitter {
    statusCode = 0;
    destroyed = false;
    setHeader(): void {}
    write(): boolean {
      return false;
    }
    end(): void {}
    destroy(): void {
      this.destroyed = true;
      this.emit("close");
    }
  }

  const snapshot: Snapshot = {
    header: { id: "blocked-client" },
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const metrics = new JournalMetrics();
  const journal = new OperationJournal({ getSnapshot: () => snapshot }, metrics);
  const sse = new JournalSse(journal, metrics, 20);
  const response = new BlockedResponse();
  try {
    sse.add(response as unknown as ServerResponse);
    await expect.poll(() => response.destroyed).toBe(true);
    expect(metrics.snapshot().disconnects).toBe(1);
  } finally {
    sse.close();
  }
});

test("replaces and clears a shared event-bus subscription", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const slot = new DisposableSlot();
  let oldCalls = 0;
  let currentCalls = 0;
  const oldSubscription = subscribe(() => oldCalls++);
  slot.replace(oldSubscription);
  const currentSubscription = subscribe(() => currentCalls++);
  slot.replace(currentSubscription);
  expect(listeners.size).toBe(1);

  for (const listener of listeners) listener();
  expect(oldCalls).toBe(0);
  expect(currentCalls).toBe(1);
  slot.clear(oldSubscription);
  expect(listeners.size).toBe(1);
  slot.clear(currentSubscription);
  expect(listeners.size).toBe(0);
});

test("a command paused in provider authentication cannot mutate after a branch reset", async () => {
  const authGate = new Gate();
  let submitInput:
    | ((
        command: {
          generation: string;
          commandEpoch: string;
          content: string;
          delivery: "immediate";
        },
        signal: AbortSignal,
      ) => Promise<{ accepted: boolean; error?: string }>)
    | undefined;
  let commandEpoch = "epoch-before-reset";
  const sent: string[] = [];
  const server = {
    origin: "http://127.0.0.1:1234",
    port: 1234,
    generation: "runtime-generation",
    get commandEpoch() {
      return commandEpoch;
    },
    bootstrapUrl: () => "http://127.0.0.1:1234/link",
    close: async () => undefined,
  };
  const runtime = new StandaloneSessionRuntime(
    { sendUserMessage: (content: string) => sent.push(content) } as never,
    {
      mode: "rpc",
      model: { provider: "fixture" },
      modelRegistry: {
        getProviderAuth: async () => {
          await authGate.promise;
          return { token: "present" };
        },
      },
      isIdle: () => true,
      ui: { notify: () => undefined },
    } as never,
    () => true,
    {
      startServer: (async (_snapshot: () => Snapshot, options?: StartServerOptions) => {
        submitInput = options?.submitInput as typeof submitInput;
        return server;
      }) as never,
      startTailscaleServe: (() => ({ close: async () => undefined })) as never,
    },
  );

  await runtime.copyUrl({ mode: "rpc", ui: { notify: () => undefined } } as never, false);
  if (!submitInput) throw new Error("Expected submitInput adapter");
  const admission = submitInput(
    {
      generation: server.generation,
      commandEpoch,
      content: "must remain on the old branch",
      delivery: "immediate",
    },
    new AbortController().signal,
  );
  commandEpoch = "epoch-after-reset";
  authGate.resolve();

  await expect(admission).resolves.toEqual({ accepted: false, error: "Session changed" });
  expect(sent).toEqual([]);
  await runtime.close();
});

test("same-capability model switches and aborts fence paused authentication", async () => {
  const authGate = new Gate();
  let submitInput: StartServerOptions["submitInput"];
  let epoch = "model-a-epoch";
  const sent: unknown[] = [];
  const context = {
    mode: "rpc",
    model: { provider: "fixture", id: "model-a", input: ["text", "image"] },
    modelRegistry: {
      getProviderAuth: async () => {
        await authGate.promise;
        return { token: "present" };
      },
    },
    isIdle: () => true,
    ui: { notify: () => undefined },
  } as never;
  const capability = {
    supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"] as const,
    maxAttachments: LIMITS.maxImagesPerEntry,
    maxBytesPerImage: LIMITS.maxImageBytes,
    maxTotalBytes: LIMITS.maxImageSourceBytesPerEntry,
    maxWidth: LIMITS.maxImageWidth,
    maxHeight: LIMITS.maxImageHeight,
    maxPixels: LIMITS.maxImagePixels,
    maxTotalPixels: LIMITS.maxImagePixels,
  };
  const server = {
    origin: "http://127.0.0.1:1234",
    port: 1234,
    generation: "model-generation",
    get commandEpoch() {
      return epoch;
    },
    imageAttachmentCapability: capability,
    bootstrapUrl: () => "http://127.0.0.1:1234/link",
    reset: () => {
      epoch = "model-b-epoch";
    },
    close: async () => undefined,
  };
  const runtime = new StandaloneSessionRuntime(
    { sendUserMessage: (content: unknown) => sent.push(content) } as never,
    context,
    () => true,
    {
      startServer: (async (_snapshot: () => Snapshot, options?: StartServerOptions) => {
        submitInput = options?.submitInput;
        return server;
      }) as never,
      startTailscaleServe: (() => ({ close: async () => undefined })) as never,
    },
  );
  await runtime.copyUrl({ mode: "rpc", ui: { notify: () => undefined } } as never, false);
  if (!submitInput) throw new Error("Expected submitInput adapter");

  const switched = submitInput(
    {
      version: 1,
      type: "command",
      commandId: "model-switch",
      generation: server.generation,
      commandEpoch: epoch,
      content: "must not cross models",
      delivery: "immediate",
    },
    new AbortController().signal,
  );
  (context as { model: { provider: string; id: string; input: string[] } }).model.id = "model-b";
  runtime.onModelSelect();
  authGate.resolve();
  await expect(switched).resolves.toEqual({ accepted: false, error: "Session changed" });
  expect(sent).toEqual([]);

  const neverAuth = new Gate();
  (context as { modelRegistry: { getProviderAuth: () => Promise<unknown> } }).modelRegistry = {
    getProviderAuth: () => neverAuth.promise,
  };
  const controller = new AbortController();
  const aborted = submitInput(
    {
      version: 1,
      type: "command",
      commandId: "shutdown-abort",
      generation: server.generation,
      commandEpoch: epoch,
      content: "must not survive shutdown",
      delivery: "immediate",
    },
    controller.signal,
  );
  controller.abort();
  await expect(aborted).resolves.toEqual({ accepted: false, error: "Session changed" });
  await runtime.close();
  expect(sent).toEqual([]);
});

test("the standalone adapter advertises image support and uses Pi's public image message API", async () => {
  let submitInput: StartServerOptions["submitInput"];
  const sent: unknown[] = [];
  const capability = {
    supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"] as const,
    maxAttachments: LIMITS.maxImagesPerEntry,
    maxBytesPerImage: LIMITS.maxImageBytes,
    maxTotalBytes: LIMITS.maxImageSourceBytesPerEntry,
    maxWidth: LIMITS.maxImageWidth,
    maxHeight: LIMITS.maxImageHeight,
    maxPixels: LIMITS.maxImagePixels,
    maxTotalPixels: LIMITS.maxImagePixels,
  };
  const server = {
    origin: "http://127.0.0.1:1234",
    port: 1234,
    generation: "image-runtime-generation",
    commandEpoch: "image-runtime-epoch",
    imageAttachmentCapability: capability,
    bootstrapUrl: () => "http://127.0.0.1:1234/link",
    close: async () => undefined,
  };
  const runtime = new StandaloneSessionRuntime(
    { sendUserMessage: (content: unknown) => sent.push(content) } as never,
    {
      mode: "rpc",
      model: { provider: "fixture", input: ["text", "image"] },
      modelRegistry: { getProviderAuth: async () => ({ token: "present" }) },
      isIdle: () => true,
      ui: { notify: () => undefined },
    } as never,
    () => true,
    {
      startServer: (async (_snapshot: () => Snapshot, options?: StartServerOptions) => {
        submitInput = options?.submitInput;
        return server;
      }) as never,
      startTailscaleServe: (() => ({ close: async () => undefined })) as never,
    },
  );

  await runtime.copyUrl({ mode: "rpc", ui: { notify: () => undefined } } as never, false);
  expect(capability.supportedMimeTypes).toEqual(["image/png", "image/jpeg", "image/webp"]);
  if (!submitInput) throw new Error("Expected submitInput adapter");
  const data = "UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==";
  await expect(
    submitInput(
      {
        version: 1,
        type: "image-command",
        commandId: "image-command",
        generation: server.generation,
        commandEpoch: server.commandEpoch,
        content: "describe",
        delivery: "immediate",
        attachments: [
          {
            type: "image-attachment",
            mimeType: "image/webp",
            width: 1,
            height: 1,
            byteLength: Buffer.from(data, "base64").length,
            data,
          },
        ],
      },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ accepted: true });
  expect(sent).toEqual([
    [
      { type: "text", text: "describe" },
      { type: "image", data, mimeType: "image/webp" },
    ],
  ]);
  await runtime.close();
});

test("runtime model control uses public APIs and suppresses model no-ops", async () => {
  let control: StartServerOptions["modelControl"];
  let modelSetCalls = 0;
  let thinking: "low" | "high" = "low";
  const first = { provider: "fixture", id: "first", name: "First", reasoning: true };
  const second = { provider: "fixture", id: "second", name: "Second", reasoning: true };
  const context = {
    mode: "rpc",
    model: first,
    scopedModels: [{ model: first }, { model: second }],
    modelRegistry: {
      getAvailable: () => [first, second],
      find: (_provider: string, id: string) => (id === "second" ? second : first),
    },
    isIdle: () => true,
    ui: { notify: () => undefined },
  };
  let epochNumber = 0;
  const server = {
    origin: "http://127.0.0.1:1234",
    port: 1234,
    generation: "model-generation",
    get commandEpoch() {
      return `model-epoch-${epochNumber}`;
    },
    imageAttachmentCapability: undefined,
    bootstrapUrl: () => "http://127.0.0.1:1234/link",
    reset: () => {
      epochNumber += 1;
    },
    close: async () => undefined,
  };
  let runtime: StandaloneSessionRuntime;
  const pi = {
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: "low" | "high") => {
      thinking = level;
    },
    setModel: async (model: typeof first) => {
      modelSetCalls += 1;
      context.model = model;
      if (model.id === "second") {
        runtime.onModelSelect();
      } else {
        queueMicrotask(() => runtime.onModelSelect());
        await Promise.resolve();
      }
      return true;
    },
  };
  runtime = new StandaloneSessionRuntime(pi as never, context as never, () => true, {
    startServer: (async (_snapshot: () => Snapshot, options?: StartServerOptions) => {
      control = options?.modelControl;
      return server;
    }) as never,
    startTailscaleServe: (() => ({ close: async () => undefined })) as never,
  });
  await runtime.copyUrl({ mode: "rpc", ui: { notify: () => undefined } } as never, false);
  if (!control) throw new Error("Expected model control adapter");
  const base = () => ({
    version: 1 as const,
    generation: server.generation,
    commandEpoch: server.commandEpoch,
  });
  const submit = (command: ModelControlCommand, tryHandoff = () => true) =>
    control!(command, new AbortController().signal, tryHandoff);
  await expect(
    submit({
      ...base(),
      type: "set-model",
      commandId: "noop",
      provider: "fixture",
      modelId: "first",
    }),
  ).resolves.toEqual({ accepted: true });
  expect(modelSetCalls).toBe(0);
  await expect(
    submit({
      ...base(),
      type: "set-model",
      commandId: "change",
      provider: "fixture",
      modelId: "second",
    }),
  ).resolves.toEqual({ accepted: true });
  expect(modelSetCalls).toBe(1);
  await expect(
    submit({
      ...base(),
      type: "set-model",
      commandId: "change-back",
      provider: "fixture",
      modelId: "first",
    }),
  ).resolves.toEqual({ accepted: true });
  expect(modelSetCalls).toBe(2);
  await expect(
    submit(
      {
        ...base(),
        type: "set-model",
        commandId: "refused-handoff",
        provider: "fixture",
        modelId: "second",
      },
      () => false,
    ),
  ).resolves.toMatchObject({ accepted: false, reason: "session-changed" });
  expect(modelSetCalls).toBe(2);
  await expect(
    submit({ ...base(), type: "set-thinking", commandId: "thinking", thinkingLevel: "high" }),
  ).resolves.toEqual({ accepted: true });
  expect(thinking).toBe("high");
  await runtime.close();
});

test("image capability expansion rotates the command epoch before admission", async () => {
  let submitInput: StartServerOptions["submitInput"];
  let epoch = "text-epoch";
  let capability: ImageAttachmentCapability | undefined;
  const context = {
    mode: "rpc",
    model: { provider: "fixture", input: ["text"] },
    modelRegistry: { getProviderAuth: async () => ({ token: "present" }) },
    isIdle: () => true,
    ui: { notify: () => undefined },
  } as never;
  const server = {
    origin: "http://127.0.0.1:1234",
    port: 1234,
    generation: "capability-generation",
    get commandEpoch() {
      return epoch;
    },
    get imageAttachmentCapability() {
      return capability;
    },
    bootstrapUrl: () => "http://127.0.0.1:1234/link",
    reset: () => {
      epoch = "image-epoch";
      capability = {
        supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        maxAttachments: LIMITS.maxImagesPerEntry,
        maxBytesPerImage: LIMITS.maxImageBytes,
        maxTotalBytes: LIMITS.maxImageSourceBytesPerEntry,
        maxWidth: LIMITS.maxImageWidth,
        maxHeight: LIMITS.maxImageHeight,
        maxPixels: LIMITS.maxImagePixels,
        maxTotalPixels: LIMITS.maxImagePixels,
      };
    },
    close: async () => undefined,
  };
  const runtime = new StandaloneSessionRuntime(
    { sendUserMessage: () => undefined } as never,
    context,
    () => true,
    {
      startServer: (async (_snapshot: () => Snapshot, options?: StartServerOptions) => {
        submitInput = options?.submitInput;
        return server;
      }) as never,
      startTailscaleServe: (() => ({ close: async () => undefined })) as never,
    },
  );
  await runtime.copyUrl({ mode: "rpc", ui: { notify: () => undefined } } as never, false);
  if (!submitInput) throw new Error("Expected submitInput adapter");
  (context as { model: { provider: string; input: string[] } }).model.input.push("image");
  runtime.onModelSelect();
  expect(epoch).toBe("image-epoch");
  const stale = {
    version: 1 as const,
    type: "image-command" as const,
    commandId: "stale-image",
    generation: server.generation,
    commandEpoch: "text-epoch",
    content: "",
    delivery: "immediate" as const,
    attachments: [],
  };
  await expect(submitInput(stale, new AbortController().signal)).resolves.toEqual({
    accepted: false,
    error: "Session changed",
  });
  await runtime.close();
});

test("both copy commands demand the HTTP server and only the remote command demands Tailscale", async () => {
  for (const remote of [false, true]) {
    let serverStarts = 0;
    let tailscaleStarts = 0;
    const notifications: string[] = [];
    const runtime = new StandaloneSessionRuntime(
      {} as never,
      { mode: "rpc" } as never,
      () => true,
      {
        startServer: (async () => {
          serverStarts += 1;
          return {
            origin: "http://127.0.0.1:1234",
            port: 1234,
            bootstrapUrl: (origin?: string) => `${origin ?? "http://127.0.0.1:1234"}/link`,
            close: async () => undefined,
          };
        }) as never,
        startTailscaleServe: ((
          _localOrigin: string,
          _port: number,
          onReady: (origin: string) => void,
        ) => {
          tailscaleStarts += 1;
          onReady("https://host.tailnet.ts.net");
          return { close: async () => undefined };
        }) as never,
      },
    );

    await runtime.copyUrl(
      {
        mode: "rpc",
        ui: { notify: (message: string) => notifications.push(message) },
      } as never,
      remote,
    );

    expect(serverStarts).toBe(1);
    expect(tailscaleStarts).toBe(remote ? 1 : 0);
    expect(notifications).toHaveLength(1);
    await runtime.close();
  }
});

test("starts the HTTP server and Tailscale lazily and closes both with the session", async () => {
  const { lifecycle, records } = lifecycleHarness();
  await lifecycle.replace("lazy");
  const runtime = records[0];
  expect(runtime.record.serverOpened).toBe(0);
  expect(runtime.record.tailscaleOpened).toBe(0);

  await runtime.demandServer();
  await runtime.demandServer();
  expect(runtime.record.serverOpened).toBe(1);

  runtime.demandRemote();
  runtime.demandRemote();
  expect(runtime.record.tailscaleOpened).toBe(1);

  await lifecycle.shutdown();
  expect(runtime.record.tailscaleClosed).toBe(1);
});

test("replaces reload/new/resume/fork runtimes with balanced closure", async () => {
  const { lifecycle, records } = lifecycleHarness();
  for (const label of ["reload", "new", "resume", "fork"]) {
    await lifecycle.replace(label);
    await lifecycle.current?.demandServer();
    lifecycle.current?.demandRemote();
  }

  for (const stale of records.slice(0, -1)) {
    stale.lateServerCallback();
    stale.lateTailscaleCallback();
    expect(stale.record.acceptedCallbacks).toEqual([]);
    expect(stale.record).toMatchObject({
      starts: 1,
      serverOpened: 1,
      serverClosed: 1,
      tailscaleOpened: 1,
      tailscaleClosed: 1,
      closes: 1,
    });
  }
  const active = records.at(-1)!;
  active.lateServerCallback();
  active.lateTailscaleCallback();
  expect(active.record.acceptedCallbacks).toEqual(["server", "tailscale"]);

  await lifecycle.shutdown();
  expect(active.record).toMatchObject({
    serverClosed: 1,
    tailscaleClosed: 1,
    closes: 1,
  });
});

test("shutdown during lazy server startup closes a late server and starts no Tailscale resource", async () => {
  const { lifecycle, records, gates } = lifecycleHarness();
  const gate = new Gate();
  gates.set("starting", gate);
  await lifecycle.replace("starting");
  const serverStartup = records[0].demandServer();

  const shutdown = lifecycle.shutdown();
  gate.resolve();
  await Promise.all([serverStartup, shutdown]);

  const runtime = records[0];
  runtime.lateServerCallback();
  runtime.lateTailscaleCallback();
  expect(runtime.record).toMatchObject({
    serverOpened: 1,
    serverClosed: 1,
    tailscaleOpened: 0,
    tailscaleClosed: 0,
    closes: 1,
    acceptedCallbacks: [],
  });
  expect(lifecycle.current).toBeUndefined();
});

test("a newer generation wins overlapping startup and stale callbacks remain inert", async () => {
  const { lifecycle, records, gates } = lifecycleHarness();
  const oldGate = new Gate();
  gates.set("old", oldGate);
  await lifecycle.replace("old");
  const oldServerStartup = records[0].demandServer();

  const replacement = lifecycle.replace("replacement");
  oldGate.resolve();
  await Promise.all([oldServerStartup, replacement]);

  const [oldRuntime, replacementRuntime] = records;
  await replacementRuntime.demandServer();
  replacementRuntime.demandRemote();
  oldRuntime.lateServerCallback();
  oldRuntime.lateTailscaleCallback();
  replacementRuntime.lateServerCallback();
  replacementRuntime.lateTailscaleCallback();
  expect(oldRuntime.record.acceptedCallbacks).toEqual([]);
  expect(oldRuntime.record.serverClosed).toBe(1);
  expect(replacementRuntime.record.acceptedCallbacks).toEqual(["server", "tailscale"]);

  await lifecycle.shutdown();
  await lifecycle.shutdown();
  expect(replacementRuntime.record.closes).toBe(1);
  expect(replacementRuntime.record.serverClosed).toBe(1);
  expect(replacementRuntime.record.tailscaleClosed).toBe(1);
});
