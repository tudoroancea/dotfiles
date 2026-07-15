import { describe, expect, it } from "vitest";
import { isDeniedChildTool, resolveRequestedModel } from "../src/runtime/subagent-runner.ts";
import { assertNoTrustedPolicySelection } from "../src/runtime/workflow-runtime.ts";
import { ownershipOverlaps } from "../src/semantic/ownership.ts";
import { semanticProfiles } from "../src/semantic/profiles.ts";

describe("semantic capability policy", () => {
  it.each(["finder", "oracle", "librarian", "look_at", "review"] as const)(
    "keeps %s mechanically read-only",
    (role) => {
      const profile = semanticProfiles[role];
      expect(profile.mutates).toBe(false);
      expect(profile.tools).not.toContain("bash");
      expect(profile.tools).not.toContain("edit");
      expect(profile.tools).not.toContain("write");
    },
  );

  it("limits look_at to the read capability", () => {
    expect(semanticProfiles.look_at.tools).toEqual(["read"]);
    expect(semanticProfiles.look_at.mutates).toBe(false);
  });

  it("rejects workflow attempts to select trusted policy", () => {
    expect(() => assertNoTrustedPolicySelection({ semanticRole: "delegate" })).toThrow(
      "cannot select trusted semantic policy",
    );
    expect(() => assertNoTrustedPolicySelection({ model: "custom" })).not.toThrow();
  });

  it("inherits the parent provider for fixed semantic model IDs", () => {
    expect(resolveRequestedModel("gpt-5.6-luna", true, "pave")).toBe("pave/gpt-5.6-luna");
    expect(resolveRequestedModel("gpt-5.6-sol", true, "openai-codex")).toBe(
      "openai-codex/gpt-5.6-sol",
    );
    expect(resolveRequestedModel("anthropic/claude-opus", false, "pave")).toBe(
      "anthropic/claude-opus",
    );
    expect(() => resolveRequestedModel("gpt-5.6-sol", true, undefined)).toThrow(
      "without a parent model",
    );
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
