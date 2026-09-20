import { Check } from "typebox/value";
import { isModelControlCapabilityValid, type Snapshot } from "../wire/schema.ts";
import {
  HistoryPageEnvelopeSchema,
  OperationBatchEnvelopeSchema,
  ResetEnvelopeSchema,
  SessionSnapshotEnvelopeSchema,
  type HistoryPageEnvelope,
  type OperationBatchEnvelope,
  type PersistedEntry,
  type ResetEnvelope,
  type SessionSnapshotData,
  type SessionSnapshotEnvelope,
} from "../wire/protocol.ts";

export const MAX_LOADED_ENTRIES = 5_000;

export interface SessionState {
  readonly generation: string;
  readonly revision: number;
  readonly snapshot: SessionSnapshotData;
}

export type RecoveryReason =
  | "invalid-envelope"
  | "invalid-snapshot"
  | "wrong-generation"
  | "stale-revision"
  | "revision-gap"
  | "invalid-revision"
  | "bad-append-anchor"
  | "duplicate-entry"
  | "bad-history-anchor"
  | "history-gap"
  | "history-limit";

export type SessionTransition =
  | { readonly status: "applied"; readonly state: SessionState }
  | {
      readonly status: "reset-needed";
      readonly state: SessionState | null;
      readonly reason: RecoveryReason;
    };

interface PersistedIdIndex {
  readonly base?: ReadonlySet<string>;
  readonly parent?: PersistedIdIndex;
  readonly added?: ReadonlySet<string>;
  readonly depth: number;
}

const entryArrayIndexes = new WeakMap<readonly PersistedEntry[], PersistedIdIndex>();
const stateIndexes = new WeakMap<SessionState, PersistedIdIndex>();
const MAX_INDEX_DEPTH = 32;

function hasPersistedId(index: PersistedIdIndex, id: string): boolean {
  let current: PersistedIdIndex | undefined = index;
  while (current) {
    if (current.added?.has(id) || current.base?.has(id)) return true;
    current = current.parent;
  }
  return false;
}

function flattenIndex(index: PersistedIdIndex): Set<string> {
  const result = new Set<string>();
  const chain: PersistedIdIndex[] = [];
  let current: PersistedIdIndex | undefined = index;
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  for (let position = chain.length - 1; position >= 0; position -= 1) {
    for (const id of chain[position].base ?? []) result.add(id);
    for (const id of chain[position].added ?? []) result.add(id);
  }
  return result;
}

function extendIndex(index: PersistedIdIndex, ids: ReadonlySet<string>): PersistedIdIndex {
  if (ids.size === 0) return index;
  if (index.depth >= MAX_INDEX_DEPTH) {
    const base = flattenIndex(index);
    for (const id of ids) base.add(id);
    return { base, depth: 0 };
  }
  return { parent: index, added: ids, depth: index.depth + 1 };
}

function indexFor(state: SessionState): PersistedIdIndex {
  const cached = stateIndexes.get(state);
  if (cached) return cached;
  const index = { base: new Set(state.snapshot.entries.map((entry) => entry.id)), depth: 0 };
  stateIndexes.set(state, index);
  return index;
}

function indexedState(state: SessionState, index: PersistedIdIndex): SessionState {
  stateIndexes.set(state, index);
  entryArrayIndexes.set(state.snapshot.entries, index);
  return state;
}

function recovery(state: SessionState | null, reason: RecoveryReason): SessionTransition {
  return { status: "reset-needed", state, reason };
}

function validSnapshot(snapshot: SessionSnapshotData): boolean {
  if (snapshot.modelControl !== undefined && !isModelControlCapabilityValid(snapshot.modelControl))
    return false;
  const ids = new Set<string>();
  for (const entry of snapshot.entries) {
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
  }
  const liveIds = new Set<string>();
  for (const entry of snapshot.liveTail) {
    if (liveIds.has(entry.id)) return false;
    liveIds.add(entry.id);
  }
  const firstId = snapshot.entries[0]?.id ?? null;
  if (snapshot.history.oldestEntryId !== firstId) return false;
  if (snapshot.history.hasMore !== (snapshot.history.beforeCursor !== null)) return false;
  entryArrayIndexes.set(snapshot.entries, { base: ids, depth: 0 });
  return true;
}
export function createSessionState(value: unknown): SessionTransition {
  if (!Check(SessionSnapshotEnvelopeSchema, value)) return recovery(null, "invalid-envelope");
  if (!validSnapshot(value.snapshot)) return recovery(null, "invalid-snapshot");
  const state = {
    generation: value.generation,
    revision: value.revision,
    snapshot: value.snapshot,
  };
  return {
    status: "applied",
    state: indexedState(state, entryArrayIndexes.get(value.snapshot.entries)!),
  };
}

