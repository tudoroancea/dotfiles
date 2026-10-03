import { exec } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import notifyExtension from "../notify.ts";

vi.mock("node:child_process", () => ({ exec: vi.fn() }));

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
class FakeStdin extends EventEmitter {
  isTTY = true;
  readableFlowing: boolean | null = false;
  pause = vi.fn();
}

let stdin: FakeStdin;
let write: ReturnType<typeof vi.fn>;
let shutdown: (() => Promise<void>) | undefined;
let platformDescriptor: PropertyDescriptor;

function harness(mode = "tui", noConfetti = false) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const ctx = {
    mode,
    hasUI: true,
    ui: { notify: vi.fn(), custom: vi.fn(), setStatus: vi.fn() },
  };
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, command: Command) => commands.set(name, command)),
    getFlag: vi.fn(() => noConfetti),
  };
  notifyExtension(pi as unknown as ExtensionAPI);
  const emit = async (event: string, data: Record<string, unknown> = {}) => {
    await handlers.get(event)?.(data, ctx as unknown as ExtensionContext);
  };
  shutdown = () => emit("session_shutdown");
  const command = (args = "") =>
    commands.get("notify-test")!.handler(args, ctx as unknown as ExtensionContext);
  const end = (stopReason = "stop", content: unknown = "Completed the task") =>
    emit("agent_end", {
      messages: [{ role: "assistant", stopReason, content }],
    });
  const focus = async (focused: boolean) => {
    stdin.emit("data", Buffer.from(focused ? "\x1b[I" : "\x1b[O"));
    await vi.advanceTimersByTimeAsync(100);
  };
  return { ctx, pi, emit, command, end, focus };
}

