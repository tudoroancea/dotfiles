import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../src/server/providers.js";
import { PROTOCOL_VERSION, type ProviderMessage } from "../src/shared/wire.js";
import { BrowserProviderStore } from "../src/web/provider-store.js";

describe("ProviderRegistry", () => {
  it("bounds snapshots, coalesces revisions, and cleans subscriptions", async () => {
    vi.useFakeTimers();
    let notify = () => {};
    const unsubscribe = vi.fn();
    const action = vi.fn(async (_action: string, payload: unknown) => ({ ok: true, payload }));
    const registry = new ProviderRegistry();
    registry.register({
      id: "agentflow",
      getSnapshot: () => ({ runs: [{ output: "x".repeat(2_000_000), token: "secret" }] }),
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
      action,
    });
    const initial = registry.snapshot("agentflow")!;
    expect(JSON.stringify(initial).length).toBeLessThan(1_100_000);
    expect(JSON.stringify(initial)).not.toContain("secret");
    const listener = vi.fn();
    registry.subscribe(listener);
    notify();
    notify();
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "agentflow", revision: 2 }),
    );
    const result = await registry.action("agentflow", "cancel", { runId: "run", password: "no" });
    expect(result).toMatchObject({ ok: true });
    expect(action).toHaveBeenCalledWith("cancel", { runId: "run", password: "[redacted]" });
    registry.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("publishes late registration and preserves monotonic replacement revisions", () => {
    const registry = new ProviderRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const provider = (value: number) => ({
      id: "background" as const,
      getSnapshot: () => ({ jobs: [{ value }] }),
      subscribe: () => () => {},
      action: async () => ({ jobs: [] }),
    });
    registry.register(provider(1));
    registry.register(provider(2));
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "background", revision: 0 }),
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "background", revision: 1 }),
    );
  });

  it("preserves an explicit background tail across ordinary updates", () => {
    const store = new BrowserProviderStore();
    const message = (revision: number, data: unknown): ProviderMessage => ({
      type: revision === 1 ? "provider_action_result" : "provider_update",
      protocolVersion: PROTOCOL_VERSION,
      generation: "generation",
      provider: "background",
      revision,
      data,
    });
    store.apply(message(1, { jobs: [{ jobId: "job", status: "running", tail: "visible" }] }));
    store.apply(message(2, { jobs: [{ jobId: "job", status: "running", outputBytes: 10 }] }));
    expect(store.getSnapshot().background?.data).toMatchObject({
      jobs: [{ jobId: "job", tail: "visible", outputBytes: 10 }],
    });
  });

  it("rejects unknown providers", async () => {
    const registry = new ProviderRegistry();
    await expect(registry.action("missing", "stop", {})).rejects.toThrow("unavailable");
  });
});
