import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const job = {
    id: "bg_1",
    generation: 1,
    kind: "background_bash" as const,
    command: "sleep 1",
    description: undefined as string | undefined,
    cwd: "/tmp",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "running" as const,
    outputBytes: 0,
    outputPath: "/artifacts/bg_1/output.log",
    metadataPath: "/artifacts/bg_1/job.json",
    deliveryState: "pending" as const,
    verification: {
      processSettled: false,
      outputLogClosed: false,
      terminalMetadataPersisted: false,
    },
  };
  const runtime = {
    initialize: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    launch: vi.fn(async () => job),
    get: vi.fn(() => job),
    list: vi.fn(() => [] as Array<typeof job>),
    resolve: vi.fn(() => [job]),
    tail: vi.fn(),
    wait: vi.fn(async () => [job]),
    waitResult: vi.fn(async () => ({
      jobs: [],
      text: '{"jobs":[],"truncated":false,"omittedCount":0}',
      truncated: false,
      omittedCount: 0,
    })),
    stopMany: vi.fn(async () => [job]),
    stopManyResult: vi.fn(async () => ({
      jobs: [],
      text: '{"jobs":[],"truncated":false,"omittedCount":0}',
      truncated: false,
      omittedCount: 0,
    })),
    markLaunchTransferred: vi.fn(),
    flushMonitorDeliveries: vi.fn((_send: (value: unknown) => void) => 0),
    settleMonitorDeliveries: vi.fn(),
    flushCompletionDeliveries: vi.fn(
      async (_send: (payload: unknown) => unknown): Promise<boolean> => false,
    ),
  };
  const constructorCalls: Array<{ sessionId: string; options: unknown }> = [];
  class ProcessRuntime {
    constructor(sessionId: string, options: unknown) {
      constructorCalls.push({ sessionId, options });
      return runtime;
    }
  }
  return { runtime, constructorCalls, ProcessRuntime, job };
});
vi.mock("../src/runtime/process-runtime.ts", () => ({ ProcessRuntime: mocks.ProcessRuntime }));

import backgroundProcessesExtension from "../src/index.ts";

function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<
    string,
    {
      parameters: Record<string, unknown>;
      execute: (...args: unknown[]) => unknown;
      renderCall?: (...args: never[]) => unknown;
      renderResult?: (...args: never[]) => unknown;
    }
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ReturnType<typeof context>) => unknown }
  >();
  const renderers = new Map<string, (...args: never[]) => unknown>();
  const pi = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(event, handler),
    ),
    registerTool: vi.fn(
      (tool: {
        name: string;
        parameters: Record<string, unknown>;
        execute: (...args: unknown[]) => unknown;
        renderCall?: (...args: never[]) => unknown;
        renderResult?: (...args: never[]) => unknown;
      }) => tools.set(tool.name, tool),
    ),
    registerCommand: vi.fn(
      (
        name: string,
        command: { handler: (args: string, ctx: ReturnType<typeof context>) => unknown },
      ) => commands.set(name, command),
    ),
    registerMessageRenderer: vi.fn((name: string, renderer: (...args: never[]) => unknown) =>
      renderers.set(name, renderer),
    ),
    sendMessage: vi.fn(),
  };
  backgroundProcessesExtension(pi as never);
  return { pi, handlers, tools, commands, renderers };
}