function output() {
  return write.mock.calls.map(([text]) => text as string);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  stdin = new FakeStdin();
  write = vi.fn(() => true);
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue({ write } as unknown as typeof process.stdout);
  platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  vi.mocked(exec).mockClear();
});

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("notification mode boundaries", () => {
  it.each(["rpc", "print", "json"])(
    "does nothing in %s even with hasUI true and inactive TTY streams",
    async (mode) => {
      const h = harness(mode);
      const on = vi.spyOn(stdin, "on");
      const off = vi.spyOn(stdin, "off");
      await h.emit("session_start");
      await vi.advanceTimersByTimeAsync(60_000);
      await h.emit("tool_call", { toolName: "questionnaire" });
      await h.end();
      await h.end("error");
      await h.command("5");
      await h.emit("session_shutdown");
      expect(write).not.toHaveBeenCalled();
      expect(on).not.toHaveBeenCalled();
      expect(off).not.toHaveBeenCalled();
      expect(stdin.pause).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(h.ctx.ui.notify).not.toHaveBeenCalled();
      expect(h.ctx.ui.custom).not.toHaveBeenCalled();
      expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
      expect(h.pi.getFlag).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("registers the no-confetti flag and test command without performing terminal actions", () => {
    const h = harness();
    expect(h.pi.registerFlag).toHaveBeenCalledExactlyOnceWith("no-confetti", {
      description: "Disable confetti",
      type: "boolean",
      default: false,
    });
    expect(h.pi.registerCommand).toHaveBeenCalledWith(
      "notify-test",
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(write).not.toHaveBeenCalled();
    expect(stdin.listenerCount("data")).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("TUI notifications", () => {
  it("enables focus reporting once and suppresses completion and questionnaire notifications while focused", async () => {
    const h = harness();
    await h.emit("session_start");
    expect(output()).toEqual(["\x1b[?1004h"]);
    expect(stdin.listenerCount("data")).toBe(1);
    write.mockClear();
    await h.end();
    await h.emit("tool_call", { toolName: "questionnaire" });
    await h.focus(true);
    await h.end();
    expect(write).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["stop", "toolUse"])(
    "notifies on unfocused successful %s and invokes only mocked confetti",
    async (reason) => {
      const h = harness();
      await h.emit("session_start");
      await h.focus(false);
      write.mockClear();
      await h.end(reason, [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Fixed" },
        { type: "toolCall", name: "bash" },
        { type: "text", text: "tests" },
      ]);
      expect(output()).toEqual([
        "\x1b]777;notify;✅ Pi finished;Fixed tests\x07",
        "\x1b]9;Fixed tests\x07",
      ]);
      expect(exec).toHaveBeenCalledExactlyOnceWith(
        "open -g raycast-x://extensions/raycast/raycast/confetti",
      );
      await h.focus(true);
      write.mockClear();
      vi.mocked(exec).mockClear();
      await h.end(reason);
      expect(write).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it.each(["error", "aborted", "length"])("notifies without confetti for %s", async (reason) => {
    const h = harness();
    await h.emit("session_start");
    await h.focus(false);
    write.mockClear();
    await h.end(reason);
    expect(output()[0]).toBe("\x1b]777;notify;⚠️ Pi stopped;Completed the task\x07");
    expect(output()).toHaveLength(2);
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses the last assistant, not later tool/user messages, and sanitizes OSC delimiters and controls", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.focus(false);
    write.mockClear();
    await h.emit("agent_end", {
      messages: [
        { role: "assistant", stopReason: "error", content: "old" },
        {
          role: "assistant",
          stopReason: "stop",
          content: "fixed;\x1b]9;injected\x07\n\x00\x7f\x85 all tests",
        },
        { role: "toolResult", content: "tool output" },
        { role: "user", content: "new request" },
      ],
    });
    expect(output()).toEqual([
      "\x1b]777;notify;✅ Pi finished;fixed ]9 injected all tests\x07",
      "\x1b]9;fixed ]9 injected all tests\x07",
    ]);
  });

  it("supplies a fallback summary when no assistant text is available", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.focus(false);
    write.mockClear();
    await h.emit("agent_end", { messages: [] });
    expect(output()).toEqual([
      "\x1b]777;notify;⚠️ Pi stopped;Task completed.\x07",
      "\x1b]9;Task completed.\x07",
    ]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("notifies for questionnaire only, without confetti or custom UI", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.focus(false);
    write.mockClear();
    await h.emit("tool_call", { toolName: "bash" });
    expect(write).not.toHaveBeenCalled();
    await h.emit("tool_call", { toolName: "questionnaire" });
    expect(output()).toEqual([
      "\x1b]777;notify;❓ Pi has a question;Check the terminal to provide input.\x07",
      "\x1b]9;Check the terminal to provide input.\x07",
    ]);
    expect(exec).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    expect(h.ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("honors no-confetti without suppressing desktop notification", async () => {
    const h = harness("tui", true);
    await h.emit("session_start");
    await h.focus(false);
    write.mockClear();
    await h.end();
    expect(output()).toHaveLength(2);
    expect(h.pi.getFlag).toHaveBeenCalledWith("no-confetti");
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not invoke macOS confetti on another platform", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    const h = harness();
    await h.emit("session_start");
    await h.focus(false);
    write.mockClear();
    await h.end();
    expect(output()).toHaveLength(2);
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back after strictly more than 45 seconds without activity, and input resets inactivity", async () => {
    const h = harness();
    await h.emit("session_start");
    write.mockClear();
    await vi.advanceTimersByTimeAsync(45_000);
    await h.end();
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await h.end();
    expect(output()).toHaveLength(2);
    write.mockClear();
    stdin.emit("data", Buffer.from("typing"));
    await h.end();
    expect(write).not.toHaveBeenCalled();
    await h.focus(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.end();
    expect(write).not.toHaveBeenCalled();
  });

  it("debounces rapid focus changes and applies only the last one", async () => {
    const h = harness();
    await h.emit("session_start");
    write.mockClear();
    stdin.emit("data", Buffer.from("\x1b[O"));
    await vi.advanceTimersByTimeAsync(99);
    await h.end();
    expect(write).not.toHaveBeenCalled();
    stdin.emit("data", Buffer.from("\x1b[I"));
    await vi.advanceTimersByTimeAsync(100);
    await h.end();
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await h.focus(false);
    await h.end();
    expect(output()).toHaveLength(2);
  });
});

describe("notification cleanup and commands", () => {
  it.each([false, true])(
    "cleans a pending debounce, detaches only its listener, and preserves initially flowing stdin=%s",
    async (flowing) => {
      stdin.readableFlowing = flowing;
      const unrelated = vi.fn();
      stdin.on("data", unrelated);
      const h = harness();
      await h.emit("session_start");
      stdin.emit("data", Buffer.from("\x1b[O"));
      expect(vi.getTimerCount()).toBe(1);
      write.mockClear();
      await h.emit("session_shutdown");
      await h.emit("session_shutdown");
      expect(output()).toEqual(["\x1b[?1004l"]);
      expect(stdin.listeners("data")).toEqual([unrelated]);
      expect(stdin.pause).toHaveBeenCalledTimes(flowing ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      await h.emit("session_start");
      expect(stdin.listenerCount("data")).toBe(2);
      write.mockClear();
      await h.end();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("restarts with a single listener and no stale debounce or unfocused state", async () => {
    const h = harness();
    await h.emit("session_start");
    stdin.emit("data", Buffer.from("\x1b[O"));
    await h.emit("session_start");
    expect(output()).toEqual(["\x1b[?1004h", "\x1b[?1004l", "\x1b[?1004h"]);
    expect(stdin.listenerCount("data")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    write.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    await h.end();
    expect(write).not.toHaveBeenCalled();
    await h.focus(false);
    await h.end();
    expect(output()).toHaveLength(2);
  });

  it("removes TUI tracking when restarting in RPC, then can return to TUI", async () => {
    const h = harness();
    await h.emit("session_start");
    stdin.emit("data", Buffer.from("\x1b[O"));
    h.ctx.mode = "rpc";
    await h.emit("session_start");
    expect(output()).toEqual(["\x1b[?1004h", "\x1b[?1004l"]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    write.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.end();
    await h.command("2");
    expect(write).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    h.ctx.mode = "tui";
    await h.emit("session_start");
    expect(output()).toEqual(["\x1b[?1004h"]);
    expect(stdin.listenerCount("data")).toBe(1);
  });

  it("does not enable focus reporting or attach stdin listeners without a TTY", async () => {
    stdin.isTTY = false;
    const h = harness();
    await h.emit("session_start");
    await h.emit("session_shutdown");
    expect(write).not.toHaveBeenCalled();
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.pause).not.toHaveBeenCalled();
  });

  it("runs delayed notify-test with fake time and restores focused state", async () => {
    const h = harness();
    await h.emit("session_start");
    write.mockClear();
    const operation = h.command("2");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      "Waiting 2 seconds before sending notification...",
      "info",
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(output()).toEqual([
      "\x1b]777;notify;🔔 Test;Native notification working!\x07",
      "\x1b]9;Native notification working!\x07",
    ]);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      "Sent test notification. Check your desktop!",
      "info",
    );
    await vi.advanceTimersByTimeAsync(100);
    await operation;
    write.mockClear();
    await h.end();
    expect(write).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
