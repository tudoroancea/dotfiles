import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOperationBatch,
  applyReset,
  applySessionEnvelope,
  createSessionState,
  prependHistoryPage,
  selectLegacySnapshot,
  selectShellSnapshot,
} from "../src/client/index.tsx";
import { appendOperationFixture, sessionSnapshotFixture } from "../src/testing/index.ts";

function initialState() {
  const result = createSessionState(sessionSnapshotFixture());
  assert.equal(result.status, "applied");
  return result.state;
}

function expectRecovery(result, reason, original) {
  assert.equal(result.status, "reset-needed");
  assert.equal(result.reason, reason);
  if (original) assert.equal(result.state, original, "failed transitions preserve state identity");
}

test("snapshot decoding rejects non-authoritative thinking levels and malformed capabilities", () => {
  const invalidThinking = sessionSnapshotFixture();
  invalidThinking.snapshot.metadata = {
    cwd: "/repo",
    home: "/home/test",
    sessionCost: 0,
    thinkingLevel: "extreme",
  };
  expectRecovery(createSessionState(invalidThinking), "invalid-envelope");

  const invalidCapability = sessionSnapshotFixture();
  invalidCapability.snapshot.modelControl = {
    ...invalidCapability.snapshot.modelControl,
    unexpected: true,
  };
  expectRecovery(createSessionState(invalidCapability), "invalid-envelope");

  const duplicateIdentity = sessionSnapshotFixture();
  duplicateIdentity.snapshot.modelControl.models[1] = {
    ...duplicateIdentity.snapshot.modelControl.models[0],
    name: "Same identity, different label",
  };
  expectRecovery(createSessionState(duplicateIdentity), "invalid-snapshot");
});

test("operation batches append durable entries and replace independent domains atomically", () => {
  const state = initialState();
  const frame = appendOperationFixture();
  frame.operations.push(
    { kind: "live-tail", entries: [{ id: "live-1", payload: { text: "streaming" } }] },
    { kind: "queue", queue: [{ id: "queued", content: "later", delivery: "followUp" }] },
    { kind: "running", running: { isRunning: true, workingWord: "Working" } },
    {
      kind: "metadata",
      metadata: { cwd: "/next", home: "/home/test", sessionCost: 2 },
    },
    { kind: "theme", theme: null },
  );
  const result = applyOperationBatch(state, frame);
  assert.equal(result.status, "applied");
  assert.equal(result.state.revision, 4);
  assert.deepEqual(
    result.state.snapshot.entries.map((entry) => entry.id),
    ["entry-1", "entry-2", "entry-3"],
  );
  assert.equal(result.state.snapshot.liveTail[0].id, "live-1");
  assert.equal(result.state.snapshot.queue[0].id, "queued");
  assert.equal(result.state.snapshot.running.isRunning, true);
  assert.equal(result.state.snapshot.metadata.cwd, "/next");
  assert.equal(result.state.snapshot.theme, undefined);
  assert.equal(state.snapshot.entries.length, 2, "input state remains immutable");
});

test("revision and generation failures request recovery without partial application", () => {
  const state = initialState();
  for (const [patch, reason] of [
    [{ generation: "other-generation" }, "wrong-generation"],
    [{ fromRevision: 2, revision: 3 }, "stale-revision"],
    [{ fromRevision: 4, revision: 5 }, "revision-gap"],
    [{ fromRevision: 3, revision: 3 }, "stale-revision"],
  ]) {
    expectRecovery(
      applyOperationBatch(state, { ...appendOperationFixture(), ...patch }),
      reason,
      state,
    );
  }

  const partiallyValid = appendOperationFixture();
  partiallyValid.operations.push({
    kind: "append",
    afterId: "wrong-anchor",
    entries: [{ id: "entry-4", payload: {} }],
  });
  expectRecovery(applyOperationBatch(state, partiallyValid), "bad-append-anchor", state);
  assert.equal(state.snapshot.entries.length, 2);
});

test("append anchors and identities reject gaps and duplicates", () => {
  const state = initialState();
  expectRecovery(
    applyOperationBatch(state, {
      ...appendOperationFixture(),
      operations: [
        {
          kind: "append",
          afterId: "entry-1",
          entries: [{ id: "entry-3", payload: {} }],
        },
      ],
    }),
    "bad-append-anchor",
    state,
  );
  for (const entries of [
    [{ id: "entry-2", payload: {} }],
    [
      { id: "new", payload: {} },
      { id: "new", payload: {} },
    ],
  ]) {
    expectRecovery(
      applyOperationBatch(state, {
        ...appendOperationFixture(),
        operations: [{ kind: "append", afterId: "entry-2", entries }],
      }),
      "duplicate-entry",
      state,
    );
  }
});

test("valid reset replaces generation and state while invalid reset preserves prior state", () => {
  const state = initialState();
  const source = sessionSnapshotFixture();
  const reset = {
    ...source,
    type: "reset",
    generation: "fixture-generation-2",
    revision: 0,
    reason: "new branch",
  };
  const result = applyReset(state, reset);
  assert.equal(result.status, "applied");
  assert.equal(result.state.generation, "fixture-generation-2");
  const duplicateSnapshot = {
    ...reset,
    snapshot: {
      ...reset.snapshot,
      entries: [reset.snapshot.entries[0], reset.snapshot.entries[0]],
    },
  };
  expectRecovery(applyReset(state, duplicateSnapshot), "invalid-snapshot", state);
});