function context(mode = "rpc") {
  return {
    mode,
    cwd: "/tmp",
    hasUI: mode === "rpc" || mode === "tui",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session-id" },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

describe("background processes extension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers five strict tools, three commands, and both renderers", () => {
    const { pi, tools, commands } = harness();
    expect([...tools.keys()]).toEqual([
      "background_bash",
      "monitor",
      "background_status",
      "background_wait",
      "background_stop",
    ]);
    expect([...commands.keys()]).toEqual([
      "background-tasks",
      "background-stop",
      "background-tail",
    ]);
    for (const tool of tools.values()) expect(tool.parameters.additionalProperties).toBe(false);
    for (const name of ["background_wait", "background_stop"]) {
      const schema = tools.get(name)!.parameters as {
        properties: { jobIds: { maxItems: number; uniqueItems: boolean } };
      };
      expect(schema.properties.jobIds).toMatchObject({ maxItems: 50, uniqueItems: true });
    }
    expect(pi.registerMessageRenderer).toHaveBeenCalledTimes(2);
  });

  it.each(["print", "json"])("rejects launch in %s mode before allocation", async (mode) => {
    const { handlers, tools } = harness();
    await handlers.get("session_start")?.({} as never, context() as never);
    await expect(
      tools
        .get("background_bash")!
        .execute("call", { command: "true" }, undefined, undefined, context(mode)),
    ).rejects.toThrow("unsupported");
    expect(mocks.runtime.launch).not.toHaveBeenCalled();
  });

  it("rejects an invalid timeout before allocation", async () => {
    const { handlers, tools } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
    await expect(
      tools
        .get("background_bash")!
        .execute("call", { command: "true", timeout: -1 }, undefined, undefined, ctx),
    ).rejects.toThrow("timeout");
    expect(mocks.runtime.launch).not.toHaveBeenCalled();
  });

  it("validates monitor mode and timeout before allocation and applies timeout semantics", async () => {
    const { handlers, tools } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
    await expect(
      tools
        .get("monitor")!
        .execute(
          "call",
          { command: "watch", description: "events", timeout: 3601 },
          undefined,
          undefined,
          ctx,
        ),
    ).rejects.toThrow("3600");
    await expect(
      tools
        .get("monitor")!
        .execute(
          "call",
          { command: "watch", description: "events" },
          undefined,
          undefined,
          context("print"),
        ),
    ).rejects.toThrow("unsupported");
    expect(mocks.runtime.launch).not.toHaveBeenCalled();

    await tools
      .get("monitor")!
      .execute("call", { command: "watch", description: "events" }, undefined, undefined, ctx);
    expect(mocks.runtime.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "monitor", timeout: 300 }),
    );
    await tools
      .get("monitor")!
      .execute(
        "call",
        { command: "watch", description: "events", timeout: 10, persistent: true },
        undefined,
        undefined,
        ctx,
      );
    expect(mocks.runtime.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "monitor", timeout: undefined }),
    );
  });

  it("uses steering while active, follow-up while idle, and settles one pending event", async () => {
    const { handlers, pi } = harness();
    const idle = context();
    let isIdle = false;
    idle.isIdle = () => isIdle;
    await handlers.get("session_start")?.({} as never, idle as never);
    const event = {
      jobId: "mon_1",
      description: "events",
      outputPath: "/tmp/output.log",
      delivery: 1,
      lines: ["line"],
      firstSequence: 1,
      lastSequence: 1,
      droppedLines: 0,
      droppedBytes: 0,
      splitLines: 0,
      captureBatches: 1,
      captureOnly: false,
    };
    mocks.runtime.flushMonitorDeliveries.mockImplementation((send: (value: unknown) => void) => {
      send(event);
      return 1;
    });
    const options = mocks.constructorCalls.at(-1)?.options as { onMonitorEvent: () => void };
    options.onMonitorEvent();
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ customType: "background-monitor-event" }),
      { deliverAs: "steer", triggerTurn: true },
    );
    mocks.runtime.flushMonitorDeliveries.mockReturnValue(0);
    isIdle = true;
    await handlers.get("agent_settled")?.({} as never, idle as never);
    expect(mocks.runtime.settleMonitorDeliveries).toHaveBeenCalledOnce();

    mocks.runtime.flushMonitorDeliveries.mockImplementationOnce(
      (send: (value: unknown) => void) => {
        send(event);
        return 1;
      },
    );
    await handlers.get("agent_settled")?.({} as never, idle as never);
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ customType: "background-monitor-event" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("rejects an aborted launch before allocation and transfers ownership after launch", async () => {
    const { handlers, tools } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
    const controller = new AbortController();
    controller.abort();
    await expect(
      tools
        .get("background_bash")!
        .execute("call", { command: "true" }, controller.signal, undefined, ctx),
    ).rejects.toThrow("aborted");
    expect(mocks.runtime.launch).not.toHaveBeenCalled();

    const result = (await tools
      .get("background_bash")!
      .execute("call", { command: "true" }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(mocks.runtime.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp", command: "true" }),
    );
    expect(mocks.runtime.markLaunchTransferred).toHaveBeenCalledWith("bg_1");
    expect(result.content[0]!.text).toContain("/artifacts/bg_1/output.log");
  });

  it("sanitizes and truncates footer descriptions", async () => {
    const { handlers } = harness();
    const ctx = context();
    mocks.runtime.list.mockReturnValue([
      {
        ...mocks.job,
        description: `\u001b[31munsafe\u0007 ${"x".repeat(100)}`,
      },
    ]);
    await handlers.get("session_start")?.({} as never, ctx as never);
    const options = mocks.constructorCalls.at(-1)?.options as { onChange: () => void };
    options.onChange();
    const footer = ctx.ui.setStatus.mock.calls.at(-1)?.[1] as string;
    expect(
      [...footer].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    ).toBe(true);
    expect(footer).not.toContain("[31m");
    expect(footer.length).toBeLessThan(70);
  });

  it("sanitizes ESC, CSI, OSC, C1, and control characters before rendering model values", () => {
    const { tools, renderers } = harness();
    const unsafe = `visible\u001b[31mCSI\u001b]0;OSC\u0007\u009b32mC1CSI\u009dtitle\u009cNUL\u0000BEL\u0007`;
    const themedValues: string[] = [];
    const theme = {
      bold: (value: string) => value,
      fg: (_color: string, value: string) => {
        themedValues.push(value);
        return value;
      },
    };
    const isSafe = (value: string) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code === 0x0a || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f));
      });

    const renderCall = (name: string, args: unknown) =>
      (tools.get(name)!.renderCall as (...values: unknown[]) => unknown)(args, theme);
    renderCall("background_bash", { command: unsafe });
    renderCall("background_bash", { command: "ignored", description: unsafe });
    renderCall("monitor", { command: "ignored", description: unsafe });
    renderCall("background_status", { jobId: unsafe });
    renderCall("background_wait", { jobIds: [unsafe, unsafe] });
    renderCall("background_stop", { jobIds: [unsafe, unsafe] });
    expect(themedValues.every(isSafe)).toBe(true);

    const payload = {
      jobs: [{ jobId: unsafe, status: "completed" }],
      text: unsafe,
      truncated: false,
      omittedCount: 0,
    };
    const renderResult = tools.get("background_status")!.renderResult as (
      ...args: unknown[]
    ) => unknown;
    renderResult(
      { details: payload, content: [{ type: "text", text: unsafe }] },
      { expanded: true },
      theme,
    );
    expect(themedValues.every(isSafe)).toBe(true);

    const renderMessage = renderers.get("background-process-completion") as (
      ...args: unknown[]
    ) => { text: string };
    const expanded = renderMessage(
      { details: payload, content: unsafe },
      { expanded: true },
      theme,
    );
    expect(isSafe(expanded.text)).toBe(true);
  });

  it("sanitizes ESC, C0, and C1 CSI/OSC/ST controls in all command notifications", async () => {
    const { handlers, commands } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
    const unsafe = `visible\u001b[31mCSI\u001b]title\u001b\\ESCST\u009b32mC1CSI\u009dtitle\u009cC1ST\u0000BEL\u0007`;
    const unsafeJob = { ...mocks.job, command: unsafe, description: unsafe };
    mocks.runtime.list.mockReturnValue([unsafeJob]);
    mocks.runtime.stopManyResult.mockResolvedValue({
      jobs: [],
      text: unsafe,
      truncated: false,
      omittedCount: 0,
    });
    mocks.runtime.resolve.mockReturnValue([unsafeJob]);
    mocks.runtime.tail.mockReturnValue({ content: unsafe, bytes: unsafe.length, truncated: false });

    await commands.get("background-tasks")!.handler("", ctx);
    await commands.get("background-stop")!.handler("bg_1", ctx);
    await commands.get("background-tail")!.handler("bg_1", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(3);
    for (const [message] of ctx.ui.notify.mock.calls) {
      expect(
        [...message].every((character) => {
          const code = character.charCodeAt(0);
          return code === 0x0a || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f));
        }),
      ).toBe(true);
    }
  });

  it("renders completed, warning, and failed statuses with semantic icons and colors", () => {
    const { tools } = harness();
    const fg = vi.fn((color: string, text: string) => `[${color}]${text}`);
    const render = tools.get("background_status")!.renderResult as (...args: unknown[]) => unknown;
    const base = {
      jobId: "bg_1",
      kind: "background_bash",
      description: undefined,
      cwd: "/tmp",
      createdAt: "now",
      durationMs: 0,
      outputBytes: 0,
      deliveryState: "pending",
    };
    for (const [status, color, icon] of [
      ["completed", "success", "✓"],
      ["cancelled", "warning", "◆"],
      ["failed", "error", "✗"],
    ] as const) {
      fg.mockClear();
      render(
        { details: { jobs: [{ ...base, status }], text: "", truncated: false, omittedCount: 0 } },
        { expanded: false },
        { fg },
      );
      expect(fg).toHaveBeenCalledWith(color, expect.stringContaining(icon));
    }
  });

  it("status inspection is non-consuming", async () => {
    const { handlers, tools } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
    await tools
      .get("background_status")!
      .execute("call", { jobId: "bg_1", tailLines: 20 }, undefined, undefined, ctx);

    expect(mocks.runtime.resolve).toHaveBeenCalledWith(["bg_1"]);
    expect(mocks.runtime.waitResult).not.toHaveBeenCalled();
    expect(mocks.runtime.stopManyResult).not.toHaveBeenCalled();
    expect(mocks.job.deliveryState).toBe("pending");
  });

  it("contains an unexpected terminal-timer serialization rejection", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = harness();
      const ctx = context();
      await handlers.get("session_start")?.({} as never, ctx as never);
      mocks.runtime.flushCompletionDeliveries.mockRejectedValueOnce(
        new Error("unexpected serialization failure"),
      );
      const options = mocks.constructorCalls.at(-1)?.options as { onTerminal: () => void };

      options.onTerminal();
      await vi.advanceTimersByTimeAsync(30);
      expect(mocks.runtime.flushCompletionDeliveries).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeated and reentrant agent_settled callbacks do not duplicate accepted sends", async () => {
    const { handlers, pi } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
    let accepted = false;
    mocks.runtime.flushCompletionDeliveries.mockImplementation(async (send) => {
      if (accepted) return false;
      accepted = true;
      send({
        jobs: [],
        text: '{"jobs":[],"truncated":false,"omittedCount":0}',
        truncated: false,
        omittedCount: 0,
      });
      await handlers.get("agent_settled")?.({} as never, ctx as never);
      return true;
    });

    await handlers.get("agent_settled")?.({} as never, ctx as never);
    await handlers.get("agent_settled")?.({} as never, ctx as never);
    expect(pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["quit", "reload", "new", "resume", "fork"])(
    "handles %s shutdown, clears TUI state, and disables the old runtime",
    async (reason) => {
      const { handlers } = harness();
      const ctx = context("tui");
      await handlers.get("session_start")?.({} as never, ctx as never);
      await handlers.get("session_shutdown")?.({ reason } as never, ctx as never);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("background-processes", undefined);
      expect(mocks.runtime.shutdown).toHaveBeenCalledOnce();

      await handlers.get("agent_settled")?.({} as never, ctx as never);
      expect(mocks.runtime.flushCompletionDeliveries).not.toHaveBeenCalled();
      expect(mocks.runtime.flushMonitorDeliveries).not.toHaveBeenCalled();
    },
  );
});
