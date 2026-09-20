import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Check } from "typebox/value";
import {
  CommandCompletionEnvelopeSchema,
  LIMITS,
  OperationBatchEnvelopeSchema,
  ResetEnvelopeSchema,
  SessionSnapshotEnvelopeSchema,
  type CommandCompletionEnvelope,
  type HistoryPageEnvelope,
  type HistoryRequest,
  type ImageAttachmentCapability,
  type ModelControlCapability,
  type LiveEntry,
  type PersistedEntry,
  type SessionOperation,
  type SessionSnapshotData,
  type ServerEnvelope,
  isSnapshot,
} from "@dotfiles/pi-web-ui-client/wire";
import { HistoryJournal } from "./history.js";
import { ImageResolver } from "./images.js";
import type { JournalMetrics } from "./metrics.js";
import type { Snapshot } from "./types.js";

const INITIAL_ENTRY_COUNT = 200;
const INITIAL_ENTRY_BYTES = 2 * 1024 * 1024;
const ENTRY_BYTES = 512 * 1024;
const LIVE_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_COMPLETIONS = 64;

interface PersistedProjection {
  entry: PersistedEntry;
  key: string;
}

interface Observation {
  snapshot: Snapshot;
  persisted: PersistedEntry[];
  persistedKeys: string[];
  live: LiveEntry[];
  headerKey: string;
  systemPromptKey: string;
  metadataKey: string;
  queueKey: string;
  pendingInputBrokerKey: string;
  themeKey: string;
  runningKey: string;
  pollKey: string;
}

export interface OperationJournalSource {
  getSnapshot(): Snapshot;
  getPollKey?(): string;
  getEntries?(): { persisted: readonly unknown[]; live: readonly unknown[] };
  getPersistedEntries?(): readonly unknown[];
  getLiveEntries?(): readonly unknown[];
}

export class OperationJournal {
  readonly generation = randomBytes(24).toString("base64url");
  readonly images = new ImageResolver(this.generation);
  private commandEpochValue = randomBytes(18).toString("base64url");
  private revisionValue = 0;
  private current: Observation | undefined;
  private initial: ServerEnvelope | undefined;
  private lastPollKey = "";
  private readonly history = new HistoryJournal();
  private readonly persistedCache = new WeakMap<
    object,
    { index: number; projection: PersistedProjection }
  >();
  private readonly listeners = new Set<(envelope: ServerEnvelope, reason: string) => void>();
  private readonly commandCompletions = new Map<string, CommandCompletionEnvelope>();

  constructor(
    private readonly source: OperationJournalSource,
    private readonly metrics: JournalMetrics,
  ) {}

  get revision(): number {
    return this.revisionValue;
  }

  get commandEpoch(): string {
    return this.commandEpochValue;
  }

  get imageAttachmentCapability(): ImageAttachmentCapability | undefined {
    if (!this.current) this.observe();
    return this.current?.snapshot.imageAttachments;
  }

  get modelControlCapability(): ModelControlCapability | undefined {
    if (!this.current) this.observe();
    return this.current?.snapshot.modelControl;
  }

