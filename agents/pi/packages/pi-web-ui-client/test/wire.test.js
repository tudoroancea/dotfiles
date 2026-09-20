import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  CommandAcceptanceSchema,
  CompletionItemSchema,
  CompletionRequestSchema,
  CompletionResponseSchema,
  ContextUsageSchema,
  decodeCommandAcceptance,
  decodeCompletionResponse,
  decodeSnapshot,
  isCommandAcceptance,
  isCompletionRequest,
  isSnapshot,
  isSubmittedCommand,
  LIMITS,
  PendingInputBrokerCapabilitySchema,
  PendingInputSchema,
  QueueEditCommandSchema,
  QueueMutationCommandSchema,
  QueueRemoveCommandSchema,
  SessionMetadataSchema,
  SessionModelSchema,
  SnapshotSchema,
  SnapshotThemeSchema,
  SubmittedCommandSchema,
  ThemePaletteSchema,
} from "../src/wire/index.ts";
import { broadSnapshot, generateLargeSession } from "../src/testing/index.ts";

function minimalSnapshot(overrides = {}) {
  return {
    header: null,
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
    ...overrides,
  };
}

test("all current snapshot DTO schemas accept representative values", () => {
  const palette = { text: "#ffffff" };
  const theme = { auto: false, light: palette, dark: palette };
  const usage = { tokens: null, contextWindow: 128_000, percent: null };
  const model = { provider: "provider", id: "model-id", name: "Model" };
  const metadata = {
    cwd: "/repo",
    home: "/home/user",
    contextUsage: usage,
    sessionCost: 1.25,
    model,
    thinkingLevel: "high",
  };
  const pending = { id: "pending-1", content: "hello", delivery: "steer" };
  assert.ok(Check(ThemePaletteSchema, palette));
  assert.ok(Check(SnapshotThemeSchema, theme));
  assert.ok(Check(ContextUsageSchema, usage));
  assert.ok(Check(SessionModelSchema, model));
  assert.ok(Check(SessionMetadataSchema, metadata));
  assert.ok(Check(PendingInputSchema, pending));
  assert.ok(isSnapshot(minimalSnapshot({ theme, metadata, pendingInputs: [pending] })));
  assert.ok(decodeSnapshot(broadSnapshot()));
});

test("broker queue rows and mutation commands are strict and bounded", () => {
  const capability = { edit: true, remove: true };
  const row = {
    id: "broker-row",
    content: "queued",
    delivery: "followUp",
    itemVersion: 1,
    attachmentCount: 2,
    editable: true,
    state: "held",
  };
  assert.ok(Check(PendingInputBrokerCapabilitySchema, capability));
  assert.ok(Check(PendingInputSchema, row));
  assert.equal(Check(PendingInputSchema, { ...row, extra: true }), false);
  const base = {
    version: 1,
    commandId: "queue-command",
    generation: "generation",
    commandEpoch: "epoch",
    itemId: "broker-row",
    expectedItemVersion: 1,
  };
  assert.ok(Check(QueueEditCommandSchema, { ...base, type: "queue-edit", content: "edited" }));
  assert.ok(Check(QueueRemoveCommandSchema, { ...base, type: "queue-remove" }));
  assert.ok(Check(QueueMutationCommandSchema, { ...base, type: "queue-remove" }));
  assert.equal(
    Check(QueueEditCommandSchema, {
      ...base,
      type: "queue-edit",
      content: "x".repeat(LIMITS.maxInputChars + 1),
    }),
    false,
  );
  assert.equal(
    Check(QueueRemoveCommandSchema, { ...base, type: "queue-remove", extra: true }),
    false,
  );
});

test("strict snapshot envelopes reject missing, extra, and malformed fields", () => {
  assert.equal(decodeSnapshot(null), null);
  assert.equal(decodeSnapshot("string"), null);
  for (const field of [
    "header",
    "leafId",
    "isRunning",
    "systemPrompt",
    "pendingInputs",
    "entries",
  ]) {
    const value = minimalSnapshot();
    delete value[field];
    assert.equal(decodeSnapshot(value), null, `missing ${field}`);
  }
  assert.equal(decodeSnapshot(minimalSnapshot({ extra: true })), null);
  assert.equal(decodeSnapshot(minimalSnapshot({ isRunning: "yes" })), null);
  assert.equal(decodeSnapshot(minimalSnapshot({ leafId: 42 })), null);
  assert.equal(
    decodeSnapshot(
      minimalSnapshot({ pendingInputs: [{ id: "x", content: "x", delivery: "immediate" }] }),
    ),
    null,
  );
  assert.equal(
    decodeSnapshot(
      minimalSnapshot({ metadata: { cwd: "", home: "", sessionCost: 0, extra: true } }),
    ),
    null,
  );
});

