import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRuntime } from "../src/runtime/process-runtime.ts";
import { registerBackgroundWebProvider } from "../src/web-provider.ts";

describe("background web provider", () => {
  it("views without consuming delivery and supports tail/stop", async () => {
    const handlers = new Map<string, () => void>();
    let provider: any;
    const pi = { events: { on: (name: string, handler: () => void) => handlers.set(name, handler), emit: (name: string, value: unknown) => { if (name === "web-ui:provider-register") provider = value; } } } as unknown as ExtensionAPI;
    const job = { id: "job-1", generation: 1, kind: "background_run", command: "cmd", cwd: "/repo", createdAt: new Date().toISOString(), status: "running", outputBytes: 0, deliveryState: "pending", verification: { processSettled: false, outputLogClosed: false, terminalMetadataPersisted: false } };
    const runtime = {
      list: vi.fn(() => [job]),
      subscribe: vi.fn(() => vi.fn()),
      resolve: vi.fn(() => [job]),
      tail: vi.fn(() => ({ content: "ready", bytes: 5, lines: 1, truncated: false })),
      stopMany: vi.fn(async () => [job]),
      stopManyResult: vi.fn(async () => ({ jobs: [], text: "stopped", truncated: false, omittedCount: 0 })),
      waitResult: vi.fn(),
    } as unknown as ProcessRuntime;
    const announce = registerBackgroundWebProvider(pi, () => runtime);
    handlers.get("web-ui:provider-discover")?.();
    expect(provider.getSnapshot().jobs[0].jobId).toBe("job-1");
    expect((runtime as any).waitResult).not.toHaveBeenCalled();
    await provider.action("tail", { jobId: "job-1", tailLines: 10 });
    expect(runtime.tail).toHaveBeenCalledWith("job-1");
    await provider.action("stop", { jobId: "job-1" });
    expect(runtime.stopMany).toHaveBeenCalledWith(["job-1"]);
    expect(runtime.stopManyResult).not.toHaveBeenCalled();
    announce();
  });
});
