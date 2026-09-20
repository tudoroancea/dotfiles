import type { RecoveryReason, SessionState } from "../client/session-state.ts";
import type {
  CommandCompletionEnvelope,
  CommandResponseEnvelope,
  HistoryPageEnvelope,
  ImageAttachmentCapability,
  OperationBatchEnvelope,
  OutboundImageAttachment,
  SessionCommand,
  SessionSnapshotEnvelope,
} from "../wire/protocol.ts";
import type { ModelControlCapability } from "../wire/schema.ts";
import type { SessionStateEnvelope } from "../wire/types.ts";

export const imageAttachmentCapabilityFixture = (): ImageAttachmentCapability => ({
  supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxAttachments: 3,
  maxBytesPerImage: 1024,
  maxTotalBytes: 2048,
  maxWidth: 1024,
  maxHeight: 1024,
  maxPixels: 1_000_000,
  maxTotalPixels: 1_500_000,
});

export const modelControlCapabilityFixture = (): ModelControlCapability => ({
  models: [
    { provider: "fixture", id: "model-1", name: "Fixture Model" },
    { provider: "fixture", id: "model-2", name: "Fixture Model 2" },
  ],
  thinkingLevels: ["off", "low", "medium", "high"],
});

/** Canonical bounded 1×1 PNG used by host-neutral attachment preflight tests. */
export const outboundImageAttachmentFixture = (): OutboundImageAttachment => ({
  type: "image-attachment",
  mimeType: "image/png",
  width: 1,
  height: 1,
  byteLength: 68,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
});

export function sessionSnapshotFixture(): SessionSnapshotEnvelope {
  return {
    version: 1,
    type: "snapshot",
    generation: "fixture-generation-1",
    revision: 3,
    snapshot: {
      commandEpoch: "fixture-command-epoch-1",
      modelControl: modelControlCapabilityFixture(),
      header: { id: "fixture-session" },
      leafId: "entry-2",
      sessionName: "Protocol fixture",
      systemPrompt: "",
      entries: [
        { id: "entry-1", payload: { type: "message", text: "one" } },
        { id: "entry-2", payload: { type: "message", text: "two" } },
      ],
      liveTail: [],
      history: {
        historyGeneration: "fixture-history",
        beforeCursor: "older-page",
        hasMore: true,
        oldestEntryId: "entry-1",
      },
      metadata: { cwd: "/repo", home: "/home/test", sessionCost: 0 },
      queue: [],
      running: { isRunning: false },
    },
  };
}

export function appendOperationFixture(): OperationBatchEnvelope {
  return {
    version: 1,
    type: "operations",
    generation: "fixture-generation-1",
    fromRevision: 3,
    revision: 4,
    operations: [
      {
        kind: "append",
        afterId: "entry-2",
        entries: [{ id: "entry-3", payload: { type: "message", text: "three" } }],
      },
    ],
  };
}

export interface CoreConformanceStep {
  name: string;
  reducer: "session" | "history";
  input: SessionStateEnvelope | HistoryPageEnvelope;
  expected: SessionState;
}

export interface InvalidCoreConformanceFixture {
  name: string;
  reducer: "session" | "history";
  input: unknown;
  expectedReason: RecoveryReason;
}

/**
 * Draft Phase 3 core stream with literal expected reducer states. It deliberately
 * leaves transcript payloads opaque and is not the frozen cross-host v1 suite.
 */
