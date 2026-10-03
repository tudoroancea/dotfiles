import { beforeEach, describe, expect, it, vi } from "vitest";
import toolsExtension from "../tools.ts";

function commandHarness(extension: (pi: never) => void) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const events = { emit: vi.fn() };
  const pi = {
    registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    }),
    on: vi.fn(),
    events,
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  extension(pi as never);
  return { handler: handler!, events, pi };
}

describe("interactive command lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("guards /tools outside TUI mode", async () => {
    const { handler, events } = commandHarness(toolsExtension as never);
    const custom = vi.fn();
    const notify = vi.fn();
    await handler("", { mode: "rpc", ui: { custom, notify } });
    expect(notify).toHaveBeenCalledWith("/tools requires interactive TUI mode.", "error");
    expect(custom).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("does not block for the user-initiated /tools UI", async () => {
    for (const reject of [false, true]) {
      const { handler, events } = commandHarness(toolsExtension as never);
      const custom = reject
        ? vi.fn(async () => {
            throw new Error("UI failed");
          })
        : vi.fn(async () => undefined);
      const operation = handler("", { mode: "tui", ui: { custom, notify: vi.fn() } });
      if (reject) await expect(operation).rejects.toThrow("UI failed");
      else await operation;
      expect(events.emit).not.toHaveBeenCalled();
    }
  });
});
