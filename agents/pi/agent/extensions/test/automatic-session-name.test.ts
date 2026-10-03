import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutomaticSessionNameExtension,
  firstExchangeTranscript,
  generateSessionName,
  normalizeSessionName,
} from "../automatic-session-name.ts";

type GenerateName = NonNullable<Parameters<typeof createAutomaticSessionNameExtension>[0]>;
type Entry = Record<string, unknown>;
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => void;
const exchange = () => [
  { type: "message", message: { role: "user", content: "Fix the failing tests" } },
  { type: "message", message: { role: "assistant", content: "Fixed the fixtures" } },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function namingHarness(
  generate: GenerateName = vi.fn<GenerateName>().mockResolvedValue("fix failing tests"),
) {
  const handlers = new Map<string, Handler>();
  const state = {
    sessionId: "session-a",
    file: "/test/session-a.jsonl" as string | undefined,
    name: undefined as string | undefined,
    entries: [] as Entry[],
    branch: exchange() as Entry[],
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => state.sessionId,
      getSessionFile: () => state.file,
      getEntries: () => state.entries,
      getBranch: () => state.branch,
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    getSessionName: vi.fn(() => state.name),
    setSessionName: vi.fn((name: string) => {
      state.name = name;
      handlers.get("session_info_changed")?.({}, ctx);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      state.entries.push({ type: "custom", customType, data });
    }),
  };
  const install = () =>
    createAutomaticSessionNameExtension(generate)(pi as unknown as ExtensionAPI);
  install();
  const emit = async (event: string) => {
    handlers.get(event)?.({}, ctx);
    // Drain the generator's then/catch/finally chain without advancing timers.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { state, ctx, pi, generate, emit, install };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("automatic naming lifecycle", () => {
  it("persists the attempt before generation, normalizes the title, and never retries after reload", async () => {
    const h = namingHarness();
    await h.emit("session_start");
    await h.emit("agent_settled");
    expect(h.pi.appendEntry).toHaveBeenCalledWith("automatic-session-name-attempt", {
      sessionId: "session-a",
    });
    expect(h.pi.appendEntry.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.generate).mock.invocationCallOrder[0]!,
    );
    expect(h.generate).toHaveBeenCalledWith(
      h.ctx,
      "User request:\nFix the failing tests\n\nAssistant outcome:\nFixed the fixtures",
      expect.any(AbortSignal),
    );
    expect(h.pi.setSessionName).toHaveBeenCalledExactlyOnceWith("fix failing tests");
    await h.emit("agent_settled");
    h.state.name = undefined;
    h.install();
    await h.emit("session_start");
    await h.emit("agent_settled");
    expect(h.generate).toHaveBeenCalledOnce();
    expect(h.pi.appendEntry).toHaveBeenCalledOnce();
  });

  it("marks an in-flight attempt once even across repeated settlement callbacks", async () => {
    const pending = deferred<string | null>();
    const generate = vi.fn<GenerateName>(() => pending.promise);
    const h = namingHarness(generate);
    await h.emit("session_start");
    await h.emit("agent_settled");
    await h.emit("agent_settled");
    expect(generate).toHaveBeenCalledOnce();
    expect(h.pi.appendEntry).toHaveBeenCalledOnce();
    pending.resolve(' # "Fix Failing Tests!" ');
    await h.emit("agent_settled");
    expect(h.pi.setSessionName).toHaveBeenCalledWith("fix failing tests");
  });

  it.each(["existing", "empty", "historical", "manual", "cleared"])(
    "does not override %s naming",
    async (kind) => {
      const h = namingHarness();
      if (kind === "existing") h.state.name = "my title";
      if (kind === "empty") h.state.name = "";
      if (kind === "historical") h.state.entries.push({ type: "session_info", name: "" });
      await h.emit("session_start");
      if (kind === "manual" || kind === "cleared") {
        h.state.name = "manual title";
        await h.emit("session_info_changed");
        if (kind === "cleared") {
          h.state.name = undefined;
          await h.emit("session_info_changed");
        }
      }
      await h.emit("agent_settled");
      expect(h.generate).not.toHaveBeenCalled();
      expect(h.pi.appendEntry).not.toHaveBeenCalled();
      expect(h.pi.setSessionName).not.toHaveBeenCalled();
    },
  );

  it.each(["manual", "cleared", "switch", "shutdown"])(
    "aborts in-flight generation on %s and ignores late results",
    async (action) => {
      const pending = deferred<string | null>();
      const generate = vi.fn<GenerateName>(() => pending.promise);
      const h = namingHarness(generate);
      await h.emit("session_start");
      await h.emit("agent_settled");
      const signal = generate.mock.calls[0]![2];
      if (action === "shutdown") await h.emit("session_shutdown");
      else if (action === "switch") {
        h.state.sessionId = "session-b";
        await h.emit("session_start");
      } else {
        h.state.name = action === "manual" ? "my manual title" : undefined;
        await h.emit("session_info_changed");
      }
      expect(signal.aborted).toBe(true);
      pending.resolve("fix failing tests");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.pi.setSessionName).not.toHaveBeenCalled();
    },
  );

  it("allows a fresh attempt in a different session while an old promise completes", async () => {
    const old = deferred<string | null>();
    const next = deferred<string | null>();
    const generate = vi
      .fn<GenerateName>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    const h = namingHarness(generate);
    await h.emit("session_start");
    await h.emit("agent_settled");
    h.state.sessionId = "session-b";
    h.state.entries = [];
    await h.emit("session_start");
    await h.emit("agent_settled");
    old.resolve("stale session title");
    await h.emit("agent_settled");
    expect(h.pi.setSessionName).not.toHaveBeenCalled();
    next.resolve("new session title");
    await h.emit("agent_settled");
    expect(h.pi.setSessionName).toHaveBeenCalledExactlyOnceWith("new session title");
    expect(h.pi.appendEntry).toHaveBeenLastCalledWith("automatic-session-name-attempt", {
      sessionId: "session-b",
    });
  });

  it("rejects stale results even if the session ID changes without a start event", async () => {
    const pending = deferred<string | null>();
    const h = namingHarness(() => pending.promise);
    await h.emit("session_start");
    await h.emit("agent_settled");
    h.state.sessionId = "session-b";
    pending.resolve("stale session title");
    await h.emit("agent_settled");
    expect(h.pi.setSessionName).not.toHaveBeenCalled();
  });

  it.each([null, "invalid", "three words\ncontrol"])(
    "does not retry an unusable result %j",
    async (result) => {
      const generate = vi.fn<GenerateName>().mockResolvedValue(result);
      const h = namingHarness(generate);
      await h.emit("session_start");
      await h.emit("agent_settled");
      await h.emit("agent_settled");
      h.install();
      await h.emit("session_start");
      await h.emit("agent_settled");
      expect(generate).toHaveBeenCalledOnce();
      expect(h.pi.setSessionName).not.toHaveBeenCalled();
    },
  );

  it("contains rejected generation and persistence errors without retrying", async () => {
    const generate = vi.fn<GenerateName>().mockRejectedValue(new Error("provider failed"));
    const h = namingHarness(generate);
    h.pi.appendEntry.mockImplementation(() => {
      throw new Error("disk failed");
    });
    await h.emit("session_start");
    await h.emit("agent_settled");
    await h.emit("agent_settled");
    expect(generate).toHaveBeenCalledOnce();
    expect(h.pi.setSessionName).not.toHaveBeenCalled();
  });

  it("contains setSessionName errors and retains the attempt guard", async () => {
    const h = namingHarness();
    h.pi.setSessionName.mockImplementation(() => {
      throw new Error("save failed");
    });
    await h.emit("session_start");
    await h.emit("agent_settled");
    await h.emit("agent_settled");
    expect(h.generate).toHaveBeenCalledOnce();
    expect(h.pi.setSessionName).toHaveBeenCalledOnce();
  });

  it("waits for a persisted session and a complete exchange without consuming an attempt", async () => {
    const h = namingHarness();
    await h.emit("session_start");
    h.state.file = undefined;
    await h.emit("agent_settled");
    h.state.file = "/test/session-a.jsonl";
    h.state.branch = exchange().slice(0, 1);
    await h.emit("agent_settled");
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    h.state.branch = exchange();
    await h.emit("agent_settled");
    expect(h.generate).toHaveBeenCalledOnce();
  });

  it("ignores attempt markers belonging to other sessions", async () => {
    const h = namingHarness();
    h.state.entries = [
      {
        type: "custom",
        customType: "automatic-session-name-attempt",
        data: { sessionId: "other" },
      },
      { type: "custom", customType: "automatic-session-name-attempt" },
      { type: "custom", customType: "unrelated", data: { sessionId: "session-a" } },
    ];
    await h.emit("session_start");
    await h.emit("agent_settled");
    expect(h.generate).toHaveBeenCalledOnce();
  });
});

