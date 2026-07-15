import { describe, expect, it, vi } from "vitest";
import {
  createAutomaticSessionNameExtension,
  firstExchangeTranscript,
  normalizeSessionName,
  selectNamingModel,
} from "../src/session-naming-extension.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(generateName: any) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const entries: any[] = [];
  let name: string | undefined;
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getSessionName: () => name,
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    setSessionName: vi.fn((value: string) => {
      name = value;
      for (const handler of handlers.get("session_info_changed") ?? [])
        handler({ name: value }, context);
    }),
  };
  const sessionManager = {
    getBranch: () => [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Refactor the auth flow" }] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Updated token refresh and tests." }],
        },
      },
    ],
    getSessionFile: () => "/sessions/session-1.jsonl",
    getSessionId: () => "session-1",
    getEntries: () => entries,
  };
  const context = {
    cwd: "/repo",
    model: { provider: "pave", id: "gpt-5.6-sol" },
    modelRegistry: {},
    sessionManager,
  };
  createAutomaticSessionNameExtension({ generateName })(pi as never);
  const emit = (event: string, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, context);
  };
  return {
    pi,
    emit,
    context,
    entries,
    setManualName(value: string | undefined) {
      name = value;
      entries.push({ type: "session_info", name: value });
      emit("session_info_changed", { name: value });
    },
  };
}

describe("automatic session naming", () => {
  it("names an unnamed persisted session once after the first settled exchange", async () => {
    const generateName = vi.fn().mockResolvedValue("refactor auth flow");
    const test = harness(generateName);
    test.emit("session_start", { reason: "startup" });
    test.emit("agent_settled");
    test.emit("agent_settled");
    await flush();

    expect(generateName).toHaveBeenCalledTimes(1);
    expect(test.pi.setSessionName).toHaveBeenCalledWith("refactor auth flow");
  });

  it("does not overwrite an existing or manually touched name", async () => {
    let resolve!: (value: string) => void;
    const generateName = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const test = harness(generateName);
    test.emit("session_start", { reason: "startup" });
    test.emit("agent_settled");
    test.setManualName("manual title");
    resolve("automatic title");
    await flush();

    expect(test.pi.setSessionName).not.toHaveBeenCalled();
  });

  it("rejects a stale completion after session shutdown", async () => {
    let resolve!: (value: string) => void;
    const generateName = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const test = harness(generateName);
    test.emit("session_start", { reason: "startup" });
    test.emit("agent_settled");
    test.emit("session_shutdown", { reason: "new" });
    resolve("stale title");
    await flush();

    expect(test.pi.setSessionName).not.toHaveBeenCalled();
    expect((generateName.mock.calls as any[][])[0]?.[2].aborted).toBe(true);
  });

  it("treats a pre-existing or explicitly cleared name as manually owned", async () => {
    for (const existing of ["existing title", undefined]) {
      const generateName = vi.fn().mockResolvedValue("automatic title");
      const test = harness(generateName);
      test.setManualName(existing);
      test.emit("session_start", { reason: "resume" });
      test.emit("agent_settled");
      await flush();

      expect(generateName).not.toHaveBeenCalled();
    }
  });

  it("persists the attempt guard across reloads of the same session", async () => {
    const generateName = vi.fn().mockResolvedValue(null);
    const test = harness(generateName);
    test.emit("session_start", { reason: "startup" });
    test.emit("agent_settled");
    await flush();
    test.emit("session_start", { reason: "reload" });
    test.emit("agent_settled");
    await flush();

    expect(generateName).toHaveBeenCalledTimes(1);
    expect(test.pi.appendEntry).toHaveBeenCalledTimes(1);
  });
});

describe("session naming helpers", () => {
  it("extracts the first user and assistant text only", () => {
    const transcript = firstExchangeTranscript({
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "user", content: "Build the parser" } },
          { type: "message", message: { role: "toolResult", content: "ignored" } },
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "Parser shipped" }] },
          },
          { type: "message", message: { role: "user", content: "Another topic" } },
        ],
      },
    } as never);
    expect(transcript).toBe(
      "User request:\nBuild the parser\n\nAssistant outcome:\nParser shipped",
    );
  });

  it("does not cross provider boundaries to find a Luna model", () => {
    const active = { provider: "local", id: "private-model" };
    const remote = { provider: "pave", id: "gpt-5.6-luna" };
    const find = vi.fn((provider: string) => (provider === "pave" ? remote : undefined));

    expect(selectNamingModel({ model: active, modelRegistry: { find } } as never)).toBe(active);
    expect(find).toHaveBeenCalledWith("local", "gpt-5.6-luna");
    expect(find).not.toHaveBeenCalledWith("pave", "gpt-5.6-luna");
  });

  it("normalizes model output to a bounded plain title", () => {
    expect(normalizeSessionName('## "Refactor   Auth Flow!"')).toBe("refactor auth flow");
    expect(normalizeSessionName("   ")).toBeNull();
    expect(normalizeSessionName("one two three four five six")).toBeNull();
    expect(normalizeSessionName("Here is the title: Refactor Auth Flow")).toBeNull();
    expect(normalizeSessionName("refactor/auth flow now")).toBeNull();
    expect(normalizeSessionName("refactor auth\nextra explanation")).toBeNull();
  });
});