test("snapshot schemas enforce string and nested collection bounds", () => {
  assert.equal(isSnapshot(minimalSnapshot({ leafId: "x".repeat(513) })), false);
  assert.equal(
    isSnapshot(minimalSnapshot({ systemPrompt: "x".repeat(LIMITS.maxSystemPromptChars + 1) })),
    false,
  );
  assert.equal(
    isSnapshot(
      minimalSnapshot({
        pendingInputs: [{ id: "x".repeat(257), content: "x", delivery: "steer" }],
      }),
    ),
    false,
  );
  assert.equal(
    Check(ThemePaletteSchema, { text: "x".repeat(LIMITS.maxThemeValueChars + 1) }),
    false,
  );
  for (const key of ["malformed\nkey", "malformed\u2028key"]) {
    assert.equal(Check(ThemePaletteSchema, { [key]: 42 }), false, `malformed value at ${key}`);
    assert.equal(
      Check(ThemePaletteSchema, { [key]: "x".repeat(LIMITS.maxThemeValueChars + 1) }),
      false,
      `oversized value at ${key}`,
    );
  }
  assert.equal(
    Check(ThemePaletteSchema, { ["k".repeat(LIMITS.maxThemeKeyChars + 1)]: "#fff" }),
    false,
  );
  assert.equal(
    Check(
      ThemePaletteSchema,
      Object.fromEntries(
        Array.from({ length: LIMITS.maxThemeProperties + 1 }, (_, index) => [
          `color-${index}`,
          "#fff",
        ]),
      ),
    ),
    false,
  );
  assert.equal(
    Check(SessionModelSchema, { provider: "x".repeat(129), id: "id", name: "name" }),
    false,
  );
  assert.equal(Check(ContextUsageSchema, { tokens: "1", contextWindow: 1, percent: null }), false);
  assert.equal(
    Check(SessionMetadataSchema, {
      cwd: "x".repeat(LIMITS.maxMetadataStringChars + 1),
      home: "",
      sessionCost: 0,
    }),
    false,
  );
});

test("schemas enforce every current string and collection bound", () => {
  const over = (limit) => "x".repeat(limit + 1);
  assert.equal(
    isSnapshot(minimalSnapshot({ sessionName: over(LIMITS.maxMetadataStringChars) })),
    false,
  );
  assert.equal(isSnapshot(minimalSnapshot({ workingWord: over(512) })), false);
  assert.equal(
    isSnapshot(
      minimalSnapshot({
        pendingInputs: [{ id: "id", content: over(LIMITS.maxInputChars), delivery: "followUp" }],
      }),
    ),
    false,
  );
  assert.equal(
    Check(SessionMetadataSchema, {
      cwd: "",
      home: over(LIMITS.maxMetadataStringChars),
      sessionCost: 0,
    }),
    false,
  );
  assert.equal(
    Check(SessionMetadataSchema, { cwd: "", home: "", sessionCost: 0, thinkingLevel: over(64) }),
    false,
  );
  for (const field of ["id", "name"]) {
    const model = { provider: "provider", id: "id", name: "name", [field]: over(256) };
    assert.equal(Check(SessionModelSchema, model), false, `model ${field}`);
  }
  for (const [field, limit] of [
    ["value", LIMITS.maxCompletionValueChars],
    ["label", LIMITS.maxCompletionLabelChars],
    ["description", LIMITS.maxCompletionDescriptionChars],
  ]) {
    const item = {
      value: "value",
      label: "label",
      description: "description",
      [field]: over(limit),
    };
    assert.equal(Check(CompletionItemSchema, item), false, `completion ${field}`);
  }
  assert.equal(
    Check(CompletionResponseSchema, {
      items: Array.from({ length: LIMITS.maxCompletionItems + 1 }, () => ({
        value: "v",
        label: "l",
      })),
    }),
    false,
  );
  assert.equal(
    Check(SnapshotSchema, minimalSnapshot({ entries: Array(LIMITS.maxEntries + 1).fill(null) })),
    false,
  );
  assert.equal(
    isSnapshot(
      minimalSnapshot({
        pendingInputs: Array.from({ length: LIMITS.maxPendingInputs + 1 }, (_, index) => ({
          id: `pending-${index}`,
          content: "queued",
          delivery: "followUp",
        })),
      }),
    ),
    false,
  );
});

test("decodeSnapshot requires a header object or null without modeling its internals", () => {
  const snapshot = minimalSnapshot({
    header: {
      arbitrary: "unknown header internals remain unknown",
      nested: { values: [undefined, () => {}, Symbol("unmodeled")] },
    },
    entries: ["unknown transcript internals remain unknown", null, { id: "entry" }],
  });
  assert.deepEqual(decodeSnapshot(snapshot), snapshot);
  for (const header of [undefined, () => {}, Symbol("header"), "header", 42, false, []]) {
    assert.equal(decodeSnapshot(minimalSnapshot({ header })), null);
  }
  assert.equal(
    decodeSnapshot(
      minimalSnapshot({ entries: Array(LIMITS.maxEntries + 1).fill({ id: "oversize" }) }),
    ),
    null,
  );
  assert.equal(
    decodeSnapshot(minimalSnapshot({ entries: [{ id: "entry" }], unexpected: true })),
    null,
  );
});

