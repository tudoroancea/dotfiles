import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/shared/limits.js";
import { parseClientCommand } from "../src/server/protocol.js";

describe("client command validation", () => {
  it("accepts explicit prompt delivery modes and controls", () => {
    for (const type of ["prompt", "steer", "follow_up"] as const) {
      expect(
        parseClientCommand(JSON.stringify({ type, commandId: `${type}-1`, content: "hello" })),
      ).toMatchObject({ type, content: "hello" });
    }
    for (const type of ["abort", "snapshot", "ping"] as const) {
      expect(parseClientCommand(JSON.stringify({ type, commandId: `${type}-1` }))).toMatchObject({
        type,
      });
    }
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
          content: "é".repeat(LIMITS.promptUtf8Bytes),
        }),
      ),
    ).toThrow("UTF-8 byte limit");
  });
});
