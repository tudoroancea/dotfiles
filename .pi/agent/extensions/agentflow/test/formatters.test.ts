import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatElapsed,
  formatPrompt,
  formatStatus,
  formatTokens,
  formatToolCall,
} from "../src/ui/formatters.ts";
import { MAX_SNAPSHOT_PROMPT_CHARS } from "../src/runtime/snapshot-fields.ts";

describe("agent information formatters", () => {
  it("formats status, elapsed time, tokens, and cost consistently", () => {
    expect(formatStatus("running")).toBe("◆ running");
    expect(formatStatus("aborted")).toBe("◇ aborted");
    expect(formatElapsed(new Date(0).toISOString(), new Date(3_665_000).toISOString())).toBe(
      "1h01m",
    );
    expect(formatTokens(18_400)).toBe("18.4k");
    expect(formatCost(0.21)).toBe("$0.210");
  });

  it("bounds and sanitizes prompts and expanded tool-call details", () => {
    expect(formatPrompt("x".repeat(MAX_SNAPSHOT_PROMPT_CHARS + 100))).toHaveLength(
      MAX_SNAPSHOT_PROMPT_CHARS,
    );
    expect(
      formatPrompt("safe\u001b[31m red\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"),
    ).toBe("safe redlink");
    expect(
      formatToolCall(
        {
          id: "call",
          name: "read",
          status: "completed",
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(1).toISOString(),
          argumentSummary: "src/auth.ts:1-20",
          argumentsPreview: '{"path":"src/auth.ts"}',
          resultPreview: "file contents",
        },
        true,
      ),
    ).toEqual([
      "✓ completed read  src/auth.ts:1-20",
      'args: {"path":"src/auth.ts"}',
      "result: file contents",
    ]);
  });
});
