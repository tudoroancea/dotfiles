import { describe, expect, it } from "vitest";
import { getSessionCost } from "../../session-cost.ts";

const message = (value: unknown) => ({ type: "message", message: value });

describe("getSessionCost", () => {
  it("adds assistant and unkeyed tool costs", () => {
    expect(
      getSessionCost([
        message({ role: "assistant", usage: { cost: { total: 1.25 } } }),
        message({ role: "toolResult", details: { cost: 0.5 } }),
      ]),
    ).toBe(1.75);
  });

  it("deduplicates propagated costs by id across tool and custom results", () => {
    expect(
      getSessionCost([
        message({
          role: "toolResult",
          details: { costId: "agentflow:run_1", cost: 0.4 },
        }),
        message({
          role: "toolResult",
          details: {
            costs: [
              { costId: "agentflow:run_1", cost: 0.4 },
              { costId: "agentflow:run_2", cost: 0.6 },
            ],
          },
        }),
        {
          type: "custom_message",
          customType: "agentflow-result",
          details: { costId: "agentflow:run_2", cost: 0.6 },
        },
      ]),
    ).toBe(1);
  });

  it("keeps the latest highest cost for a run and counts failed-run entries", () => {
    expect(
      getSessionCost([
        message({
          role: "toolResult",
          details: { costId: "agentflow:run_1", cost: 0.2 },
        }),
        message({
          role: "toolResult",
          details: { costId: "agentflow:run_1", cost: 0.7 },
        }),
        {
          type: "custom",
          customType: "agentflow-cost",
          data: { costId: "agentflow:run_2", cost: 0.3 },
        },
      ]),
    ).toBe(1);
  });
});
