import { describe, expect, it } from "vitest";
import { SessionCostAccumulator, summarizeSessionCost } from "../session-cost.ts";
import {
  canonicalSessionCostEntries,
  canonicalSessionCostExpected,
} from "./fixtures/session-cost.ts";

describe("canonical session cost", () => {
  it("counts only authoritative top-level representations", () => {
    expect(summarizeSessionCost(canonicalSessionCostEntries)).toEqual(canonicalSessionCostExpected);
  });

  it("provides equivalent streaming accounting with max-cost deltas", () => {
    const accumulator = new SessionCostAccumulator();
    const deltas = canonicalSessionCostEntries.map((entry) => accumulator.addEntry(entry));
    expect(accumulator.summary()).toEqual(canonicalSessionCostExpected);
    expect(deltas.reduce((total, delta) => total + delta.total, 0)).toBeCloseTo(3.6);
  });
});