export function applyOperationBatch(
  state: SessionState,
  value: OperationBatchEnvelope | unknown,
): SessionTransition {
  if (!Check(OperationBatchEnvelopeSchema, value)) return recovery(state, "invalid-envelope");
  if (value.generation !== state.generation) return recovery(state, "wrong-generation");
  if (value.fromRevision < state.revision || value.revision <= state.revision)
    return recovery(state, "stale-revision");
  if (value.fromRevision !== state.revision) return recovery(state, "revision-gap");
  if (value.revision <= value.fromRevision) return recovery(state, "invalid-revision");

  let snapshot = state.snapshot;
  const persistedIds = indexFor(state);
  const addedPersistedIds = new Set<string>();
  let rebuiltPersistedIndex = false;
  for (const operation of value.operations) {
    switch (operation.kind) {
      case "append": {
        const expectedAnchor = snapshot.entries.at(-1)?.id ?? null;
        if (operation.afterId !== expectedAnchor) return recovery(state, "bad-append-anchor");
        for (const entry of operation.entries) {
          if (hasPersistedId(persistedIds, entry.id) || addedPersistedIds.has(entry.id))
            return recovery(state, "duplicate-entry");
          addedPersistedIds.add(entry.id);
        }
        const appended = [...snapshot.entries, ...operation.entries];
        const entries =
          appended.length > MAX_LOADED_ENTRIES ? appended.slice(-MAX_LOADED_ENTRIES) : appended;
        if (entries.length !== appended.length) rebuiltPersistedIndex = true;
        snapshot = {
          ...snapshot,
          entries,
          leafId: operation.entries.at(-1)!.id,
          history: {
            ...snapshot.history,
            oldestEntryId: entries[0]?.id ?? null,
          },
        };
        break;
      }
      case "live-tail": {
        const ids = new Set<string>();
        for (const entry of operation.entries) {
          if (ids.has(entry.id)) return recovery(state, "duplicate-entry");
          ids.add(entry.id);
        }
        snapshot = { ...snapshot, liveTail: operation.entries };
        break;
      }
      case "metadata":
        snapshot = { ...snapshot, metadata: operation.metadata };
        break;
      case "queue":
        snapshot = { ...snapshot, queue: operation.queue };
        break;
      case "theme":
        snapshot = { ...snapshot, theme: operation.theme ?? undefined };
        break;
      case "running":
        snapshot = { ...snapshot, running: operation.running };
        break;
    }
  }
  const nextState = { generation: state.generation, revision: value.revision, snapshot };
  const nextIndex = rebuiltPersistedIndex
    ? { base: new Set(snapshot.entries.map((entry) => entry.id)), depth: 0 }
    : extendIndex(persistedIds, addedPersistedIds);
  return {
    status: "applied",
    state: indexedState(nextState, nextIndex),
  };
}

export function applyReset(
  state: SessionState | null,
  value: ResetEnvelope | unknown,
): SessionTransition {
  if (!Check(ResetEnvelopeSchema, value)) return recovery(state, "invalid-envelope");
  if (state && value.generation === state.generation && value.revision < state.revision)
    return recovery(state, "stale-revision");
  if (!validSnapshot(value.snapshot)) return recovery(state, "invalid-snapshot");
  const nextState = {
    generation: value.generation,
    revision: value.revision,
    snapshot: value.snapshot,
  };
  return {
    status: "applied",
    state: indexedState(nextState, entryArrayIndexes.get(value.snapshot.entries)!),
  };
}

