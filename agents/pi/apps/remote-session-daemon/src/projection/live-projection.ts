import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  LIMITS,
  PROTOCOL_VERSION,
  isOperationBatchEnvelope,
  isResetEnvelope,
  isServerEnvelope,
  isSessionSnapshotEnvelope,
  type CommandCompletionEnvelope,
  type LiveEntry,
  type OperationBatchEnvelope,
  type PersistedEntry,
  type ResetEnvelope,
  type SessionOperation,
  type SessionSnapshotData,
  type SessionSnapshotEnvelope,
} from "@dotfiles/pi-web-ui-client/wire";
import type {
  ProjectionRead,
  SessionHost,
  SessionHostEvent,
  SessionHostState,
} from "../host/session-host.ts";

export const PROJECTION_LIMITS = Object.freeze({
  // Leave bounded headroom for overlap-verified appends before a reset is required.
  snapshotEntries: Math.min(128, LIMITS.maxSnapshotEntries),
  snapshotBytes: 2 * 1024 * 1024,
  // Durable entries must leave room for every independently bounded volatile field.
  snapshotHeadroomBytes: 768 * 1024,
  durableReadBytes: 1024 * 1024,
  entryBytes: 64 * 1024,
  liveEntries: 64,
  liveValueBytes: 8 * 1024,
  queueItems: 100,
  queueValueBytes: 32 * 1024,
  queueBytes: 128 * 1024,
  completionReplay: 128,
  completionReplayBytes: 256 * 1024,
  envelopeBytes: 2 * 1024 * 1024,
  subscribers: 64,
  reconciliationAttempts: 3,
});

type ProjectionEnvelope =
  | SessionSnapshotEnvelope
  | OperationBatchEnvelope
  | ResetEnvelope
  | CommandCompletionEnvelope;
type ProjectionListener = (envelope: ProjectionEnvelope) => void;
interface ProjectionCheckpoint {
  snapshot?: SessionSnapshotEnvelope;
  entries: PersistedEntry[];
  continuity: string[];
  live: Map<string, LiveEntry>;
  liveVersions: Map<string, number>;
  pendingLiveRemovals: Map<string, number>;
  overflowedLiveText: Set<string>;
  completions: CommandCompletionEnvelope[];
  revision: number;
  readSerial: number;
  activitySerial: number;
  idleAfterReconcile?: number;
}

export interface ProjectionAttachment {
  readonly initial: SessionSnapshotEnvelope;
  readonly completionReplay: readonly CommandCompletionEnvelope[];
  subscribe(listener: ProjectionListener): () => void;
  attach(
    listener: ProjectionListener,
    onClose?: () => void,
  ): {
    readonly initial: SessionSnapshotEnvelope;
    readonly completionReplay: readonly CommandCompletionEnvelope[];
    unsubscribe(): void;
  };
  currentReset(reason?: string): ResetEnvelope;
}

const utf8 = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const placeholder = (reason: "unserializable" | "oversized") => ({
  type: "projection_placeholder",
  reason,
});

function boundedValue(value: unknown, byteLimit: number): unknown {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, child: unknown) => {
      if (typeof child === "bigint") return `[BigInt:${child.toString().slice(0, 128)}]`;
      if (typeof child === "function" || typeof child === "symbol" || child === undefined)
        return "[Unsupported value]";
      if (child !== null && typeof child === "object") {
        if (seen.has(child)) return "[Circular]";
        seen.add(child);
      }
      return child;
    });
    if (json === undefined) return placeholder("unserializable");
    if (Buffer.byteLength(json) > byteLimit) return placeholder("oversized");
    return JSON.parse(json) as unknown;
  } catch {
    return placeholder("unserializable");
  }
}

function boundedId(value: string, fallback: string): string {
  if (value.length > 0 && value.length <= LIMITS.maxIdentityChars) return value;
  const digest = createHash("sha256").update(value).digest("hex");
  return `${fallback}-${digest}`.slice(0, LIMITS.maxIdentityChars);
}

function boundedString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : "[Projection placeholder: oversized]";
}

