import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatElapsed,
  formatPrompt,
  formatStatus,
  formatTokens,
  formatUsage,
} from "../src/ui/formatters.ts";
import { MAX_SNAPSHOT_PROMPT_CHARS } from "../src/runtime/snapshot-fields.ts";

describe("agent information formatters", () => {
  it("formats status, elapsed time, tokens, and cost consistently", () => {
    expect(formatStatus("running")).toBe("◆ running");
    expect(formatStatus("aborted")).toBe("◇ aborted");
    expect(formatElapsed(new Date(0).toISOString(), new Date(3_665_000).toISOString())).toBe(
      "1h 1m",
    );
    expect(formatElapsed(undefined)).toBe("0ms");
    expect(formatTokens(18_400)).toBe("18.4k");
    expect(formatCost(0.21)).toBe("$0.210");
    expect(
      formatUsage({
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
        cost: 0,
        costKnown: false,
      }),
    ).toBe("15 tokens · cost unavailable");
  });

  it("bounds and sanitizes prompts", () => {
    expect(formatPrompt("x".repeat(MAX_SNAPSHOT_PROMPT_CHARS + 100))).toHaveLength(
      MAX_SNAPSHOT_PROMPT_CHARS,
    );
    expect(
      formatPrompt("safe\u001b[31m red\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"),
    ).toBe("safe redlink");
  });
});
