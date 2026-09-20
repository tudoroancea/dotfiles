import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  CommandCompletionEnvelopeSchema,
  CommandResponseEnvelopeSchema,
  CompletionResultEnvelopeSchema,
  ErrorEnvelopeSchema,
  GenerationSchema,
  HistoryPageEnvelopeSchema,
  HistoryRequestSchema,
  isModelControlCapabilityValid,
  isModelControlResponseEnvelope,
  LIMITS,
  ModelControlCapabilitySchema,
  ModelControlResponseEnvelopeSchema,
  ModelControlCommandSchema,
  OperationBatchEnvelopeSchema,
  PersistedEntrySchema,
  ResetEnvelopeSchema,
  RevisionSchema,
  ServerEnvelopeSchema,
  SessionCommandSchema,
  SessionSnapshotEnvelopeSchema,
  SetModelCommandSchema,
  SetThinkingCommandSchema,
  ThinkingLevelSchema,
} from "../src/wire/index.ts";
import { appendOperationFixture, sessionSnapshotFixture } from "../src/testing/index.ts";

const snapshot = sessionSnapshotFixture();

test("v1 snapshot and operation envelopes are strict and bounded", () => {
  assert.ok(Check(SessionSnapshotEnvelopeSchema, snapshot));
  assert.ok(Check(OperationBatchEnvelopeSchema, appendOperationFixture()));
  assert.equal(Check(SessionSnapshotEnvelopeSchema, { ...snapshot, extra: true }), false);
  assert.equal(Check(SessionSnapshotEnvelopeSchema, { ...snapshot, version: 2 }), false);
  assert.equal(
    Check(OperationBatchEnvelopeSchema, {
      ...appendOperationFixture(),
      operations: [{ kind: "unknown" }],
    }),
    false,
  );
  assert.equal(
    Check(OperationBatchEnvelopeSchema, {
      ...appendOperationFixture(),
      operations: Array(LIMITS.maxOperations + 1).fill(appendOperationFixture().operations[0]),
    }),
    false,
  );
  assert.equal(
    Check(SessionSnapshotEnvelopeSchema, {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        entries: Array.from({ length: LIMITS.maxSnapshotEntries + 1 }, (_, index) => ({
          id: `entry-${index}`,
          payload: null,
        })),
      },
    }),
    false,
  );
});

test("generation and revision primitives reject unsafe values", () => {
  for (const value of ["generation-1", "a.b_c~d"]) assert.ok(Check(GenerationSchema, value));
  for (const value of ["", "space bad", "x".repeat(LIMITS.maxGenerationChars + 1), 3])
    assert.equal(Check(GenerationSchema, value), false);
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) assert.ok(Check(RevisionSchema, value));
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])
    assert.equal(Check(RevisionSchema, value), false);
});

test("opaque persisted payloads retain stable bounded wrapper identities", () => {
  assert.ok(Check(PersistedEntrySchema, { id: "durable-1", payload: { arbitrary: [1, true] } }));
  assert.ok(Check(PersistedEntrySchema, { id: "durable-2", payload: null }));
  assert.equal(Check(PersistedEntrySchema, { id: "", payload: {} }), false);
  assert.equal(
    Check(PersistedEntrySchema, {
      id: "x".repeat(LIMITS.maxIdentityChars + 1),
      payload: {},
    }),
    false,
  );
  assert.equal(Check(PersistedEntrySchema, { id: "x", payload: {}, raw: true }), false);
});

