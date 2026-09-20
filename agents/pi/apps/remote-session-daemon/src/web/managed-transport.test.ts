import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedSessionTransport } from "./managed-transport.ts";

const command = {
  version: 1 as const,
  type: "command" as const,
  commandId: "cmd-1",
  generation: "gen-1",
  commandEpoch: "epoch-1",
  content: "hello",
  delivery: "immediate" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createManagedSessionTransport", () => {
  it("exposes no image URL in this slice", () => {
    expect(createManagedSessionTransport("launch-1").imageUrl({ id: "x" } as never)).toBe("");
  });

  it("rejects history and completion without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const transport = createManagedSessionTransport("launch-1");
    await expect(transport.getHistory({} as never, new AbortController().signal)).rejects.toThrow();
    await expect(transport.complete({} as never, new AbortController().signal)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the command to the absolute per-session endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        version: 1,
        type: "command-response",
        commandId: "cmd-1",
        generation: "gen-1",
        commandEpoch: "epoch-1",
        accepted: true,
      }),
    );
    const transport = createManagedSessionTransport("launch 1");
    const response = await transport.submit(command, new AbortController().signal);
    expect(response.accepted).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/_pi/api/v1/sessions/launch%201/command");
  });

  it("posts strict shared model controls and validates their response envelope", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        version: 1,
        type: "command-response",
        commandId: "model-1",
        generation: "gen-1",
        commandEpoch: "epoch-1",
        accepted: true,
      }),
    );
    const transport = createManagedSessionTransport("launch-1");
    await expect(
      transport.submitModelControl(
        {
          version: 1,
          type: "set-thinking",
          commandId: "model-1",
          generation: "gen-1",
          commandEpoch: "epoch-1",
          thinkingLevel: "max",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ accepted: true });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/_pi/api/v1/sessions/launch-1/command");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: "set-thinking",
      thinkingLevel: "max",
    });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ accepted: true }));
    await expect(
      transport.submitModelControl(
        {
          version: 1,
          type: "set-model",
          commandId: "model-2",
          generation: "gen-1",
          commandEpoch: "epoch-1",
          provider: "provider",
          modelId: "model",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Model control delivery unconfirmed");

    for (const reason of ["capability-off", "invalid", "queue-busy", "session-changed"] as const) {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          type: "command-response",
          commandId: "model-2",
          generation: "gen-1",
          commandEpoch: "epoch-1",
          accepted: false,
          error: "rejected",
          reason,
        }),
      );
      await expect(
        transport.submitModelControl(
          {
            version: 1,
            type: "set-model",
            commandId: "model-2",
            generation: "gen-1",
            commandEpoch: "epoch-1",
            provider: "provider",
            modelId: "model",
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ accepted: false, reason });
    }

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        version: 1,
        type: "command-response",
        commandId: "model-2",
        generation: "gen-1",
        commandEpoch: "epoch-1",
        accepted: false,
        error: "missing reason",
      }),
    );
    await expect(
      transport.submitModelControl(
        {
          version: 1,
          type: "set-model",
          commandId: "model-2",
          generation: "gen-1",
          commandEpoch: "epoch-1",
          provider: "provider",
          modelId: "model",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Model control delivery unconfirmed");

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        version: 1,
        type: "command-response",
        commandId: "model-2",
        generation: "gen-1",
        commandEpoch: "epoch-1",
        accepted: false,
        error: "wrong reason",
        reason: "wrong",
      }),
    );
    await expect(
      transport.submitModelControl(
        {
          version: 1,
          type: "set-model",
          commandId: "model-2",
          generation: "gen-1",
          commandEpoch: "epoch-1",
          provider: "provider",
          modelId: "model",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Model control delivery unconfirmed");

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        version: 1,
        type: "command-response",
        commandId: "wrong-command",
        generation: "gen-1",
        commandEpoch: "epoch-1",
        accepted: false,
        error: "wrong identifier",
        reason: "invalid",
      }),
    );
    await expect(
      transport.submitModelControl(
        {
          version: 1,
          type: "set-model",
          commandId: "model-2",
          generation: "gen-1",
          commandEpoch: "epoch-1",
          provider: "provider",
          modelId: "model",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Model control delivery unconfirmed");
  });

  it("reveals an unloaded lifecycle after an attached stream disconnects", async () => {
    class FakeEventSource {
      static instance: FakeEventSource;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeEventSource.instance = this;
      }
      close() {}
    }
    const reload = vi.fn();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("location", { reload });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ launch: { lifecycle: "unloaded", ready: false } }));
    const transport = createManagedSessionTransport("launch-1");
    transport.connect({ onEnvelope: vi.fn(), onStatus: vi.fn() });
    FakeEventSource.instance.onerror?.();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/_pi/api/v1/sessions/launch-1");
  });

  it("treats a network failure as ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const transport = createManagedSessionTransport("launch-1");
    await expect(transport.submit(command, new AbortController().signal)).rejects.toThrow(
      "Command delivery unconfirmed",
    );
  });

  it("treats an ambiguous 409 error envelope as ambiguous, not a rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          version: 1,
          type: "error",
          generation: "gen-1",
          commandId: "cmd-1",
          code: "ADMISSION_AMBIGUOUS",
          message: "unknown",
          recoverable: false,
        },
        409,
      ),
    );
    const transport = createManagedSessionTransport("launch-1");
    await expect(transport.submit(command, new AbortController().signal)).rejects.toThrow(
      "Command delivery unconfirmed",
    );
  });
});
