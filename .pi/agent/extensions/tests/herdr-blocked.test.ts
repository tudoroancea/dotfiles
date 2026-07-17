import { describe, expect, it, vi } from "vitest";
import { withHerdrBlocked } from "../lib/herdr-blocked.ts";

describe("withHerdrBlocked", () => {
  it("balances events around a successful operation", async () => {
    const calls: string[] = [];
    const events = {
      emit: vi.fn((_event: string, payload: { active: boolean }) =>
        calls.push(payload.active ? "active" : "inactive"),
      ),
    };

    const result = await withHerdrBlocked(events, "Waiting", async () => {
      calls.push("operation");
      return 42;
    });

    expect(result).toBe(42);
    expect(calls).toEqual(["active", "operation", "inactive"]);
    expect(events.emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: "Waiting" }],
      ["herdr:blocked", { active: false }],
    ]);
  });

  it("balances events when the operation rejects", async () => {
    const events = { emit: vi.fn() };
    await expect(
      withHerdrBlocked(events, "Waiting", async () => {
        throw new Error("UI failed");
      }),
    ).rejects.toThrow("UI failed");
    expect(events.emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: "Waiting" }],
      ["herdr:blocked", { active: false }],
    ]);
  });
});