export function coreConformanceScenario(): {
  initial: SessionSnapshotEnvelope;
  steps: CoreConformanceStep[];
  commandCases: {
    beforeReset: SessionCommand;
    afterReset: SessionCommand;
    staleAfterReset: SessionCommand;
  };
  commandOutcomes: {
    accepted: CommandResponseEnvelope;
    rejected: CommandResponseEnvelope;
    completed: CommandCompletionEnvelope;
    failed: CommandCompletionEnvelope;
  };
} {
  const initial = sessionSnapshotFixture();
  const operation: OperationBatchEnvelope = {
    ...appendOperationFixture(),
    operations: [
      ...appendOperationFixture().operations,
      { kind: "live-tail", entries: [{ id: "live-1", payload: { text: "streaming" } }] },
      {
        kind: "metadata",
        metadata: {
          cwd: "/repo",
          home: "/home/test",
          sessionCost: 1.25,
          model: { provider: "fixture", id: "model-1", name: "Fixture Model" },
          thinkingLevel: "high",
        },
      },
      { kind: "queue", queue: [{ id: "queued-1", content: "later", delivery: "followUp" }] },
      { kind: "theme", theme: { auto: false, light: { bg: "#fff" }, dark: { bg: "#000" } } },
      { kind: "running", running: { isRunning: true, workingWord: "Working" } },
    ],
  };
  const afterOperation: SessionState = {
    generation: initial.generation,
    revision: 4,
    snapshot: {
      ...initial.snapshot,
      leafId: "entry-3",
      entries: [
        ...initial.snapshot.entries,
        { id: "entry-3", payload: { type: "message", text: "three" } },
      ],
      liveTail: [{ id: "live-1", payload: { text: "streaming" } }],
      metadata: {
        cwd: "/repo",
        home: "/home/test",
        sessionCost: 1.25,
        model: { provider: "fixture", id: "model-1", name: "Fixture Model" },
        thinkingLevel: "high",
      },
      queue: [{ id: "queued-1", content: "later", delivery: "followUp" }],
      theme: { auto: false, light: { bg: "#fff" }, dark: { bg: "#000" } },
      running: { isRunning: true, workingWord: "Working" },
    },
  };
  const history: HistoryPageEnvelope = {
    version: 1,
    type: "history-page",
    generation: initial.generation,
    revision: 4,
    historyGeneration: initial.snapshot.history.historyGeneration,
    beforeId: "entry-1",
    entries: [{ id: "entry-0", payload: { type: "message", text: "zero" } }],
    nextCursor: null,
    hasMore: false,
  };
  const afterHistory: SessionState = {
    ...afterOperation,
    snapshot: {
      ...afterOperation.snapshot,
      entries: [history.entries[0], ...afterOperation.snapshot.entries],
      history: {
        historyGeneration: history.historyGeneration,
        beforeCursor: null,
        hasMore: false,
        oldestEntryId: "entry-0",
      },
    },
  };
  const reset: SessionStateEnvelope = {
    ...initial,
    type: "reset",
    generation: initial.generation,
    revision: 5,
    reason: "branch changed",
    snapshot: {
      ...initial.snapshot,
      commandEpoch: "fixture-command-epoch-2",
      leafId: "branch-entry-1",
      entries: [{ id: "branch-entry-1", payload: { type: "message", text: "branch" } }],
      liveTail: [],
      history: {
        historyGeneration: "fixture-history-2",
        beforeCursor: null,
        hasMore: false,
        oldestEntryId: "branch-entry-1",
      },
      queue: [],
      running: { isRunning: false },
    },
  };
  const afterReset: SessionState = {
    generation: reset.generation,
    revision: reset.revision,
    snapshot: reset.snapshot,
  };
  const beforeResetCommand: SessionCommand = {
    version: 1,
    type: "command",
    commandId: "fixture-command-1",
    generation: initial.generation,
    commandEpoch: initial.snapshot.commandEpoch,
    content: "before reset",
    delivery: "immediate",
  };
  const afterResetCommand: SessionCommand = {
    ...beforeResetCommand,
    commandId: "fixture-command-2",
    commandEpoch: reset.snapshot.commandEpoch,
    content: "after reset",
  };
  const commandBase = {
    version: 1 as const,
    type: "command-response" as const,
    commandId: beforeResetCommand.commandId,
    generation: beforeResetCommand.generation,
    commandEpoch: beforeResetCommand.commandEpoch,
  };
  const completionBase = {
    version: 1 as const,
    type: "command-completion" as const,
    commandId: commandBase.commandId,
    generation: commandBase.generation,
    commandEpoch: commandBase.commandEpoch,
    revision: 5,
  };

  return {
    initial,
    steps: [
      {
        name: "all replaceable domains and durable append",
        reducer: "session",
        input: operation,
        expected: afterOperation,
      },
      { name: "older history prepend", reducer: "history", input: history, expected: afterHistory },
      {
        name: "authoritative branch reset",
        reducer: "session",
        input: reset,
        expected: afterReset,
      },
    ],
    commandCases: {
      beforeReset: beforeResetCommand,
      afterReset: afterResetCommand,
      staleAfterReset: { ...beforeResetCommand },
    },
    commandOutcomes: {
      accepted: { ...commandBase, accepted: true },
      rejected: { ...commandBase, accepted: false, error: "Rejected by fixture host" },
      completed: { ...completionBase, status: "completed" },
      failed: { ...completionBase, status: "failed", error: "Fixture turn failed" },
    },
  };
}

/** Invalid core inputs published for producer and reducer recovery conformance. */
export function invalidCoreConformanceFixtures(): InvalidCoreConformanceFixture[] {
  const initial = sessionSnapshotFixture();
  const append = appendOperationFixture();
  const history = coreConformanceScenario().steps[1].input as HistoryPageEnvelope;
  return [
    {
      name: "stale authoritative snapshot",
      reducer: "session",
      input: { ...initial, revision: initial.revision - 1 },
      expectedReason: "stale-revision",
    },
    {
      name: "wrong operation generation",
      reducer: "session",
      input: { ...append, generation: "fixture-generation-other" },
      expectedReason: "wrong-generation",
    },
    {
      name: "operation revision gap",
      reducer: "session",
      input: { ...append, fromRevision: initial.revision + 1, revision: initial.revision + 2 },
      expectedReason: "revision-gap",
    },
    {
      name: "duplicate durable identity",
      reducer: "session",
      input: {
        ...append,
        operations: [
          { kind: "append", afterId: "entry-2", entries: [{ id: "entry-2", payload: null }] },
        ],
      },
      expectedReason: "duplicate-entry",
    },
    {
      name: "bad append anchor",
      reducer: "session",
      input: {
        ...append,
        operations: [{ ...append.operations[0], afterId: "entry-1" }],
      },
      expectedReason: "bad-append-anchor",
    },
    {
      name: "empty no-progress history page",
      reducer: "history",
      input: { ...history, entries: [] },
      expectedReason: "invalid-envelope",
    },
    {
      name: "bad history anchor",
      reducer: "history",
      input: { ...history, beforeId: "entry-2" },
      expectedReason: "bad-history-anchor",
    },
  ];
}