describe("naming transcript and normalization", () => {
  it("extracts only text from the first exchange, skipping tools, reasoning, images, and empty messages", () => {
    const h = namingHarness();
    h.state.branch = [
      { type: "custom", data: "ignore" },
      { type: "message", message: { role: "assistant", content: "before user" } },
      { type: "message", message: { role: "user", content: [{ type: "image", data: "secret" }] } },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "  fix" },
            { type: "text", text: "tests  " },
            { type: "image", data: "secret" },
          ],
        },
      },
      { type: "message", message: { role: "toolResult", content: "tool output" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "private reasoning" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "  repaired" },
            { type: "toolCall", name: "bash" },
            { type: "text", text: "fixtures  " },
          ],
        },
      },
      ...exchange(),
    ];
    expect(firstExchangeTranscript(h.ctx)).toBe(
      "User request:\nfix\ntests\n\nAssistant outcome:\nrepaired\nfixtures",
    );
  });

  it("bounds transcript length and requires both text-bearing sides", () => {
    const h = namingHarness();
    h.state.branch = [
      { type: "message", message: { role: "user", content: "u".repeat(2000) } },
      { type: "message", message: { role: "assistant", content: "a".repeat(2000) } },
    ];
    const transcript = firstExchangeTranscript(h.ctx)!;
    expect(transcript).toHaveLength(2400);
    expect(transcript).toContain(`User request:\n${"u".repeat(1200)}\n\nAssistant outcome:\n`);
    h.state.branch = [];
    expect(firstExchangeTranscript(h.ctx)).toBeNull();
    h.state.branch = [{ type: "message", message: { role: "user", content: "  " } }];
    expect(firstExchangeTranscript(h.ctx)).toBeNull();
  });

  it.each([
    ['  # "Fix Failing Tests!"  ', "fix failing tests"],
    ["**Build 2 Safe-Guards**", "build 2 safe-guards"],
    ["one two three four five", "one two three four five"],
    ["one  two   three", "one two three"],
    ["", null],
    ["one two", null],
    ["one two three four five six", null],
    ["one two three\n", "one two three"],
    ["one\ntwo three", null],
    ["one\ttwo three", null],
    ["one two three\x1b", null],
    ["one two three\x7f", null],
    ["one two three: explanation", null],
    ["one two café", null],
    [`${"a".repeat(56)} bb cc`, null],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeSessionName(input)).toBe(expected);
  });
});

