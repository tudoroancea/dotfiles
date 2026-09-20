import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  decodeEditDiffRendererView,
  EDIT_DIFF_LIMITS,
  EditDiffRendererViewSchema,
  isEditDiffRendererView,
} from "../src/wire/index.ts";

const decode = (diff, result) => decodeEditDiffRendererView({ diff }, result);

test("edit diff classifies unified rows once and excludes headers from stats", () => {
  const view = decode(
    "--- a/file\n+++ b/file\n@@ -1,2 +1,3 @@\n-old\n+new\n same\n\\ No newline at end of file",
  );
  assert.ok(Check(EditDiffRendererViewSchema, view));
  assert.deepEqual(
    view.lines.map((line) => line.kind),
    ["meta", "meta", "hunk", "removed", "added", "context", "meta"],
  );
  assert.deepEqual(view.stats, { additions: 1, removals: 1, partial: false });
});

test("edit diff recognizes only unified header syntax before the first hunk", () => {
  const view = decode(
    "--- a/file\n+++ b/file\n@@ -1,3 +1,3 @@\n---counter\n+++counter\n--- after hunk\n+++ after hunk",
  );
  assert.deepEqual(
    view.lines.map((line) => line.kind),
    ["meta", "meta", "hunk", "removed", "added", "removed", "added"],
  );
  assert.deepEqual(view.stats, { additions: 2, removals: 2, partial: false });
});

test("edit diff enforces exact per-line UTF-8 boundaries without cutting astral pairs", () => {
  const exact = decode("a".repeat(EDIT_DIFF_LIMITS.maxRetainedLineBytes));
  assert.equal(exact.lines[0].text.length, EDIT_DIFF_LIMITS.maxRetainedLineBytes);
  assert.equal(exact.lines[0].truncated, false);

  const astralExact = decode("a".repeat(8_188) + "😀");
  assert.equal(astralExact.retainedBytes, 8_192);
  assert.equal(astralExact.lines[0].text.endsWith("😀"), true);
  assert.equal(astralExact.lines[0].truncated, false);

  const astralCut = decode("a".repeat(8_190) + "😀");
  assert.equal(astralCut.lines[0].text, "a".repeat(8_190));
  assert.equal(astralCut.lines[0].text.includes("\ud83d"), false);
  assert.equal(astralCut.lines[0].omittedBytes, 4);
  assert.equal(astralCut.lines[0].omittedBytesExact, true);
  assert.equal(astralCut.stats.partial, true);

  const rejectedThenAscii = decode("a".repeat(8_190) + "😀z");
  assert.equal(rejectedThenAscii.lines[0].text, "a".repeat(8_190));
  assert.equal(rejectedThenAscii.lines[0].omittedBytes, 5);
});

test("edit diff independently enforces exact retained-total and line-count limits", () => {
  const exactLines = Array.from({ length: 1_024 }, (_, index) =>
    "x".repeat(index === 1_023 ? 128 : 127),
  );
  const exact = decode(exactLines.join("\n"));
  assert.equal(exact.retainedBytes, EDIT_DIFF_LIMITS.maxRetainedBytes);
  assert.equal(exact.lines.length, EDIT_DIFF_LIMITS.maxRetainedLines);
  assert.equal(exact.sourceTruncated, false);

  exactLines[1_023] += "x";
  const overBytes = decode(exactLines.join("\n"));
  assert.equal(overBytes.retainedBytes, EDIT_DIFF_LIMITS.maxRetainedBytes);
  assert.equal(overBytes.lines.at(-1).omittedBytes, 1);
  assert.equal(overBytes.lineTruncated, true);

  const overLines = decode(Array.from({ length: 1_100 }, () => " x").join("\n"));
  assert.equal(overLines.lines.length, EDIT_DIFF_LIMITS.maxRetainedLines);
  assert.equal(overLines.sourceTruncated, true);
  assert.equal(overLines.omittedLines, 1, "only a known lower bound is reported");
  assert.equal(overLines.omittedLinesExact, false);
  assert.equal(overLines.stats.partial, true);
});

test("edit diff normalizes newlines and strips terminal controls while preserving tabs", () => {
  const view = decode("--- a\r\n+++ b\r@@ x @@\n\u001b[31m-red\u001b[0m\n+\tgreen\u0007\u007f");
  assert.deepEqual(
    view.lines.map((line) => line.text),
    ["--- a", "+++ b", "@@ x @@", "-red", "+\tgreen"],
  );
  assert.deepEqual(view.stats, { additions: 1, removals: 1, partial: false });
});

test("unterminated ESC and C1 control strings never consume later rows", () => {
  const introducers = [
    "\u001b[",
    "\u001b]",
    "\u001bP",
    "\u001b^",
    "\u001b_",
    "\u009b",
    "\u009d",
    "\u0090",
    "\u009e",
    "\u009f",
  ];
  const rows = ["@@ -1 +1 @@"];
  for (const [index, introducer] of introducers.entries()) {
    rows.push(
      `-${introducer}${introducer.endsWith("[") || introducer === "\u009b" ? "123;" : "payload"}`,
    );
    rows.push(`+later-${index}`);
  }
  const view = decode(rows.join("\n"));
  assert.equal(view.lines.length, 21);
  assert.equal(view.stats.removals, 10);
  assert.equal(view.stats.additions, 10);
  for (let index = 0; index < introducers.length; index += 1) {
    assert.equal(view.lines[index * 2 + 2].text, `+later-${index}`);
  }
});

