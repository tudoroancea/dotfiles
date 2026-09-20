import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../src/client/format.ts";

test("duration formatting uses the shared elapsed-time policy", () => {
  const cases = [
    [-1, "0ms"],
    [999.5, "1.0s"],
    [1_250, "1.3s"],
    [59_950, "1m 0s"],
    [65_000, "1m 5s"],
    [3_662_000, "1h 1m"],
    [90_000_000, "1d 1h"],
  ];

  for (const [milliseconds, expected] of cases) {
    assert.equal(formatDuration(milliseconds), expected);
  }
  assert.equal(formatDuration(Number.NaN), "");
});
