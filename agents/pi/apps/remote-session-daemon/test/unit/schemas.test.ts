import { describe, expect, it } from "vitest";
import { parseControlCommand } from "../../src/api/schemas.ts";

const base = {
  version: 1 as const,
  commandId: "control-1",
  generation: "generation-1",
  commandEpoch: "epoch-1",
};

describe("control command parser", () => {
  it("maps strict shared model controls to typed host commands", () => {
    expect(
      parseControlCommand({
        ...base,
        type: "set-model",
        provider: "provider",
        modelId: "model",
      }),
    ).toEqual({
      generation: "generation-1",
      commandEpoch: "epoch-1",
      command: {
        type: "set_model",
        commandId: "control-1",
        provider: "provider",
        model: "model",
      },
    });
    expect(parseControlCommand({ ...base, type: "set-thinking", thinkingLevel: "max" })).toEqual({
      generation: "generation-1",
      commandEpoch: "epoch-1",
      command: { type: "set_thinking", commandId: "control-1", level: "max" },
    });
  });

  it("rejects widened shared controls while retaining legacy abort and compact", () => {
    expect(() =>
      parseControlCommand({
        ...base,
        type: "set-thinking",
        thinkingLevel: "max",
        unexpected: true,
      }),
    ).toThrow(/Control envelope/);
    expect(parseControlCommand({ ...base, type: "control", control: "abort" }).command).toEqual({
      type: "abort",
      commandId: "control-1",
    });
    expect(parseControlCommand({ ...base, type: "control", control: "compact" }).command).toEqual({
      type: "compact",
      commandId: "control-1",
    });
  });
});
