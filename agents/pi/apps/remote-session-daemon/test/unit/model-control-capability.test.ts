import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { LIMITS, ModelControlCapabilitySchema } from "@dotfiles/pi-web-ui-client/wire";
import { modelControlCapability, supportedThinkingLevels } from "../../src/host/sdk-bundle.ts";

describe("SDK model control capability", () => {
  it("bounds models, omits overlong identities, and keeps identities unique", () => {
    const capability = modelControlCapability(
      [
        { provider: "provider", id: "one", name: "n".repeat(1000) },
        { provider: "provider", id: "one", name: "duplicate" },
        { provider: "provider", id: "x".repeat(LIMITS.maxModelIdChars + 1), name: "too long" },
        { provider: "provider", id: "two", name: "Two" },
      ],
      { reasoning: true, thinkingLevelMap: { xhigh: "high", max: "max" } },
    );
    expect(capability?.models).toEqual([
      {
        provider: "provider",
        id: "one",
        name: "n".repeat(LIMITS.maxModelNameChars),
      },
      { provider: "provider", id: "two", name: "Two" },
    ]);
    expect(capability?.thinkingLevels).toContain("max");
    expect(Check(ModelControlCapabilitySchema, capability)).toBe(true);
  });

  it("uses canonical thinking support for the current model", () => {
    expect(supportedThinkingLevels({ reasoning: false })).toEqual(["off"]);
    expect(
      supportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { low: null, xhigh: undefined, max: "max" },
      }),
    ).toEqual(["off", "minimal", "medium", "high", "max"]);
  });
});