function generatorHarness() {
  const model = { provider: "test-provider", id: "current" };
  const preferred = { provider: "test-provider", id: "gpt-5.6-luna" };
  const complete = vi.fn().mockResolvedValue({
    stopReason: "stop",
    content: [{ type: "text", text: '"Fix Failing Tests"' }],
  });
  const find = vi.fn().mockReturnValue(preferred);
  const ctx = { model, modelRegistry: { find, complete } } as unknown as ExtensionContext;
  return { ctx, model, preferred, complete, find };
}

describe("modelRegistry naming generator", () => {
  it("uses registry completion, preferred model, bounded tokens, transcript, and an abort signal", async () => {
    const h = generatorHarness();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    expect(await generateSessionName(h.ctx, "test transcript", controller.signal)).toBe(
      "fix failing tests",
    );
    expect(h.find).toHaveBeenCalledExactlyOnceWith("test-provider", "gpt-5.6-luna");
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(
      h.preferred,
      {
        systemPrompt: expect.stringContaining("3-5 word lowercase title"),
        messages: [
          {
            role: "user",
            content: "Create a title for this exchange:\n\ntest transcript",
            timestamp: Date.now(),
          },
        ],
        tools: [],
      },
      { signal: expect.any(AbortSignal), maxTokens: 128 },
    );
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to the active model when the preferred model is unavailable", async () => {
    const h = generatorHarness();
    h.find.mockReturnValue(undefined);
    await generateSessionName(h.ctx, "transcript", new AbortController().signal);
    expect(h.complete.mock.calls[0]![0]).toBe(h.model);
  });

  it.each(["missing model", "already aborted"])("does not call complete for %s", async (reason) => {
    const h = generatorHarness();
    const controller = new AbortController();
    if (reason === "missing model") h.ctx.model = undefined;
    else controller.abort();
    expect(await generateSessionName(h.ctx, "transcript", controller.signal)).toBeNull();
    expect(h.complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["error", "aborted"])("discards provider stop reason %s", async (stopReason) => {
    const h = generatorHarness();
    h.complete.mockResolvedValue({
      stopReason,
      content: [{ type: "text", text: "fix failing tests" }],
    });
    expect(await generateSessionName(h.ctx, "transcript", new AbortController().signal)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains provider rejection and rejects non-text or malformed titles", async () => {
    const h = generatorHarness();
    h.complete
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce({
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "fix failing tests" }],
      })
      .mockResolvedValueOnce({ stopReason: "stop", content: "too short" });
    for (let i = 0; i < 3; i++)
      expect(
        await generateSessionName(h.ctx, "transcript", new AbortController().signal),
      ).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"])(
    "settles on %s even when complete ignores its signal, and cleans timers/listeners",
    async (action) => {
      const h = generatorHarness();
      const pending = deferred<unknown>();
      h.complete.mockReturnValue(pending.promise);
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const operation = generateSessionName(h.ctx, "transcript", controller.signal);
      const providerSignal = h.complete.mock.calls[0]![2].signal as AbortSignal;
      expect(providerSignal.aborted).toBe(false);
      if (action === "abort") controller.abort();
      else {
        await vi.advanceTimersByTimeAsync(24_999);
        expect(providerSignal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await operation).toBeNull();
      expect(providerSignal.aborted).toBe(true);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      // A late rejection must remain handled after the race has settled.
      pending.reject(new Error("late provider failure"));
      await Promise.resolve();
    },
  );
});
