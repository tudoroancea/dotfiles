import { beforeEach, describe, expect, it, vi } from "vitest";
import questionnaireExtension from "../questionnaire.ts";
import sessionBreakdownExtension from "../session-breakdown.ts";
import toolsExtension from "../tools.ts";

function questionnaireHarness() {
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  const events = { emit: vi.fn() };
  questionnaireExtension({
    registerTool: (value: typeof tool) => {
      tool = value;
    },
    events,
  } as never);
  return { tool: tool!, events };
}

function question() {
  return {
    questions: [{ id: "scope", prompt: "Choose", options: [{ value: "a", label: "A" }] }],
  };
}

function questionnaireContext(mode: string, custom: ReturnType<typeof vi.fn>) {
  return { mode, hasUI: mode === "tui" || mode === "rpc", ui: { custom } };
}

describe("questionnaire lifecycle", () => {
  it("balances blocked events around answers and cancellation", async () => {
    const { tool, events } = questionnaireHarness();
    for (const cancelled of [false, true]) {
      events.emit.mockClear();
      const custom = vi.fn(async () => ({ questions: [], answers: [], cancelled }));
      await tool.execute(
        "call",
        question(),
        undefined,
        undefined,
        questionnaireContext("tui", custom),
      );
      expect(events.emit.mock.calls).toEqual([
        ["herdr:blocked", { active: true, label: "Waiting for questionnaire response" }],
        ["herdr:blocked", { active: false }],
      ]);
    }
  });

  it("cleans up after UI rejection", async () => {
    const { tool, events } = questionnaireHarness();
    const custom = vi.fn(async () => {
      throw new Error("UI failed");
    });
    await expect(
      tool.execute("call", question(), undefined, undefined, questionnaireContext("tui", custom)),
    ).rejects.toThrow("UI failed");
    expect(events.emit).toHaveBeenLastCalledWith("herdr:blocked", { active: false });
  });

  it.each(["rpc", "json", "print"])(
    "rejects %s mode without entering a blocked scope",
    async (mode) => {
      const { tool, events } = questionnaireHarness();
      const custom = vi.fn(async () => undefined);
      const result = await tool.execute(
        "call",
        question(),
        undefined,
        undefined,
        questionnaireContext(mode, custom),
      );
      expect(result.details.cancelled).toBe(true);
      expect(result.content[0].text).toContain("interactive TUI mode");
      expect(custom).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    },
  );
});

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

describe("other interactive extension lifecycle", () => {
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

  it("balances /tools custom UI success and rejection", async () => {
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
      expect(events.emit.mock.calls).toEqual([
        ["herdr:blocked", { active: true, label: "Waiting for tool settings input" }],
        ["herdr:blocked", { active: false }],
      ]);
    }
  });

  it("leaves the session analysis loader unblocked", async () => {
    const { handler, events } = commandHarness(sessionBreakdownExtension as never);
    const custom = vi.fn(async () => null);
    await handler("", { mode: "tui", hasUI: true, ui: { custom, notify: vi.fn() } });
    expect(custom).toHaveBeenCalledOnce();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("balances only the post-analysis breakdown viewer", async () => {
    for (const rejectViewer of [false, true]) {
      const { handler, events } = commandHarness(sessionBreakdownExtension as never);
      const data = { ranges: new Map(), palette: {}, generatedAt: new Date() };
      const custom = vi
        .fn()
        .mockResolvedValueOnce(data)
        .mockImplementationOnce(async () => {
          if (rejectViewer) throw new Error("viewer failed");
        });
      const operation = handler("", { mode: "tui", hasUI: true, ui: { custom, notify: vi.fn() } });
      if (rejectViewer) await expect(operation).rejects.toThrow("viewer failed");
      else await operation;
      expect(events.emit.mock.calls).toEqual([
        ["herdr:blocked", { active: true, label: "Waiting for session breakdown input" }],
        ["herdr:blocked", { active: false }],
      ]);
    }
  });
});
