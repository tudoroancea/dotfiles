import { describe, expect, it } from "vitest";
import { FakeSessionHost } from "../fixtures/fake-session-host.ts";

describe("FakeSessionHost", () => {
  it("separates delayed admission, streaming, and completion", async () => {
    const host = new FakeSessionHost({ delayedAdmission: true });
    host.load();
    const admission = host.command({ type: "prompt", commandId: "p1", text: "hello" });
    expect(host.pendingAdmissions).toEqual(["p1"]);
    expect(host.state.running).toBe(false);
    host.resolveAdmission("p1");
    await expect(admission).resolves.toEqual({ status: "accepted", commandId: "p1" });
    expect(host.state.running).toBe(true);
    host.streamMessage("p1", ["a", "b"], { id: "t1", name: "read" });
    expect(host.events.map((event) => event.type)).toContain("tool_end");
    expect(host.state.settled).toBe(false);
    host.settle("p1");
    expect(host.state.settled).toBe(true);
  });
  it("distinguishes rejection and ambiguous loss", async () => {
    const rejected = new FakeSessionHost({ delayedAdmission: true });
    rejected.load();
    const first = rejected.command({ type: "prompt", commandId: "one", text: "x" });
    rejected.resolveAdmission("one", "rejected");
    await expect(first).resolves.toMatchObject({ status: "rejected" });
    const lost = lostCommand();
    await expect(lost.result).resolves.toEqual({
      status: "ambiguous",
      commandId: "two",
      message: "Admission outcome is unknown",
    });
    expect(lost.host.state.failure?.ambiguous).toBe(true);
  });
  it("supports queues, abort, dialogs, model, thinking, and compaction", async () => {
    const host = new FakeSessionHost();
    host.load();
    await expect(
      host.command({ type: "follow_up", commandId: "q", text: "later" }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(host.state.queueCount).toBe(1);
    host.openDialog();
    await host.command({ type: "dialog_cancel", commandId: "d", dialogId: "dialog-1" });
    await host.command({ type: "set_model", commandId: "m", provider: "fixture", model: "m" });
    await host.command({ type: "set_thinking", commandId: "t", level: "high" });
    host.compact("started");
    host.compact("completed");
    await host.command({ type: "abort", commandId: "a" });
    expect(host.state).toMatchObject({
      dialog: null,
      model: { provider: "fixture", id: "m" },
      thinkingLevel: "high",
      settled: true,
    });
  });
  it("supports every replacement, unload, and restart scenario", async () => {
    const host = new FakeSessionHost();
    host.load();
    for (const transition of [
      { type: "new" },
      { type: "switch", sessionFile: "/s/a.jsonl" },
      { type: "fork", entryId: "e" },
      { type: "clone", entryId: "e" },
      { type: "import", sessionFile: "/s/i.jsonl" },
      { type: "replace" },
      { type: "restart" },
    ] as const)
      await expect(host.transition(transition)).resolves.toMatchObject({ status: "completed" });
    await host.transition({ type: "unload" });
    expect(host.state.lifecycle).toBe("unloaded");
  });
  it("pages bounded history and makes success/failure disposal idempotent", async () => {
    const history = Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      parentId: null,
      type: "custom",
      timestamp: index,
      data: { index },
    }));
    const host = new FakeSessionHost({ history });
    host.load();
    const page = await host.history({ limit: 2, byteLimit: 1000 });
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toBe("2");
    expect(host.dispose()).toBe(host.dispose());
    await host.dispose();
    expect(host.state.lifecycle).toBe("stopped");
    const failing = new FakeSessionHost({ failDisposal: true });
    failing.load();
    const disposal = failing.dispose();
    expect(disposal).toBe(failing.dispose());
    await expect(disposal).rejects.toThrow(/disposal failed/i);
    expect(failing.state.lifecycle).toBe("failed");
  });
});
function lostCommand() {
  const host = new FakeSessionHost({ delayedAdmission: true });
  host.load();
  const result = host.command({ type: "prompt", commandId: "two", text: "x" });
  host.loseHost(true);
  return { host, result };
}