  subscribe(listener: (envelope: ServerEnvelope, reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshotEnvelope(): ServerEnvelope | undefined {
    if (!this.current) this.observe();
    return this.initial;
  }

  completionEnvelopes(): readonly CommandCompletionEnvelope[] {
    return [...this.commandCompletions.values()];
  }

  publishCommandCompletion(
    commandId: string,
    commandEpoch: string,
    status: "completed" | "failed",
    error?: string,
  ): void {
    if (commandEpoch !== this.commandEpochValue) return;
    const existing = this.commandCompletions.get(commandId);
    if (existing) return;
    if (this.commandCompletions.size >= MAX_COMMAND_COMPLETIONS) {
      this.commandCompletions.delete(this.commandCompletions.keys().next().value!);
    }
    const envelope: CommandCompletionEnvelope =
      status === "completed"
        ? {
            version: 1,
            type: "command-completion",
            commandId,
            generation: this.generation,
            commandEpoch,
            revision: this.revisionValue,
            status,
          }
        : {
            version: 1,
            type: "command-completion",
            commandId,
            generation: this.generation,
            commandEpoch,
            revision: this.revisionValue,
            status,
            error: (error || "Command failed").slice(0, LIMITS.maxErrorChars),
          };
    if (!Check(CommandCompletionEnvelopeSchema, envelope)) return;
    this.commandCompletions.set(commandId, envelope);
    this.emit(envelope, `command-${status}`);
  }

  poll(): void {
    let key: string;
    try {
      if (this.source.getPollKey) key = this.source.getPollKey();
      else {
        const snapshot = this.source.getSnapshot();
        if (!isSnapshot(snapshot)) return;
        key = observationPollKey(snapshot);
      }
    } catch {
      return;
    }
    if (key !== this.lastPollKey) this.observe();
  }

  observe(resetReason?: string, reusePersisted = false): void {
    const started = performance.now();
    let next: Observation;
    try {
      next = this.readObservation(reusePersisted);
    } catch {
      this.metrics.record("serialization_ms", performance.now() - started, "invalid-observation");
      return;
    }
    this.metrics.record("serialization_ms", performance.now() - started, "observation");
    this.lastPollKey = next.pollKey;

    if (!this.current) {
      const history = this.history.prepareReplace(next.persisted);
      const envelope = {
        version: 1,
        type: "snapshot",
        generation: this.generation,
        revision: this.revisionValue,
        snapshot: this.snapshotData(
          next,
          history.initialWindow(INITIAL_ENTRY_COUNT, INITIAL_ENTRY_BYTES),
        ),
      } as const;
      if (
        !Check(SessionSnapshotEnvelopeSchema, envelope) ||
        wireBytes(envelope) > MAX_ENVELOPE_BYTES
      )
        return;
      history.commit();
      this.current = next;
      this.initial = envelope;
      return;
    }

    if (resetReason || !this.sameStatic(this.current, next)) {
      this.reset(next, resetReason ?? "unsupported session transition");
      return;
    }

    const prefix = this.prefixTransition(this.current, next);
    if (prefix === "reset") {
      this.reset(next, "active branch lineage changed");
      return;
    }

    if (prefix.length > LIMITS.maxAppendEntries) {
      this.reset(next, "append exceeds operation bound");
      return;
    }

    const operations: SessionOperation[] = [];
    if (prefix.length > 0)
      operations.push({
        kind: "append",
        afterId: this.current.persisted.at(-1)?.id ?? null,
        entries: prefix,
      });
    if (!equal(this.current.live, next.live))
      operations.push({ kind: "live-tail", entries: next.live });
    if (this.current.metadataKey !== next.metadataKey) {
      if (next.snapshot.metadata === undefined) {
        this.reset(next, "metadata became unavailable");
        return;
      }
      operations.push({ kind: "metadata", metadata: next.snapshot.metadata });
    }
    if (this.current.queueKey !== next.queueKey)
      operations.push({ kind: "queue", queue: next.snapshot.pendingInputs });
    if (this.current.themeKey !== next.themeKey)
      operations.push({ kind: "theme", theme: next.snapshot.theme ?? null });
    if (this.current.runningKey !== next.runningKey)
      operations.push({ kind: "running", running: running(next.snapshot) });
    if (operations.length === 0) return;

    const fromRevision = this.revisionValue;
    this.revisionValue += 1;
    const envelope = {
      version: 1,
      type: "operations",
      generation: this.generation,
      fromRevision,
      revision: this.revisionValue,
      operations,
    } as const;
    if (
      !Check(OperationBatchEnvelopeSchema, envelope) ||
      wireBytes(envelope) > MAX_ENVELOPE_BYTES
    ) {
      this.revisionValue = fromRevision;
      this.reset(next, "operation exceeds byte bound");
      return;
    }
    if (prefix.length > 0) this.history.append(next.persisted);
    this.current = next;
    this.initial = this.snapshotEnvelopeForCurrent();
    this.emit(envelope, operations.map((operation) => operation.kind).join(","));
  }

  forceReset(reason: string): void {
    this.observe(reason);
  }

  historyPage(request: HistoryRequest): HistoryPageEnvelope {
    if (!this.current || request.generation !== this.generation) {
      throw new Error("History request is stale; reconnect for a fresh snapshot");
    }
    return this.history.page(request, this.generation, this.revisionValue);
  }

  resetEnvelope(reason: string): ServerEnvelope | undefined {
    if (!this.current) this.observe();
    if (!this.current) return undefined;
    const envelope = {
      version: 1,
      type: "reset",
      generation: this.generation,
      revision: this.revisionValue,
      reason: reason.slice(0, 512) || "continuity reset",
      snapshot: this.snapshotData(this.current),
    } as const;
    return Check(ResetEnvelopeSchema, envelope) && wireBytes(envelope) <= MAX_ENVELOPE_BYTES
      ? envelope
      : undefined;
  }

  private reset(next: Observation, reason: string): void {
    const revision = this.revisionValue + 1;
    const nextCommandEpoch = randomBytes(18).toString("base64url");
    const history = this.history.prepareReplace(next.persisted);
    const window = history.initialWindow(INITIAL_ENTRY_COUNT, INITIAL_ENTRY_BYTES);
    const snapshot = this.snapshotData(next, window, nextCommandEpoch);
    const envelope = {
      version: 1,
      type: "reset",
      generation: this.generation,
      revision,
      reason: reason.slice(0, 512) || "continuity reset",
      snapshot,
    } as const;
    const initial = {
      version: 1,
      type: "snapshot",
      generation: this.generation,
      revision,
      snapshot,
    } as const;
    if (
      !Check(ResetEnvelopeSchema, envelope) ||
      !Check(SessionSnapshotEnvelopeSchema, initial) ||
      wireBytes(envelope) > MAX_ENVELOPE_BYTES
    ) {
      return;
    }

    history.commit();
    this.commandCompletions.clear();
    this.commandEpochValue = nextCommandEpoch;
    this.revisionValue = revision;
    this.current = next;
    this.initial = initial;
    this.metrics.record("reset", 1, reason);
    this.emit(envelope, reason);
  }

  private snapshotEnvelopeForCurrent(): ServerEnvelope | undefined {
    if (!this.current) return undefined;
    const envelope = {
      version: 1,
      type: "snapshot",
      generation: this.generation,
      revision: this.revisionValue,
      snapshot: this.snapshotData(this.current),
    } as const;
    return Check(SessionSnapshotEnvelopeSchema, envelope) &&
      wireBytes(envelope) <= MAX_ENVELOPE_BYTES
      ? envelope
      : undefined;
  }

  private snapshotData(
    observation: Observation,
    window = this.history.initialWindow(INITIAL_ENTRY_COUNT, INITIAL_ENTRY_BYTES),
    commandEpoch = this.commandEpochValue,
  ): SessionSnapshotData {
    return {
      commandEpoch,
      ...(observation.snapshot.imageAttachments === undefined
        ? {}
        : { imageAttachments: observation.snapshot.imageAttachments }),
      ...(observation.snapshot.modelControl === undefined
        ? {}
        : { modelControl: observation.snapshot.modelControl }),
      ...(observation.snapshot.pendingInputBroker === undefined
        ? {}
        : { pendingInputBroker: observation.snapshot.pendingInputBroker }),
      header: boundedHeader(observation.snapshot.header),
      leafId: observation.snapshot.leafId,
      ...(observation.snapshot.sessionName === undefined
        ? {}
        : { sessionName: observation.snapshot.sessionName }),
      systemPrompt: observation.snapshot.systemPrompt,
      entries: window.entries,
      liveTail: observation.live,
      history: {
        historyGeneration: window.historyGeneration,
        beforeCursor: window.beforeCursor,
        hasMore: window.hasMore,
        oldestEntryId: window.entries[0]?.id ?? null,
      },
      ...(observation.snapshot.metadata === undefined
        ? {}
        : { metadata: observation.snapshot.metadata }),
      queue: observation.snapshot.pendingInputs,
      ...(observation.snapshot.theme === undefined ? {} : { theme: observation.snapshot.theme }),
      running: running(observation.snapshot),
    };
  }

  private readObservation(reusePersisted: boolean): Observation {
    const snapshot = this.source.getSnapshot();
    if (!isSnapshot(snapshot)) throw new Error("Invalid snapshot");
    const combined = reusePersisted ? undefined : this.source.getEntries?.();
    const rawPersisted =
      reusePersisted && this.current
        ? []
        : (combined?.persisted ??
          this.source.getPersistedEntries?.() ??
          snapshot.entries.filter((entry) => !liveId(entry)));
    const rawLive =
      combined?.live ?? this.source.getLiveEntries?.() ?? snapshot.entries.filter(liveId);
    let persisted: PersistedEntry[];
    let persistedKeys: string[];
    if (reusePersisted && this.current) {
      persisted = this.current.persisted;
      persistedKeys = this.current.persistedKeys;
    } else {
      const projected = rawPersisted.map((entry, index) => this.persistedEntry(entry, index));
      persisted = projected.map(({ entry }) => entry);
      persistedKeys = projected.map(({ key }) => key);
      const ids = new Set<string>();
      for (const entry of persisted) {
        if (ids.has(entry.id)) throw new Error("Duplicate persisted entry identity");
        ids.add(entry.id);
      }
    }
    const live = boundedLiveEntries(rawLive, this.images);
    return {
      snapshot: clone({ ...snapshot, entries: [] }) as Snapshot,
      persisted,
      persistedKeys,
      live,
      headerKey: JSON.stringify(snapshot.header),
      systemPromptKey: snapshot.systemPrompt,
      metadataKey: JSON.stringify(snapshot.metadata),
      queueKey: JSON.stringify(snapshot.pendingInputs),
      pendingInputBrokerKey: JSON.stringify(snapshot.pendingInputBroker),
      themeKey: JSON.stringify(snapshot.theme),
      runningKey: JSON.stringify(running(snapshot)),
      pollKey: this.source.getPollKey?.() ?? observationPollKey(snapshot),
    };
  }

  private persistedEntry(value: unknown, index: number): PersistedProjection {
    if (value !== null && typeof value === "object") {
      const cached = this.persistedCache.get(value);
      if (cached?.index === index) return cached.projection;
      const projection = persistedEntry(value, index, this.images);
      this.persistedCache.set(value, { index, projection });
      return projection;
    }
    return persistedEntry(value, index, this.images);
  }

  private sameStatic(previous: Observation, next: Observation): boolean {
    return (
      previous.headerKey === next.headerKey &&
      previous.systemPromptKey === next.systemPromptKey &&
      JSON.stringify(previous.snapshot.imageAttachments) ===
        JSON.stringify(next.snapshot.imageAttachments) &&
      JSON.stringify(previous.snapshot.modelControl) ===
        JSON.stringify(next.snapshot.modelControl) &&
      previous.pendingInputBrokerKey === next.pendingInputBrokerKey &&
      (previous.snapshot.sessionName ?? "") === (next.snapshot.sessionName ?? "")
    );
  }

  private prefixTransition(previous: Observation, next: Observation): PersistedEntry[] | "reset" {
    if (next.persisted.length < previous.persisted.length) return "reset";
    for (let index = 0; index < previous.persistedKeys.length; index += 1) {
      if (previous.persistedKeys[index] !== next.persistedKeys[index]) return "reset";
    }
    const suffix = next.persisted.slice(previous.persisted.length);
    const expectedLeaf = next.persisted.at(-1)?.id ?? null;
    if (next.snapshot.leafId !== expectedLeaf) return "reset";
    if (suffix.length === 0 && previous.snapshot.leafId !== next.snapshot.leafId) return "reset";
    return suffix;
  }

  private emit(envelope: ServerEnvelope, reason: string): void {
    for (const listener of this.listeners) listener(envelope, reason);
  }
}

function observationPollKey(snapshot: Snapshot): string {
  return JSON.stringify([
    snapshot.leafId,
    snapshot.sessionName,
    snapshot.systemPrompt,
    snapshot.isRunning,
    snapshot.workingWord,
    snapshot.header,
    snapshot.metadata,
    snapshot.pendingInputs,
    snapshot.pendingInputBroker,
    snapshot.modelControl,
    snapshot.theme,
  ]);
}

function running(snapshot: Snapshot) {
  return {
    isRunning: snapshot.isRunning,
    ...(snapshot.workingWord === undefined ? {} : { workingWord: snapshot.workingWord }),
  };
}

function rawId(value: unknown): string | undefined {
  const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
}

function persistedEntry(value: unknown, index: number, images: ImageResolver): PersistedProjection {
  const id = rawId(value) ?? `omitted-${index}`;
  let entry: PersistedEntry;
  try {
    const projected = images.project(value);
    const serialized = JSON.stringify(projected.payload);
    entry =
      Buffer.byteLength(serialized) > ENTRY_BYTES
        ? omission(id, "oversized")
        : { id, payload: projected.payload };
  } catch {
    entry = omission(id, "unserializable");
  }
  return { entry, key: JSON.stringify(entry) };
}

function boundedLiveEntries(values: readonly unknown[], images: ImageResolver): LiveEntry[] {
  const entries: LiveEntry[] = [];
  let bytes = 2;
  for (let index = 0; index < values.length; index += 1) {
    const id = rawId(values[index]) ?? `live-${index}`;
    let entry: LiveEntry;
    try {
      const projected = images.project(values[index]);
      entry = { id, payload: projected.payload };
    } catch {
      entry = { id, payload: { omitted: true, reason: "Live entry is not serializable" } };
    }
    let entryBytes = wireBytes(entry);
    if (entryBytes > ENTRY_BYTES || bytes + entryBytes + 1 > LIVE_TAIL_BYTES) {
      entry = { id, payload: { omitted: true, reason: "Live entry exceeds the display limit" } };
      entryBytes = wireBytes(entry);
    }
    bytes += entryBytes + (entries.length > 0 ? 1 : 0);
    entries.push(entry);
  }
  return entries;
}

function boundedHeader(value: unknown): Record<string, unknown> | null {
  try {
    const header = clone(value);
    if (header === null) return null;
    if (typeof header !== "object") return header as Record<string, unknown>;
    return wireBytes(header) <= ENTRY_BYTES ? (header as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function omission(id: string, reason: string): PersistedEntry {
  return { id, payload: { omitted: true, reason: `Entry omitted because it is ${reason}` } };
}

function liveId(value: unknown): boolean {
  return rawId(value)?.startsWith("live-") ?? false;
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
