import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerAgentflowWebProvider } from "../src/web-provider.ts";
import type { RunEngine } from "../src/runtime/run-engine.ts";

describe("Agentflow web provider", () => {
  it("registers snapshots/subscriptions and bounded control actions", async () => {
    const handlers = new Map<string, () => void>();
    let provider: any;
    const pi = { events: { on: (name: string, handler: () => void) => handlers.set(name, handler), emit: (name: string, value: unknown) => { if (name === "web-ui:provider-register") provider = value; } } } as unknown as ExtensionAPI;
    const engine = {
      getSnapshot: vi.fn((runId?: string) =>
        runId
          ? { runId, status: "running", nodes: [] }
          : [{ runId: "run-1", status: "running", nodes: [] }],
      ),
      subscribe: vi.fn(() => vi.fn()),
      getSteerableNodeIds: vi.fn(() => []),
      cancel: vi.fn(async () => [{ runId: "run-1", status: "aborted" }]),
      steer: vi.fn(async () => ({ runId: "run-1", nodeId: "node" })),
    } as unknown as RunEngine;
    registerAgentflowWebProvider(pi, engine);
    handlers.get("web-ui:provider-discover")?.();
    expect(provider.id).toBe("agentflow");
    expect(provider.getSnapshot()).toEqual([{ runId: "run-1", status: "running", nodes: [] }]);
    await provider.action("cancel", { runId: "run-1" });
    expect(engine.cancel).toHaveBeenCalledWith(["run-1"]);
    await provider.action("steer", { runId: "run-1", nodeId: "node", message: "focus" });
    expect(engine.steer).toHaveBeenCalledWith("run-1", "node", "focus");

    (engine.getSnapshot as ReturnType<typeof vi.fn>).mockImplementation((runId?: string) =>
      runId
        ? { runId, status: "completed", nodes: [] }
        : [{ runId: "run-1", status: "completed", nodes: [] }],
    );
    await expect(provider.action("cancel", { runId: "run-1" })).rejects.toThrow(
      "not cancellable",
    );
    expect(engine.cancel).toHaveBeenCalledTimes(1);
  });
});