test("request schemas enforce required fields, strict extras, bounds, and delivery union", () => {
  assert.ok(isCompletionRequest({ query: "@src" }));
  assert.equal(isCompletionRequest({}), false);
  assert.equal(isCompletionRequest({ query: "", extra: true }), false);
  assert.equal(
    isCompletionRequest({ query: "x".repeat(LIMITS.maxCompletionQueryChars + 1) }),
    false,
  );
  assert.ok(Check(CompletionRequestSchema, { query: "" }));

  for (const delivery of ["immediate", "steer", "followUp"]) {
    assert.ok(isSubmittedCommand({ content: "hello", delivery }));
  }
  assert.equal(isSubmittedCommand({ content: "hello" }), false);
  assert.equal(isSubmittedCommand({ content: "hello", delivery: "later" }), false);
  assert.equal(isSubmittedCommand({ content: "hello", delivery: "steer", extra: true }), false);
  assert.equal(
    Check(SubmittedCommandSchema, {
      content: "x".repeat(LIMITS.maxInputChars + 1),
      delivery: "steer",
    }),
    false,
  );
});

test("completion schemas are strict while the named decoder filters and truncates items", () => {
  const item = { value: "@a", label: "a", description: "file" };
  assert.ok(Check(CompletionItemSchema, item));
  assert.equal(Check(CompletionItemSchema, { ...item, extra: true }), false);
  assert.equal(Check(CompletionResponseSchema, { items: [item], extra: true }), false);
  assert.equal(decodeCompletionResponse({}), null);
  assert.equal(decodeCompletionResponse({ items: [], extra: true }), null);
  assert.equal(decodeCompletionResponse({ items: "bad" }), null);

  const decoded = decodeCompletionResponse({
    items: [
      item,
      { value: 5, label: "bad" },
      { label: "missing value" },
      { value: "@b", label: "b", extra: "discarded with the item" },
      {
        value: "v".repeat(LIMITS.maxCompletionValueChars + 10),
        label: "l".repeat(LIMITS.maxCompletionLabelChars + 10),
        description: "d".repeat(LIMITS.maxCompletionDescriptionChars + 10),
      },
      ...Array.from({ length: LIMITS.maxCompletionItems + 10 }, (_, index) => ({
        value: `@v${index}`,
        label: `v${index}`,
      })),
    ],
  });
  assert.ok(decoded);
  assert.equal(decoded.items.length, LIMITS.maxCompletionItems);
  assert.deepEqual(decoded.items[0], item);
  assert.equal(
    decoded.items.some((entry) => entry.value === "@b"),
    false,
  );
  assert.equal(decoded.items[1].value.length, LIMITS.maxCompletionValueChars);
  assert.equal(decoded.items[1].label.length, LIMITS.maxCompletionLabelChars);
  assert.equal(decoded.items[1].description.length, LIMITS.maxCompletionDescriptionChars);
});

test("completion decoding bounds candidate scanning even when every candidate is malformed", () => {
  const candidates = Array(LIMITS.maxCompletionCandidates + 1).fill(null);
  candidates[LIMITS.maxCompletionCandidates] = { value: "@too-late", label: "too late" };

  let highestReadIndex = -1;
  const observed = new Proxy(candidates, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        highestReadIndex = Math.max(highestReadIndex, Number(property));
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.deepEqual(decodeCompletionResponse({ items: observed }), { items: [] });
  assert.equal(highestReadIndex, LIMITS.maxCompletionCandidates - 1);
});

test("command acceptance uses one strict schema and decoder", () => {
  for (const value of [{ accepted: true }, { accepted: false, error: "rejected" }]) {
    assert.ok(Check(CommandAcceptanceSchema, value));
    assert.ok(isCommandAcceptance(value));
    assert.deepEqual(decodeCommandAcceptance(value), value);
  }
  for (const value of [
    {},
    { accepted: "yes" },
    { accepted: true, extra: true },
    { accepted: false, error: 5 },
    { accepted: false, error: "x".repeat(513) },
  ]) {
    assert.equal(decodeCommandAcceptance(value), null);
  }
});

test("generateLargeSession is deterministic and schema-valid", () => {
  const first = generateLargeSession(4_000);
  const second = generateLargeSession(4_000);
  assert.equal(first.entries.length, 4_000);
  assert.deepEqual(first, second);
  assert.ok(Check(SnapshotSchema, first));
});