function projectEntries(read: ProjectionRead): PersistedEntry[] {
  return read.entries.map((entry, index) => ({
    id: boundedId(entry.id, `entry-${index}`),
    payload: boundedValue(entry.data, PROJECTION_LIMITS.entryBytes),
  }));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertEnvelope<T extends ProjectionEnvelope>(value: T): T {
  const valid =
    value.type === "snapshot"
      ? isSessionSnapshotEnvelope(value)
      : value.type === "operations"
        ? isOperationBatchEnvelope(value)
        : value.type === "reset"
          ? isResetEnvelope(value)
          : isServerEnvelope(value);
  if (!valid || utf8(value) > PROJECTION_LIMITS.envelopeBytes)
    throw new Error("Projection produced an invalid or oversized shared envelope");
  return deepFreeze(value);
}

export class LiveProjection {
  readonly #host: SessionHost;
  readonly #generation: string;
  readonly #onFatal?: (error: Error) => void;
  readonly #listeners = new Set<ProjectionListener>();
  readonly #closeListeners = new Set<() => void>();
  readonly #completions: CommandCompletionEnvelope[] = [];
  #unsubscribe?: () => void;
  #snapshot?: SessionSnapshotEnvelope;
  #entries: PersistedEntry[] = [];
  #continuity: string[] = [];
  #live = new Map<string, LiveEntry>();
  #liveVersions = new Map<string, number>();
  #pendingLiveRemovals = new Map<string, number>();
  #overflowedLiveText = new Set<string>();
  #revision = 0;
  #disposed = false;
  #readSerial = 0;
  #reconcileQueued = false;
  #reconcileAgain = false;
  #reconcileTask?: Promise<void>;
  #activitySerial = 0;
  #idleAfterReconcile?: number;

  private constructor(host: SessionHost, generation: string, onFatal?: (error: Error) => void) {
    this.#host = host;
    this.#generation = generation;
    this.#onFatal = onFatal;
  }

  static async create(
    host: SessionHost,
    generation: string,
    onFatal?: (error: Error) => void,
  ): Promise<LiveProjection> {
    const projection = new LiveProjection(host, generation, onFatal);
    projection.#unsubscribe = host.subscribe((event) => projection.#dispatchEvent(event));
    try {
      const reconciled = await projection.#transactionAsync(() => projection.#reconcile(true));
      if (!reconciled) throw new Error("Initial projection read became stale");
      return projection;
    } catch (error) {
      projection.dispose();
      throw error;
    }
  }

  attachment(): ProjectionAttachment {
    if (this.#disposed || !this.#snapshot) throw new Error("Projection is not available");
    const capture = () => {
      if (this.#disposed || !this.#snapshot) throw new Error("Projection is not available");
      return {
        initial: structuredClone(this.#snapshot),
        completionReplay: structuredClone(this.#completions),
      };
    };
    const addListener = (listener: ProjectionListener) => {
      if (this.#disposed) return () => {};
      if (this.#listeners.size >= PROJECTION_LIMITS.subscribers)
        throw new Error("Projection subscriber capacity is exhausted");
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    };
    const subscribe = (listener: ProjectionListener) => addListener(listener);
    const captured = capture();
    return Object.freeze({
      ...captured,
      subscribe,
      attach: (listener: ProjectionListener, onClose?: () => void) => {
        // Capture and register in one synchronous turn. Projection publication is also
        // synchronous, so no operation can fall between these two steps.
        const current = capture();
        const removeListener = addListener(listener);
        if (onClose) this.#closeListeners.add(onClose);
        let attached = true;
        return Object.freeze({
          ...current,
          unsubscribe: () => {
            if (!attached) return;
            attached = false;
            removeListener();
            if (onClose) this.#closeListeners.delete(onClose);
          },
        });
      },
      currentReset: (reason = "client stream continuity recovery") => {
        const current = capture().initial;
        return assertEnvelope({
          version: PROTOCOL_VERSION,
          type: "reset",
          generation: current.generation,
          revision: current.revision,
          reason: reason.slice(0, LIMITS.maxResetReasonChars),
          snapshot: current.snapshot,
        });
      },
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#readSerial += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
    this.#listeners.clear();
    this.#live.clear();
    this.#liveVersions.clear();
    this.#pendingLiveRemovals.clear();
    this.#overflowedLiveText.clear();
  }

  async settled(): Promise<void> {
    await this.#reconcileTask;
  }

  #publish(envelope: ProjectionEnvelope): void {
    if (this.#disposed) return;
    const validated = assertEnvelope(envelope);
    // Publication has no deferred work: each bounded subscriber synchronously places
    // the shared immutable-by-convention envelope into its own bounded SSE mailbox.
    for (const listener of this.#listeners) {
      if (this.#disposed || !this.#listeners.has(listener)) continue;
      try {
        listener(validated);
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }

  #snapshotData(read: ProjectionRead, entries: PersistedEntry[]): SessionSnapshotData {
    const state = this.#host.state;
    return {
      commandEpoch: read.sessionEpoch,
      header: null,
      leafId: entries.at(-1)?.id ?? null,
      systemPrompt: "",
      entries,
      liveTail: [...this.#live.values()],
      history: {
        historyGeneration: read.sessionEpoch,
        beforeCursor: read.beforeCursor,
        hasMore: read.hasMore || entries.length < read.entries.length,
        oldestEntryId: entries[0]?.id ?? null,
      },
      metadata: this.#metadata(state),
      ...(read.imageAttachments === undefined ? {} : { imageAttachments: read.imageAttachments }),
      ...(read.modelControl === undefined ? {} : { modelControl: read.modelControl }),
      ...(read.pendingInputBroker === undefined
        ? {}
        : { pendingInputBroker: read.pendingInputBroker }),
      queue: this.#queue(read),
      running: { isRunning: state.running || !state.settled },
    };
  }

  #queue(read: ProjectionRead): SessionSnapshotData["queue"] {
    const queue: SessionSnapshotData["queue"] = [];
    let bytes = 2;
    for (const [index, item] of read.queue.slice(0, PROJECTION_LIMITS.queueItems).entries()) {
      const content = boundedValue(item.content, PROJECTION_LIMITS.queueValueBytes);
      const projected = {
        id: boundedId(item.id, `queue-${index}`),
        content:
          typeof content === "string"
            ? content
            : "[Projection placeholder: oversized queued input]",
        delivery: item.delivery,
        ...(item.attachmentCount === undefined ? {} : { attachmentCount: item.attachmentCount }),
        ...(item.itemVersion === undefined ? {} : { itemVersion: item.itemVersion }),
        ...(item.editable === undefined ? {} : { editable: item.editable }),
        ...(item.state === undefined ? {} : { state: item.state }),
      };
      const size = utf8(projected) + (queue.length > 0 ? 1 : 0);
      if (bytes + size > PROJECTION_LIMITS.queueBytes) break;
      queue.push(projected);
      bytes += size;
    }
    return queue;
  }

  async #reconcile(initial = false): Promise<boolean> {
    const serial = ++this.#readSerial;
    const expectedEpoch = this.#host.state.sessionEpoch;
    const read = await this.#host.projectionRead({
      maxEntries: PROJECTION_LIMITS.snapshotEntries,
      byteLimit: PROJECTION_LIMITS.durableReadBytes,
    });
    if (
      this.#disposed ||
      serial !== this.#readSerial ||
      read.sessionEpoch !== expectedEpoch ||
      this.#host.state.sessionEpoch !== expectedEpoch
    )
      return false;
    const entries = projectEntries(read);
    const signatures = read.entries.map((entry, index) =>
      JSON.stringify([
        entries[index]?.id,
        entry.parentId === null ? null : boundedId(entry.parentId, `parent-${index}`),
        boundedId(entry.type, `type-${index}`),
        entries[index]?.payload,
      ]),
    );
    if (initial) {
      const candidate = this.#boundedSnapshotCandidate(read, entries, signatures, this.#revision);
      this.#entries = candidate.entries;
      this.#continuity = candidate.signatures;
      this.#snapshot = candidate.envelope;
      return true;
    }
    const oldIds = this.#entries.map(({ id }) => id);
    const oldSignatures = this.#continuity;
    const newSignatures = signatures;
    const epochChanged = this.#snapshot?.snapshot.commandEpoch !== read.sessionEpoch;
    const capabilityChanged =
      JSON.stringify(this.#snapshot?.snapshot.imageAttachments) !==
        JSON.stringify(read.imageAttachments) ||
      JSON.stringify(this.#snapshot?.snapshot.pendingInputBroker) !==
        JSON.stringify(read.pendingInputBroker) ||
      JSON.stringify(this.#snapshot?.snapshot.modelControl) !== JSON.stringify(read.modelControl);
    let overlap = Math.min(oldSignatures.length, newSignatures.length);
    while (
      overlap > 0 &&
      oldSignatures.slice(-overlap).some((signature, index) => newSignatures[index] !== signature)
    )
      overlap -= 1;
    const appended = entries.slice(overlap);
    const appendSafe =
      !epochChanged &&
      (oldSignatures.length === 0 || overlap > 0) &&
      appended.length > 0 &&
      this.#entries.length + appended.length <= PROJECTION_LIMITS.snapshotEntries &&
      appended.every(({ id }) => !oldIds.includes(id));
    const identical =
      (oldSignatures.length === newSignatures.length && overlap === oldSignatures.length) ||
      (appended.length === 0 && overlap === newSignatures.length);
    if (appendSafe) {
      const retainedEntries = [...this.#entries, ...appended];
      const retainedSignatures = [...this.#continuity, ...newSignatures.slice(overlap)];
      try {
        this.#operations(
          [{ kind: "append", afterId: oldIds.at(-1) ?? null, entries: appended }],
          () => {
            this.#entries = retainedEntries;
            this.#continuity = retainedSignatures;
          },
        );
      } catch {
        this.#resetToBoundedWindow(read, entries, newSignatures, "projection window byte bound");
      }
    } else if (epochChanged || capabilityChanged || !identical) {
      this.#resetToBoundedWindow(
        read,
        entries,
        newSignatures,
        epochChanged
          ? "session epoch changed"
          : capabilityChanged
            ? "image capability changed"
            : "active branch continuity changed",
      );
    }
    const projected = this.#snapshotData(read, this.#entries);
    const operations: SessionOperation[] = [];
    if (JSON.stringify(projected.queue) !== JSON.stringify(this.#snapshot?.snapshot.queue))
      operations.push({ kind: "queue", queue: projected.queue });
    const idleToken = this.#idleAfterReconcile;
    const idleEligible =
      idleToken !== undefined &&
      idleToken === this.#activitySerial &&
      !this.#host.state.running &&
      this.#host.state.settled;
    if (idleEligible) operations.push({ kind: "running", running: { isRunning: false } });
    const removals = new Set<string>();
    if (idleToken !== undefined && idleToken === this.#activitySerial)
      for (const [key, version] of this.#liveVersions) if (version <= idleToken) removals.add(key);
    for (const [key, version] of this.#pendingLiveRemovals)
      if (this.#liveVersions.get(key) === version) removals.add(key);
    if (removals.size > 0) {
      const retainedLive = [...this.#live.entries()]
        .filter(([key]) => !removals.has(key))
        .map(([, value]) => value);
      operations.unshift({ kind: "live-tail", entries: retainedLive });
    }
    if (operations.length === 0) {
      this.#pendingLiveRemovals.clear();
    } else {
      this.#operations(operations, () => {
        for (const key of removals) this.#removeLive(key);
        this.#pendingLiveRemovals.clear();
        if (idleEligible) this.#idleAfterReconcile = undefined;
      });
    }
    return true;
  }

  #scheduleReconcile(idleAfter = false): void {
    if (idleAfter) this.#idleAfterReconcile = this.#activitySerial;
    if (this.#reconcileQueued) {
      this.#reconcileAgain = true;
      return;
    }
    this.#reconcileQueued = true;
    this.#reconcileTask = Promise.resolve()
      .then(async () => {
        do {
          this.#reconcileAgain = false;
          let lastError: unknown;
          for (let attempt = 0; attempt < PROJECTION_LIMITS.reconciliationAttempts; attempt += 1) {
            try {
              await this.#transactionAsync(() => this.#reconcile());
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError !== undefined) {
            this.#fatal(lastError);
            return;
          }
        } while (!this.#disposed && this.#reconcileAgain);
      })
      .finally(() => {
        this.#reconcileQueued = false;
      });
    void this.#reconcileTask.catch((error: unknown) => this.#fatal(error));
  }

  #operations(operations: SessionOperation[], onCommit?: () => void): void {
    if (this.#disposed || operations.length === 0) return;
    const fromRevision = this.#revision;
    const revision = fromRevision + 1;
    const envelope = assertEnvelope({
      version: PROTOCOL_VERSION,
      type: "operations",
      generation: this.#generation,
      fromRevision,
      revision,
      operations,
    });
    let nextSnapshot: SessionSnapshotEnvelope | undefined;
    if (this.#snapshot) {
      let snapshot = this.#snapshot.snapshot;
      for (const operation of operations) {
        if (operation.kind === "append") {
          const entries = [...snapshot.entries, ...operation.entries];
          snapshot = {
            ...snapshot,
            entries,
            leafId: operation.entries.at(-1)!.id,
            history: { ...snapshot.history, oldestEntryId: entries[0]?.id ?? null },
          };
        } else if (operation.kind === "live-tail")
          snapshot = { ...snapshot, liveTail: operation.entries };
        else if (operation.kind === "metadata")
          snapshot = { ...snapshot, metadata: operation.metadata };
        else if (operation.kind === "queue") snapshot = { ...snapshot, queue: operation.queue };
        else if (operation.kind === "theme") {
          if (operation.theme) snapshot = { ...snapshot, theme: operation.theme };
          else {
            const withoutTheme = { ...snapshot };
            delete withoutTheme.theme;
            snapshot = withoutTheme;
          }
        } else if (operation.kind === "running")
          snapshot = { ...snapshot, running: operation.running };
      }
      nextSnapshot = assertEnvelope({
        version: PROTOCOL_VERSION,
        type: "snapshot",
        generation: this.#generation,
        revision,
        snapshot,
      });
      if (utf8(nextSnapshot) > PROJECTION_LIMITS.snapshotBytes)
        throw new Error("Projection snapshot exceeds its byte bound");
    }
    onCommit?.();
    this.#revision = revision;
    if (nextSnapshot) this.#snapshot = nextSnapshot;
    this.#publish(envelope);
  }

  #boundedSnapshotCandidate(
    read: ProjectionRead,
    entries: PersistedEntry[],
    signatures: string[],
    revision: number,
  ): { entries: PersistedEntry[]; signatures: string[]; envelope: SessionSnapshotEnvelope } {
    for (let omitted = 0; omitted <= entries.length; omitted += 1) {
      const retained = entries.slice(omitted);
      try {
        const envelope = assertEnvelope({
          version: PROTOCOL_VERSION,
          type: "snapshot",
          generation: this.#generation,
          revision,
          snapshot: this.#snapshotData(read, retained),
        });
        if (
          utf8(envelope) <=
          PROJECTION_LIMITS.snapshotBytes - PROJECTION_LIMITS.snapshotHeadroomBytes
        )
          return { entries: retained, signatures: signatures.slice(omitted), envelope };
      } catch {
        // A smaller latest window may still validate.
      }
    }
    throw new Error("Projection cannot produce a bounded snapshot");
  }

  #resetToBoundedWindow(
    read: ProjectionRead,
    entries: PersistedEntry[],
    signatures: string[],
    reason: string,
  ): void {
    const revision = this.#revision + 1;
    const candidate = this.#boundedSnapshotCandidate(read, entries, signatures, revision);
    const reset = assertEnvelope({
      version: PROTOCOL_VERSION,
      type: "reset",
      generation: this.#generation,
      revision,
      reason: reason.slice(0, LIMITS.maxResetReasonChars),
      snapshot: candidate.envelope.snapshot,
    });
    this.#entries = candidate.entries;
    this.#continuity = candidate.signatures;
    this.#revision = revision;
    this.#snapshot = candidate.envelope;
    this.#publish(reset);
  }

  #removeLive(key: string): void {
    this.#live.delete(key);
    this.#liveVersions.delete(key);
    this.#overflowedLiveText.delete(key);
  }

  #replaceLive(): void {
    while (this.#live.size > PROJECTION_LIMITS.liveEntries) {
      const key = this.#live.keys().next().value!;
      this.#removeLive(key);
    }
    this.#operations([{ kind: "live-tail", entries: [...this.#live.values()] }]);
  }

  #markActivity(): void {
    this.#activitySerial += 1;
    this.#idleAfterReconcile = undefined;
  }

  #checkpoint(): ProjectionCheckpoint {
    return {
      snapshot: this.#snapshot,
      entries: [...this.#entries],
      continuity: [...this.#continuity],
      live: new Map(this.#live),
      liveVersions: new Map(this.#liveVersions),
      pendingLiveRemovals: new Map(this.#pendingLiveRemovals),
      overflowedLiveText: new Set(this.#overflowedLiveText),
      completions: [...this.#completions],
      revision: this.#revision,
      readSerial: this.#readSerial,
      activitySerial: this.#activitySerial,
      idleAfterReconcile: this.#idleAfterReconcile,
    };
  }

  #restore(checkpoint: ProjectionCheckpoint): void {
    this.#snapshot = checkpoint.snapshot;
    this.#entries = checkpoint.entries;
    this.#continuity = checkpoint.continuity;
    this.#live = checkpoint.live;
    this.#liveVersions = checkpoint.liveVersions;
    this.#pendingLiveRemovals = checkpoint.pendingLiveRemovals;
    this.#overflowedLiveText = checkpoint.overflowedLiveText;
    this.#completions.splice(0, this.#completions.length, ...checkpoint.completions);
    this.#revision = checkpoint.revision;
    this.#readSerial = checkpoint.readSerial;
    this.#activitySerial = checkpoint.activitySerial;
    this.#idleAfterReconcile = checkpoint.idleAfterReconcile;
  }

  #transaction<T>(operation: () => T): T {
    const checkpoint = this.#checkpoint();
    try {
      return operation();
    } catch (error) {
      this.#restore(checkpoint);
      throw error;
    }
  }

  async #transactionAsync<T>(operation: () => Promise<T>): Promise<T> {
    const checkpoint = this.#checkpoint();
    try {
      return await operation();
    } catch (error) {
      this.#restore(checkpoint);
      throw error;
    }
  }

  #fatal(value: unknown): void {
    if (this.#disposed) return;
    const error = value instanceof Error ? value : new Error(String(value));
    this.dispose();
    try {
      this.#onFatal?.(error);
    } catch {
      // Projection failure handling must not escape host listener dispatch.
    }
  }

  #dispatchEvent(event: SessionHostEvent): void {
    if (this.#disposed) return;
    try {
      this.#transaction(() => this.#onEvent(event));
    } catch (error) {
      this.#fatal(error);
    }
  }

  #onEvent(event: SessionHostEvent): void {
    if (this.#disposed) return;
    if (event.type === "message_start") {
      this.#markActivity();
      const key = `message:${event.messageId}`;
      this.#live.set(key, {
        id: boundedId(key, "live-message"),
        payload: {
          type: "message",
          message: { role: event.role, content: [{ type: "text", text: "" }] },
        },
      });
      this.#liveVersions.set(key, this.#activitySerial);
      this.#replaceLive();
    } else if (event.type === "message_delta") {
      const key = `message:${event.messageId}`;
      if (!this.#overflowedLiveText.has(key)) {
        const previous = this.#live.get(key)?.payload as
          | { message?: { content?: Array<{ text?: unknown }> } }
          | undefined;
        const prior = previous?.message?.content?.[0]?.text;
        const priorText = typeof prior === "string" ? prior : "";
        let payload: unknown;
        if (
          Buffer.byteLength(priorText) + Buffer.byteLength(event.text) >
          PROJECTION_LIMITS.liveValueBytes - 256
        ) {
          payload = placeholder("oversized");
          this.#overflowedLiveText.add(key);
        } else {
          payload = boundedValue(
            {
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: priorText + event.text }],
              },
            },
            PROJECTION_LIMITS.liveValueBytes,
          );
          const projected = payload as { type?: unknown };
          if (projected.type === "projection_placeholder") this.#overflowedLiveText.add(key);
        }
        this.#live.set(key, { id: boundedId(key, "live-message"), payload });
      }
      this.#replaceLive();
    } else if (event.type === "message_end") {
      const key = `message:${event.messageId}`;
      const version = this.#liveVersions.get(key);
      if (version !== undefined) this.#pendingLiveRemovals.set(key, version);
      this.#scheduleReconcile();
    } else if (event.type === "tool_start") {
      this.#markActivity();
      const key = `tool-call:${event.toolCallId}`;
      this.#live.set(key, {
        id: boundedId(key, "live-tool-call"),
        payload: boundedValue(
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: event.toolCallId,
                  name: event.name,
                  arguments: event.input ?? {},
                },
              ],
            },
          },
          PROJECTION_LIMITS.liveValueBytes,
        ),
      });
      this.#liveVersions.set(key, this.#activitySerial);
      this.#replaceLive();
    } else if (event.type === "tool_update" || event.type === "tool_end") {
      const key = `tool-result:${event.toolCallId}`;
      const value = event.type === "tool_update" ? event.update : event.output;
      let text: string;
      if (typeof value === "string") text = value;
      else {
        try {
          text = JSON.stringify(boundedValue(value, PROJECTION_LIMITS.liveValueBytes));
        } catch {
          text = "[Projection placeholder: unserializable tool result]";
        }
      }
      this.#live.set(key, {
        id: boundedId(key, "live-tool-result"),
        payload: boundedValue(
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: event.toolCallId,
              content: [{ type: "text", text }],
              isError: event.type === "tool_end" && Boolean(event.error),
              ...(event.type === "tool_end" && event.error ? { errorMessage: event.error } : {}),
            },
          },
          PROJECTION_LIMITS.liveValueBytes,
        ),
      });
      this.#liveVersions.set(key, this.#activitySerial);
      this.#replaceLive();
    } else if (event.type === "state") {
      const operations: SessionOperation[] = [];
      if (event.state.running) {
        this.#markActivity();
        if (!this.#snapshot?.snapshot.running.isRunning)
          operations.push({ kind: "running", running: { isRunning: true } });
      }
      const metadata = this.#metadata(event.state);
      if (JSON.stringify(metadata) !== JSON.stringify(this.#snapshot?.snapshot.metadata))
        operations.push({ kind: "metadata", metadata });
      this.#operations(operations);
      if (event.state.queueCount !== this.#snapshot?.snapshot.queue.length)
        this.#scheduleReconcile();
      if (event.state.sessionEpoch !== this.#snapshot?.snapshot.commandEpoch)
        this.#scheduleReconcile();
    } else if (event.type === "queue" || event.type === "durable_change") this.#scheduleReconcile();
    else if (event.type === "settled") this.#scheduleReconcile(true);
    else if (event.type === "compaction" && event.phase !== "started") this.#scheduleReconcile();
    else if (event.type === "transition" || event.type === "host_lost") this.#scheduleReconcile();
    else if (event.type === "model" || event.type === "thinking") {
      if (event.type === "model") this.#scheduleReconcile();
      const metadata = this.#metadata(this.#host.state);
      if (JSON.stringify(metadata) !== JSON.stringify(this.#snapshot?.snapshot.metadata))
        this.#operations([{ kind: "metadata", metadata }]);
    } else if (event.type === "command_completed") {
      const envelope = assertEnvelope({
        version: PROTOCOL_VERSION,
        type: "command-completion",
        commandId: boundedId(event.commandId, "command"),
        generation: this.#generation,
        commandEpoch: this.#host.state.sessionEpoch,
        revision: this.#revision,
        ...(event.outcome === "completed"
          ? { status: "completed" }
          : {
              status: "failed",
              error: (
                event.message ??
                (event.outcome === "aborted" ? "Command aborted" : "Command failed")
              ).slice(0, LIMITS.maxErrorChars),
            }),
      });
      this.#completions.push(envelope);
      while (
        this.#completions.length > PROJECTION_LIMITS.completionReplay ||
        utf8(this.#completions) > PROJECTION_LIMITS.completionReplayBytes
      )
        this.#completions.shift();
      this.#publish(envelope);
    }
  }

  #metadata(state: SessionHostState) {
    return {
      cwd: "",
      home: "",
      sessionCost: 0,
      ...(state.model
        ? {
            model: {
              provider: boundedString(state.model.provider, 128),
              id: boundedString(state.model.id, 256),
              name: boundedString(state.model.id, 256),
            },
          }
        : {}),
      thinkingLevel: state.thinkingLevel,
    };
  }
}
