import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/shared/limits.js";
import { parseClientCommand } from "../src/server/protocol.js";

describe("client command validation", () => {
  it("accepts explicit prompt delivery modes and controls", () => {
    for (const type of ["prompt", "steer", "follow_up"] as const) {
      expect(
        parseClientCommand(
          JSON.stringify({
            type,
            commandId: `${type}-1`,
            generation: "generation-1",
            content: "hello",
          }),
        ),
      ).toMatchObject({ type, content: "hello" });
    }
    expect(
      parseClientCommand(
        JSON.stringify({ type: "abort", commandId: "abort-1", generation: "generation-1" }),
      ),
    ).toMatchObject({ type: "abort" });
    for (const type of ["snapshot", "ping"] as const) {
      expect(parseClientCommand(JSON.stringify({ type, commandId: `${type}-1` }))).toMatchObject({
        type,
      });
    }
    expect(
      parseClientCommand(
        JSON.stringify({
          type: "history_page",
          commandId: "history-1",
          generation: "generation-1",
          historyGeneration: "history-generation-1",
          cursor: "opaque-cursor",
        }),
      ),
    ).toMatchObject({ type: "history_page", cursor: "opaque-cursor" });
    expect(() =>
      parseClientCommand(
        JSON.stringify({
          type: "history_page",
          commandId: "history-2",
          historyGeneration: "history-generation-1",
          cursor: "opaque-cursor",
        }),
      ),
    ).toThrow("Invalid command payload");
  });

  it("rejects unknown fields, invalid JSON, and UTF-8 byte overflow", () => {
    expect(() => parseClientCommand("not json")).toThrow("Invalid JSON command");
    expect(() =>
      parseClientCommand(JSON.stringify({ type: "ping", commandId: "1", secret: true })),
    ).toThrow("Invalid command payload");
    expect(() =>
      parseClientCommand(
        JSON.stringify({
          type: "prompt",
          commandId: "1",
          generation: "generation-1",
          content: "é".repeat(LIMITS.promptUtf8Bytes),
        }),
      ),
    ).toThrow("UTF-8 byte limit");
    expect(() =>
      parseClientCommand(
        JSON.stringify({
          type: "abort",
          commandId: "é".repeat(LIMITS.commandIdUtf8Bytes),
          generation: "generation-1",
        }),
      ),
    ).toThrow("Command ID exceeds the UTF-8 byte limit");
    expect(
      parseClientCommand(
        JSON.stringify({
          type: "prompt",
          commandId: "é".repeat(LIMITS.commandIdUtf8Bytes / 2),
          generation: "generation-1",
          content: "é".repeat(LIMITS.promptUtf8Bytes / 2),
        }),
      ),
    ).toMatchObject({ type: "prompt" });
  });
});
