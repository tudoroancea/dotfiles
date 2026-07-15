import { describe, expect, it } from "vitest";
import { isDeniedChildTool } from "../src/runtime/subagent-runner.ts";
import { assertNoTrustedPolicySelection } from "../src/runtime/workflow-runtime.ts";
import { ownershipOverlaps } from "../src/semantic/ownership.ts";
import { semanticProfiles } from "../src/semantic/profiles.ts";

describe("semantic capability policy", () => {
  it.each(["finder", "oracle", "librarian", "review"] as const)(
    "keeps %s mechanically read-only",
    (role) => {
      const profile = semanticProfiles[role];
      expect(profile.mutates).toBe(false);
      expect(profile.tools).not.toContain("bash");
      expect(profile.tools).not.toContain("edit");
      expect(profile.tools).not.toContain("write");
    },
  );

  it("rejects workflow attempts to select trusted policy", () => {
    expect(() => assertNoTrustedPolicySelection({ semanticRole: "delegate" })).toThrow(
      "cannot select trusted semantic policy",
    );
    expect(() => assertNoTrustedPolicySelection({ model: "custom" })).not.toThrow();
  });

  it("detects overlapping delegate ownership boundaries", () => {
    expect(ownershipOverlaps(["src/auth"], ["src/auth/session.ts"])).toBe(true);
    expect(ownershipOverlaps(["src/auth"], ["src/billing"])).toBe(false);
  });

  it("denies current and future orchestration tools in children", () => {
    expect(isDeniedChildTool("agentflow_agent")).toBe(true);
    expect(isDeniedChildTool("agentflow_future_privileged_tool")).toBe(true);
    expect(isDeniedChildTool("questionnaire")).toBe(true);
    expect(isDeniedChildTool("read")).toBe(false);
  });
});
