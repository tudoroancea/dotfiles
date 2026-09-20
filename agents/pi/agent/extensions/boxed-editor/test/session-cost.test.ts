import { describe, expect, it } from "vitest";
import { getSessionCost } from "../session-cost.ts";

const message = (value: unknown) => ({ type: "message", message: value });

describe("getSessionCost", () => {
  it("uses canonical usage and Agentflow accounting", () => {
    expect(
      getSessionCost([
        message({ role: "assistant", usage: { cost: { total: 1.25 } } }),
        message({
          role: "toolResult",
          toolName: "agentflow_delegate",
          usage: { cost: { total: 0.25 } },
          details: { costId: "agentflow:run_1", cost: 0.4 },
        }),
        { type: "branch_summary", usage: { cost: { total: 0.5 } } },
        {
          type: "custom_message",
          customType: "agentflow-result",
          details: { costId: "agentflow:run_1", cost: 0.7 },
        },
      ]),
    ).toBe(2.7);
  });

  it("does not count arbitrary unkeyed tool detail costs", () => {
    expect(
      getSessionCost([
        message({ role: "toolResult", details: { cost: 10 } }),
        message({ role: "custom", details: { costId: "agentflow:run_1", cost: 10 } }),
      ]),
    ).toBe(0);
  });
});