export function prependHistoryPage(
  state: SessionState,
  value: HistoryPageEnvelope | unknown,
): SessionTransition {
  if (!Check(HistoryPageEnvelopeSchema, value)) return recovery(state, "invalid-envelope");
  if (value.generation !== state.generation) return recovery(state, "wrong-generation");
  if (value.historyGeneration !== state.snapshot.history.historyGeneration)
    return recovery(state, "history-gap");
  // Older-history application is orthogonal to newer live semantics. A page may be
  // computed at a revision that has since advanced through metadata/running/live-tail
  // updates or strict tail appends; none of those change the current oldest entry, so
  // the request revision does not need to match the live revision. Server authority
  // over the signed cursor lineage plus the current oldest anchor keep the prepend
  // sound, while a reset (new generation or a changed oldest anchor) still recovers.
  const firstId = state.snapshot.entries[0]?.id;
  if (!firstId || value.beforeId !== firstId) return recovery(state, "bad-history-anchor");
  if (value.hasMore !== (value.nextCursor !== null)) return recovery(state, "history-gap");
  if (state.snapshot.entries.length + value.entries.length > MAX_LOADED_ENTRIES)
    return recovery(state, "history-limit");

  const persistedIds = indexFor(state);
  const pageIds = new Set<string>();
  for (const entry of value.entries) {
    if (hasPersistedId(persistedIds, entry.id) || pageIds.has(entry.id))
      return recovery(state, "duplicate-entry");
    pageIds.add(entry.id);
  }

  const entries: PersistedEntry[] = [...value.entries, ...state.snapshot.entries];
  const nextState = {
    ...state,
    snapshot: {
      ...state.snapshot,
      entries,
      history: {
        historyGeneration: value.historyGeneration,
        beforeCursor: value.nextCursor,
        hasMore: value.hasMore,
        oldestEntryId: entries[0]?.id ?? null,
      },
    },
  };
  return {
    status: "applied",
    state: indexedState(nextState, extendIndex(persistedIds, pageIds)),
  };
}

export function applySessionEnvelope(
  state: SessionState | null,
  value: SessionSnapshotEnvelope | OperationBatchEnvelope | ResetEnvelope | unknown,
): SessionTransition {
  if (Check(SessionSnapshotEnvelopeSchema, value)) {
    if (state && value.generation === state.generation && value.revision < state.revision)
      return recovery(state, "stale-revision");
    return createSessionState(value);
  }
  if (Check(ResetEnvelopeSchema, value)) return applyReset(state, value);
  if (!state) return recovery(null, "invalid-envelope");
  return applyOperationBatch(state, value);
}

/** Lightweight shell selector that never materializes the loaded transcript. */
export function selectShellSnapshot(state: SessionState): Snapshot {
  return snapshotView(state, []);
}

/** Compatibility adapter for snapshot-based renderer fixtures. */
export function selectLegacySnapshot(state: SessionState): Snapshot {
  return snapshotView(state, [
    ...state.snapshot.entries.map((entry) => entry.payload),
    ...state.snapshot.liveTail.map((entry) => entry.payload),
  ]);
}

function snapshotView(state: SessionState, entries: unknown[]): Snapshot {
  const { snapshot } = state;
  return {
    header: snapshot.header,
    leafId: snapshot.leafId,
    ...(snapshot.imageAttachments === undefined
      ? {}
      : { imageAttachments: snapshot.imageAttachments }),
    ...(snapshot.pendingInputBroker === undefined
      ? {}
      : { pendingInputBroker: snapshot.pendingInputBroker }),
    ...(snapshot.modelControl === undefined ? {} : { modelControl: snapshot.modelControl }),
    ...(snapshot.sessionName === undefined ? {} : { sessionName: snapshot.sessionName }),
    isRunning: snapshot.running.isRunning,
    ...(snapshot.running.workingWord === undefined
      ? {}
      : { workingWord: snapshot.running.workingWord }),
    ...(snapshot.theme === undefined ? {} : { theme: snapshot.theme }),
    systemPrompt: snapshot.systemPrompt,
    ...(snapshot.metadata === undefined ? {} : { metadata: snapshot.metadata }),
    pendingInputs: snapshot.queue,
    entries,
  };
}