test("terminated OSC, DCS, PM, and APC controls strip consistently in ESC and C1 forms", () => {
  const view = decode(
    "@@ x @@\n-\u001b]osc\u0007old\n+\u009dosc\u009cnew\n-\u001bPdcs\u001b\\old\n+\u0090dcs\u009cnew\n-\u001b^pm\u001b\\old\n+\u009epm\u009cnew\n-\u001b_apc\u001b\\old\n+\u009fapc\u009cnew",
  );
  assert.deepEqual(
    view.lines.slice(1).map((line) => line.text),
    ["-old", "+new", "-old", "+new", "-old", "+new", "-old", "+new"],
  );
});

test("empty, control-only, and no-op normalized diffs use bounded result fallback", () => {
  const result = { content: [{ type: "text", text: "No changes applied" }] };
  for (const diff of ["", "\u001b[31m\u001b[0m", "--- a/file\n+++ b/file"]) {
    const view = decode(diff, result);
    assert.equal(view.mode, "fallback");
    assert.equal(view.lines[0].text, "No changes applied");
    assert.equal(view.reason, "empty normalized details");
  }
  const blankResult = decode("", { content: [{ type: "text", text: "\u001b]empty\u0007" }] });
  assert.equal(blankResult.mode, "fallback");
  assert.match(blankResult.lines[0].text, /Edit diff unavailable/);
});

test("16 MiB single-line input has bounded retained allocation and exact line omission", () => {
  const source = `+${"x".repeat(16 * 1_024 * 1_024 - 1)}`;
  const view = decode(source);
  assert.equal(view.lines.length, 1);
  assert.equal(view.lines[0].text.length, EDIT_DIFF_LIMITS.maxRetainedLineBytes);
  assert.equal(view.lines[0].omittedBytes, source.length - EDIT_DIFF_LIMITS.maxRetainedLineBytes);
  assert.equal(view.lines[0].omittedBytesExact, true);
  assert.equal(view.retainedBytes, EDIT_DIFF_LIMITS.maxRetainedLineBytes);
});

test("malformed, non-string, missing, and unsafe details retain bounded result fallback", () => {
  const result = { content: [{ type: "text", text: "Applied safely\nsecond line" }] };
  for (const details of [null, {}, { diff: 42 }, { diff: "+ok\0bad" }]) {
    const view = decodeEditDiffRendererView(details, result);
    assert.equal(view.mode, "fallback");
    assert.equal(view.lines[0].text, "Applied safely");
    assert.equal(view.stats.partial, true);
    assert.ok(Check(EditDiffRendererViewSchema, view));
  }
  const hostileFallback = decodeEditDiffRendererView(
    {},
    {
      content: [{ type: "text", text: "z".repeat(16 * 1_024 * 1_024) }],
    },
  );
  assert.ok(hostileFallback.retainedBytes <= EDIT_DIFF_LIMITS.maxRetainedBytes);
  assert.ok(hostileFallback.lines.length <= EDIT_DIFF_LIMITS.maxRetainedLines);
  assert.equal(hostileFallback.lineTruncated, true);
});

test("edit diff schema and semantic validator reject inconsistent or oversized views", () => {
  const valid = decode("@@ x @@\n-old\n+new");
  assert.equal(isEditDiffRendererView(valid), true);

  const retainedTooLarge = { ...valid, retainedBytes: EDIT_DIFF_LIMITS.maxRetainedBytes + 1 };
  assert.equal(Check(EditDiffRendererViewSchema, retainedTooLarge), false);
  assert.equal(isEditDiffRendererView(retainedTooLarge), false);

  const oversizedUtf8 = structuredClone(valid);
  oversizedUtf8.lines[1].text = "😀".repeat(3_000);
  oversizedUtf8.retainedBytes = 12_014;
  assert.equal(
    Check(EditDiffRendererViewSchema, oversizedUtf8),
    true,
    "UTF-16 schema alone permits it",
  );
  assert.equal(isEditDiffRendererView(oversizedUtf8), false);

  for (const mutate of [
    (view) => (view.retainedBytes += 1),
    (view) => (view.lines[1].sourceLine = 99),
    (view) => (view.lines[1].truncated = true),
    (view) => (view.lineTruncated = true),
    (view) => (view.stats.additions = 99),
    (view) => (view.stats.partial = true),
    (view) => (view.lines[1].kind = "fallback"),
    (view) => (view.omittedLines = 1),
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.equal(Check(EditDiffRendererViewSchema, invalid), true);
    assert.equal(isEditDiffRendererView(invalid), false);
  }
});
