import assert from "node:assert/strict";
import { test } from "node:test";

import {
  indexBoundedTranscript,
  PersistedTranscriptIndex,
} from "../src/client/transcript-index.ts";

function user(id) {
  return {
    id,
    payload: {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: id }] },
    },
  };
}

function result(id, toolCallId, text) {
  return {
    id,
    payload: {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        content: [{ type: "text", text }],
      },
    },
  };
}

function modelChange(id) {
  return { id, payload: { type: "model_change", provider: "test", modelId: id } };
}

function largeFixture(size = 5000) {
  return Array.from({ length: size }, (_, index) => user(`entry-${index}`));
}

test("strict append and history prepend inspect only delta entries", () => {
  let inspections = 0;
  const index = new PersistedTranscriptIndex({ inspect: () => inspections++ });
  const retained = largeFixture();

  const initial = index.update(retained, false);
  assert.equal(initial.stats.kind, "initial");
  assert.equal(initial.stats.inspectedEntries, 5000);
  assert.equal(inspections, 5000);

  inspections = 0;
  const appendedEntries = [...retained, user("entry-5000")];
  const appended = index.update(appendedEntries, false);
  assert.deepEqual(appended.stats, { kind: "append", inspectedEntries: 1 });
  assert.equal(inspections, 1);
  assert.equal(appended.rows.length, 5001);
  assert.equal(appended.rows.at(-1).key, "p:entry-5000");

  inspections = 0;
  const page = Array.from({ length: 128 }, (_, offset) => user(`older-${offset}`));
  const prepended = index.update([...page, ...appendedEntries], false);
  assert.deepEqual(prepended.stats, { kind: "prepend", inspectedEntries: 128 });
  assert.equal(inspections, 128);
  assert.equal(prepended.rows.length, 5129);
  assert.equal(prepended.rows[0].key, "p:older-0");
  assert.equal(prepended.rows[128].key, "p:entry-0");
});

test("incremental tool-result lookup preserves chronological attachment semantics", () => {
  const callId = "call-1";
  const retained = [user("assistant-placeholder"), result("newer-result", callId, "newer")];
  const index = new PersistedTranscriptIndex();
  let snapshot = index.update(retained, false);
  assert.equal(snapshot.toolResults.get(callId)?.content[0].text, "newer");

  const appendedResult = result("appended-result", "call-2", "appended");
  const appendedEntries = [...retained, appendedResult];
  snapshot = index.update(appendedEntries, false);
  assert.equal(snapshot.toolResults.get("call-2")?.content[0].text, "appended");

  snapshot = index.update([result("older-result", callId, "older"), ...appendedEntries], false);
  assert.equal(snapshot.stats.kind, "prepend");
  assert.equal(snapshot.toolResults.get(callId)?.content[0].text, "newer");
});

test("switch preference changes and explicit resets rebuild the persisted index", () => {
  let inspections = 0;
  const index = new PersistedTranscriptIndex({ inspect: () => inspections++ });
  const entries = [...largeFixture(3000), modelChange("switch-1")];
  let snapshot = index.update(entries, false);
  assert.equal(snapshot.rows.length, 3000);

  inspections = 0;
  snapshot = index.update(entries, true);
  assert.deepEqual(snapshot.stats, { kind: "rebuild", inspectedEntries: 3001 });
  assert.equal(inspections, 3001);
  assert.equal(snapshot.rows.at(-1).key, "p:switch-1");

  inspections = 0;
  const resetEntries = [...entries, user("reset-tail")];
  snapshot = index.update(resetEntries, true, { reset: true });
  assert.deepEqual(snapshot.stats, { kind: "rebuild", inspectedEntries: 3002 });
  assert.equal(inspections, 3002);
  assert.equal(snapshot.rows.at(-1).key, "p:reset-tail");
});

test("non-prefix replacement rebuilds and liveTail remains fully bounded-indexed", () => {
  const retained = largeFixture(2500);
  const index = new PersistedTranscriptIndex();
  index.update(retained, false);

  const replacement = retained.slice();
  replacement[1250] = user("replacement");
  const rebuilt = index.update(replacement, false);
  assert.deepEqual(rebuilt.stats, { kind: "rebuild", inspectedEntries: 2500 });
  assert.equal(rebuilt.rows[1250].key, "p:replacement");

  let liveInspections = 0;
  const live = [user("live-user"), result("live-result", "live-call", "live output")];
  const liveIndex = indexBoundedTranscript(live, "l", false, {
    inspect: () => liveInspections++,
  });
  assert.equal(liveInspections, live.length);
  assert.deepEqual(
    liveIndex.rows.map((row) => row.key),
    ["l:live-user"],
  );
  assert.equal(liveIndex.toolResults.get("live-call")?.content[0].text, "live output");
});