test("reset and history contracts carry generation, revision, anchors, and bounds", () => {
  const reset = { ...snapshot, type: "reset", reason: "branch changed" };
  assert.ok(Check(ResetEnvelopeSchema, reset));
  assert.equal(Check(ResetEnvelopeSchema, { ...reset, reason: "" }), false);
  const request = {
    version: 1,
    type: "history-request",
    generation: snapshot.generation,
    revision: snapshot.revision,
    historyGeneration: snapshot.snapshot.history.historyGeneration,
    beforeCursor: "older-page",
    beforeId: "entry-1",
    limit: 100,
  };
  assert.ok(Check(HistoryRequestSchema, request));
  assert.equal(Check(HistoryRequestSchema, { ...request, limit: 0 }), false);
  assert.equal(
    Check(HistoryRequestSchema, { ...request, limit: LIMITS.maxHistoryPageSize + 1 }),
    false,
  );
  const page = {
    version: 1,
    type: "history-page",
    generation: snapshot.generation,
    revision: snapshot.revision,
    historyGeneration: snapshot.snapshot.history.historyGeneration,
    beforeId: "entry-1",
    entries: [{ id: "entry-0", payload: "opaque" }],
    nextCursor: null,
    hasMore: false,
  };
  assert.ok(Check(HistoryPageEnvelopeSchema, page));
  assert.equal(Check(HistoryPageEnvelopeSchema, { ...page, entries: [] }), false);
  assert.equal(Check(HistoryPageEnvelopeSchema, { ...page, unexpected: 1 }), false);
});

test("command admission and eventual completion are distinct strict unions", () => {
  const command = {
    version: 1,
    type: "command",
    commandId: "command-1",
    generation: snapshot.generation,
    commandEpoch: snapshot.snapshot.commandEpoch,
    content: "hello",
    delivery: "immediate",
  };
  assert.ok(Check(SessionCommandSchema, command));
  assert.equal(Check(SessionCommandSchema, { ...command, commandId: undefined }), false);
  assert.equal(Check(SessionCommandSchema, { ...command, attachments: [] }), false);
  assert.equal(Check(SessionCommandSchema, { ...command, type: "image-command" }), false);
  const accepted = {
    version: 1,
    type: "command-response",
    commandId: command.commandId,
    generation: command.generation,
    commandEpoch: command.commandEpoch,
    accepted: true,
  };
  assert.ok(Check(CommandResponseEnvelopeSchema, accepted));
  assert.equal(Check(CommandResponseEnvelopeSchema, { ...accepted, status: "completed" }), false);
  assert.equal(Check(CommandResponseEnvelopeSchema, { ...accepted, error: "not allowed" }), false);
  assert.ok(
    Check(CommandCompletionEnvelopeSchema, {
      version: 1,
      type: "command-completion",
      commandId: command.commandId,
      generation: command.generation,
      commandEpoch: command.commandEpoch,
      revision: 4,
      status: "completed",
    }),
  );
  assert.equal(
    Check(CommandCompletionEnvelopeSchema, {
      version: 1,
      type: "command-completion",
      commandId: command.commandId,
      generation: command.generation,
      commandEpoch: command.commandEpoch,
      revision: 4,
      status: "failed",
    }),
    false,
  );
});