test("same-generation authoritative frames cannot rewind state", () => {
  const state = initialState();
  const staleSnapshot = { ...sessionSnapshotFixture(), revision: state.revision - 1 };
  expectRecovery(applySessionEnvelope(state, staleSnapshot), "stale-revision", state);
  expectRecovery(
    applyReset(state, { ...staleSnapshot, type: "reset", reason: "late reset" }),
    "stale-revision",
    state,
  );

  const equalSnapshot = { ...sessionSnapshotFixture(), revision: state.revision };
  assert.equal(applySessionEnvelope(state, equalSnapshot).status, "applied");
  const newGeneration = {
    ...sessionSnapshotFixture(),
    generation: "fixture-generation-2",
    revision: 0,
  };
  assert.equal(applySessionEnvelope(state, newGeneration).status, "applied");
});

test("history pages prepend only at the current boundary without gaps or duplicates", () => {
  const state = initialState();
  const page = {
    version: 1,
    type: "history-page",
    generation: state.generation,
    revision: state.revision,
    historyGeneration: state.snapshot.history.historyGeneration,
    beforeId: "entry-1",
    entries: [
      { id: "entry--1", payload: { text: "oldest" } },
      { id: "entry-0", payload: { text: "older" } },
    ],
    nextCursor: null,
    hasMore: false,
  };
  const result = prependHistoryPage(state, page);
  assert.equal(result.status, "applied");
  assert.deepEqual(
    result.state.snapshot.entries.map((entry) => entry.id),
    ["entry--1", "entry-0", "entry-1", "entry-2"],
  );
  assert.deepEqual(result.state.snapshot.history, {
    historyGeneration: state.snapshot.history.historyGeneration,
    beforeCursor: null,
    hasMore: false,
    oldestEntryId: "entry--1",
  });
  expectRecovery(
    prependHistoryPage(state, { ...page, beforeId: "entry-2" }),
    "bad-history-anchor",
    state,
  );
  expectRecovery(
    prependHistoryPage(state, { ...page, entries: [{ id: "entry-2", payload: {} }] }),
    "duplicate-entry",
    state,
  );
  expectRecovery(
    prependHistoryPage(state, { ...page, nextCursor: "still-more", hasMore: false }),
    "history-gap",
    state,
  );
  expectRecovery(
    prependHistoryPage(state, { ...page, historyGeneration: "stale-history" }),
    "history-gap",
    state,
  );
  expectRecovery(prependHistoryPage(state, { ...page, entries: [] }), "invalid-envelope", state);
});

test("history pages apply across live revision drift while resets still recover", () => {
  const state = initialState();
  const page = {
    version: 1,
    type: "history-page",
    generation: state.generation,
    revision: state.revision,
    historyGeneration: state.snapshot.history.historyGeneration,
    beforeId: "entry-1",
    entries: [{ id: "entry-0", payload: { text: "older" } }],
    nextCursor: null,
    hasMore: false,
  };

  // A page computed at a revision that has since advanced (metadata/running/live-tail
  // updates or strict tail appends) still applies: the oldest anchor is unchanged and
  // the server owns the signed cursor lineage. Older revisions are equally fine.
  for (const revision of [state.revision + 5, Math.max(0, state.revision - 2)]) {
    const result = prependHistoryPage(state, { ...page, revision });
    assert.equal(result.status, "applied", `revision ${revision} applies`);
    assert.deepEqual(
      result.state.snapshot.entries.map((entry) => entry.id),
      ["entry-0", "entry-1", "entry-2"],
    );
    // The prepend never rewinds the live revision it inherits.
    assert.equal(result.state.revision, state.revision);
  }

  // A reset still invalidates: a different generation, or a changed oldest anchor
  // (a fresh branch snapshot with a different first entry), recovers rather than
  // corrupting state by prepending across the boundary.
  expectRecovery(
    prependHistoryPage(state, { ...page, generation: "fixture-generation-2" }),
    "wrong-generation",
    state,
  );
  expectRecovery(
    prependHistoryPage(state, { ...page, beforeId: "post-reset-entry" }),
    "bad-history-anchor",
    state,
  );
});

test("append and history validation use the incremental persisted-id index", () => {
  let state = initialState();
  let reads = 0;
  state.snapshot.entries = state.snapshot.entries.map((entry) => ({
    get id() {
      reads += 1;
      return entry.id;
    },
    payload: entry.payload,
  }));

  const appended = applyOperationBatch(state, appendOperationFixture());
  assert.equal(appended.status, "applied");
  assert.ok(reads <= 2, `append inspected ${reads} retained identities`);
  if (appended.status !== "applied") return;
  state = appended.state;

  reads = 0;
  const page = {
    version: 1,
    type: "history-page",
    generation: state.generation,
    revision: state.revision,
    historyGeneration: state.snapshot.history.historyGeneration,
    beforeId: state.snapshot.entries[0].id,
    entries: [{ id: "entry-0", payload: null }],
    nextCursor: null,
    hasMore: false,
  };
  reads = 0;
  const prepended = prependHistoryPage(state, page);
  assert.equal(prepended.status, "applied");
  assert.ok(reads <= 2, `history prepend inspected ${reads} retained identities`);
});

test("legacy selector unwraps opaque payloads and live rows for current renderers", () => {
  const state = initialState();
  const result = applyOperationBatch(state, {
    ...appendOperationFixture(),
    operations: [{ kind: "live-tail", entries: [{ id: "live", payload: { id: "render-live" } }] }],
  });
  assert.equal(result.status, "applied");
  const snapshot = selectLegacySnapshot(result.state);
  const shell = selectShellSnapshot(result.state);
  assert.deepEqual(snapshot.entries.at(-1), { id: "render-live" });
  assert.equal(snapshot.pendingInputs, result.state.snapshot.queue);
  assert.equal(snapshot.modelControl, result.state.snapshot.modelControl);
  assert.equal(shell.modelControl, result.state.snapshot.modelControl);
  assert.deepEqual(shell.entries, []);
  assert.equal(snapshot.isRunning, false);
});