test("model control capability and commands are strict, bounded, and separate from prompts", () => {
  const capability = snapshot.snapshot.modelControl;
  assert.ok(Check(ModelControlCapabilitySchema, capability));
  assert.ok(isModelControlCapabilityValid(capability));
  const duplicateIdentity = {
    ...capability,
    models: [capability.models[0], { ...capability.models[0], name: "Duplicate identity" }],
  };
  assert.ok(Check(ModelControlCapabilitySchema, duplicateIdentity));
  assert.equal(isModelControlCapabilityValid(duplicateIdentity), false);
  assert.equal(
    Check(ModelControlCapabilitySchema, {
      ...capability,
      models: Array.from({ length: LIMITS.maxModelChoices + 1 }, (_, index) => ({
        provider: "fixture",
        id: `model-${index}`,
        name: `Model ${index}`,
      })),
    }),
    false,
  );
  assert.equal(
    Check(ModelControlCapabilitySchema, { ...capability, thinkingLevels: ["high", "high"] }),
    false,
  );
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    assert.ok(Check(ThinkingLevelSchema, level));
  assert.equal(Check(ThinkingLevelSchema, "extreme"), false);

  const base = {
    version: 1,
    commandId: "model-control-1",
    generation: snapshot.generation,
    commandEpoch: snapshot.snapshot.commandEpoch,
  };
  const setModel = {
    ...base,
    type: "set-model",
    provider: "fixture",
    modelId: "model-1",
  };
  const setThinking = { ...base, type: "set-thinking", thinkingLevel: "high" };
  assert.ok(Check(SetModelCommandSchema, setModel));
  assert.ok(Check(SetThinkingCommandSchema, setThinking));
  assert.ok(Check(ModelControlCommandSchema, setModel));
  assert.ok(Check(ModelControlCommandSchema, setThinking));
  assert.equal(Check(SetModelCommandSchema, { ...setModel, extra: true }), false);
  assert.equal(
    Check(SetModelCommandSchema, {
      ...setModel,
      modelId: "x".repeat(LIMITS.maxModelIdChars + 1),
    }),
    false,
  );
  assert.equal(
    Check(SetThinkingCommandSchema, { ...setThinking, thinkingLevel: "extreme" }),
    false,
  );
  assert.equal(Check(SessionCommandSchema, setModel), false);
});

test("model control responses require a model-control rejection reason", () => {
  const base = {
    version: 1,
    type: "command-response",
    commandId: "model-control-1",
    generation: snapshot.generation,
    commandEpoch: snapshot.snapshot.commandEpoch,
  };
  assert.ok(isModelControlResponseEnvelope({ ...base, accepted: true }));
  for (const reason of ["capability-off", "invalid", "queue-busy", "session-changed"]) {
    const rejected = { ...base, accepted: false, error: "Rejected", reason };
    assert.ok(Check(ModelControlResponseEnvelopeSchema, rejected));
    assert.ok(isModelControlResponseEnvelope(rejected));
  }
  assert.equal(
    isModelControlResponseEnvelope({ ...base, accepted: false, error: "Missing reason" }),
    false,
  );
  assert.equal(
    isModelControlResponseEnvelope({
      ...base,
      accepted: false,
      error: "Queue-only reason",
      reason: "stale-item",
    }),
    false,
  );
  assert.equal(
    isModelControlResponseEnvelope({ ...base, accepted: true, reason: "invalid" }),
    false,
  );
});

test("authoritative metadata accepts only declared thinking levels", () => {
  const withMetadata = {
    ...snapshot,
    snapshot: {
      ...snapshot.snapshot,
      metadata: {
        cwd: "/repo",
        home: "/home/test",
        sessionCost: 0,
        thinkingLevel: "max",
      },
    },
  };
  assert.ok(Check(SessionSnapshotEnvelopeSchema, withMetadata));
  assert.equal(
    Check(SessionSnapshotEnvelopeSchema, {
      ...withMetadata,
      snapshot: {
        ...withMetadata.snapshot,
        metadata: { ...withMetadata.snapshot.metadata, thinkingLevel: "extreme" },
      },
    }),
    false,
  );
});

test("completion and error envelopes are versioned, strict, and bounded", () => {
  const completion = {
    version: 1,
    type: "completion-response",
    generation: snapshot.generation,
    items: [{ value: "@src", label: "src" }],
  };
  assert.ok(Check(CompletionResultEnvelopeSchema, completion));
  assert.equal(Check(CompletionResultEnvelopeSchema, { ...completion, revision: 1 }), false);
  const error = {
    version: 1,
    type: "error",
    generation: snapshot.generation,
    code: "STALE_GENERATION",
    message: "Reconnect",
    recoverable: true,
  };
  assert.ok(Check(ErrorEnvelopeSchema, error));
  assert.ok(Check(ServerEnvelopeSchema, error));
  assert.equal(Check(ErrorEnvelopeSchema, { ...error, code: "bad-code" }), false);
  assert.equal(Check(ServerEnvelopeSchema, { version: 1, type: "mystery" }), false);
});
