import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const job = {
    id: "bg_1",
    generation: 1,
    kind: "background_run" as const,
    command: "sleep 1",
    description: undefined as string | undefined,
    cwd: "/tmp",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "running" as const,
    outputBytes: 0,
    outputPath: "/artifacts/bg_1/output.log",
    metadataPath: "/artifacts/bg_1/job.json",
    deliveryState: "pending" as const,
    deliveryError: undefined as string | undefined,
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
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal()),
  keyHint: () => "alt+e to expand",
}));

import backgroundProcessesExtension from "../src/index.ts";

function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<
    string,
    {
      label: string;
      description: string;
      promptSnippet: string;
      promptGuidelines?: string[];
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
        label: string;
        description: string;
        promptSnippet: string;
        promptGuidelines?: string[];
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
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      custom: vi.fn(async () => undefined),
      editor: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      confirm: vi.fn(async () => false),
      setEditorText: vi.fn(),
    },
  };
}

describe("background processes extension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers five strict model tools, only the dashboard command, and both renderers", () => {
    const { pi, tools, commands } = harness();
    expect([...tools.keys()]).toEqual([
      "background_run",
      "background_event_stream",
      "background_status",
      "background_wait",
      "background_stop",
    ]);
    expect(tools.has("background_bash")).toBe(false);
    expect(tools.has("monitor")).toBe(false);
    expect(tools.get("background_run")).toMatchObject({
      label: "Background Run",
      promptSnippet: expect.stringContaining("one completion notification"),
    });
    expect(tools.get("background_event_stream")).toMatchObject({
      label: "Background Event Stream",
      promptSnippet: expect.stringContaining("intermediate event notifications"),
    });
    const runGuidance = tools.get("background_run")!.promptGuidelines!.join(" ");
    expect(runGuidance).toContain("Claude Code Background Bash/Monitor");
    expect(runGuidance).toContain("background_run launches the command itself");
    expect(runGuidance).toContain("may mutate state");
    expect(runGuidance).toContain("not by mutability or duration");
    const streamGuidance = tools.get("background_event_stream")!.promptGuidelines!.join(" ");
    expect(streamGuidance).toContain("Claude Code Background Bash/Monitor");
    expect(streamGuidance).toContain("background_event_stream launches the command itself");
    expect(streamGuidance).toContain("not a read-only observer");
    expect(streamGuidance).toContain("not mutability or duration");
    expect([...commands.keys()]).toEqual(["background-tasks"]);
    expect(tools.has("background_stop")).toBe(true);
    expect(tools.has("background_status")).toBe(true);
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
        .get("background_run")!
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
        .get("background_run")!
        .execute("call", { command: "true", timeout: -1 }, undefined, undefined, ctx),
    ).rejects.toThrow("timeout");
    expect(mocks.runtime.launch).not.toHaveBeenCalled();
  });

  it("clears a provisional status when launch setup fails", async () => {
    const { handlers, tools } = harness();
    const ctx = context("tui");
    await handlers.get("session_start")?.({} as never, ctx as never);
    mocks.runtime.launch.mockRejectedValueOnce(new Error("checkpoint failed"));
    mocks.runtime.list.mockReturnValue([]);

    await expect(
      tools.get("background_run")!.execute("call", { command: "true" }, undefined, undefined, ctx),
    ).rejects.toThrow("checkpoint failed");

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("background-processes", undefined);
  });

  it("validates event stream mode and timeout before allocation and applies timeout semantics", async () => {
    const { handlers, tools } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
    await expect(
      tools
        .get("background_event_stream")!
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
        .get("background_event_stream")!
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
      .get("background_event_stream")!
      .execute("call", { command: "watch", description: "events" }, undefined, undefined, ctx);
    expect(mocks.runtime.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "background_event_stream", timeout: 300 }),
    );
    await tools
      .get("background_event_stream")!
      .execute(
        "call",
        { command: "watch", description: "events", timeout: 10, persistent: true },
        undefined,
        undefined,
        ctx,
      );
    expect(mocks.runtime.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "background_event_stream", timeout: undefined }),
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
        .get("background_run")!
        .execute("call", { command: "true" }, controller.signal, undefined, ctx),
    ).rejects.toThrow("aborted");
    expect(mocks.runtime.launch).not.toHaveBeenCalled();

    const result = (await tools
      .get("background_run")!
      .execute("call", { command: "true" }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(mocks.runtime.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp", command: "true" }),
    );
    expect(mocks.runtime.markLaunchTransferred).toHaveBeenCalledWith("bg_1");
    expect(result.content[0]!.text).toContain("/artifacts/bg_1/output.log");
  });

  it("publishes aggregate active and unresolved-warning status, then clears it", async () => {
    const { handlers } = harness();
    const ctx = context("tui");
    mocks.runtime.list.mockReturnValue([
      mocks.job,
      {
        ...mocks.job,
        id: "bg_2",
        deliveryError: "send failed",
      },
    ]);
    await handlers.get("session_start")?.({} as never, ctx as never);
    const options = mocks.constructorCalls.at(-1)?.options as { onChange: () => void };
    options.onChange();

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "background-processes",
      "■ /background-tasks 2 · warnings 1",
    );
    expect(ctx.ui.setStatus.mock.calls.flat().join(" ")).not.toContain("sleep 1");
    expect("setWidget" in ctx.ui).toBe(false);

    mocks.runtime.list.mockReturnValue([mocks.job]);
    options.onChange();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "background-processes",
      "■ /background-tasks 1",
    );

    mocks.runtime.list.mockReturnValue([]);
    options.onChange();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("background-processes", undefined);
  });

  it("opens an interactive task dashboard in TUI mode instead of notifying raw JSON", async () => {
    const { handlers, commands } = harness();
    const ctx = context("tui");
    mocks.runtime.list.mockReturnValue([mocks.job]);
    await handlers.get("session_start")?.({} as never, ctx as never);

    await commands.get("background-tasks")!.handler("", ctx);

    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
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
    renderCall("background_run", { command: unsafe });
    renderCall("background_run", { command: "ignored", description: unsafe });
    renderCall("background_event_stream", { command: "ignored", description: unsafe });
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

  it("does not expose redundant stop or tail slash commands", () => {
    const { commands, tools } = harness();
    expect(commands.has("background-stop")).toBe(false);
    expect(commands.has("background-tail")).toBe(false);
    expect(tools.has("background_stop")).toBe(true);
    expect(tools.has("background_status")).toBe(true);
  });

  it("renders completed, warning, and failed statuses with semantic icons and colors", () => {
    const { tools } = harness();
    const fg = vi.fn((color: string, text: string) => `[${color}]${text}`);
    const render = tools.get("background_status")!.renderResult as (...args: unknown[]) => unknown;
    const base = {
      jobId: "bg_1",
      kind: "background_run",
      description: undefined,
      cwd: "/tmp",
      createdAt: "now",
      durationMs: 0,
      outputBytes: 0,
      deliveryState: "pending",
    };
    for (const [status, color, icon] of [
      ["completed", "success", "✓"],
      ["cancelled", "muted", "◇"],
      ["failed", "error", "✗"],
    ] as const) {
      fg.mockClear();
      const component = render(
        { details: { jobs: [{ ...base, status }], text: "", truncated: false, omittedCount: 0 } },
        { expanded: false },
        { fg },
      ) as { render(width: number): string[] };
      component.render(200);
      expect(fg).toHaveBeenCalledWith(color, expect.stringContaining(icon));
    }
  });

  it("renders mixed statuses separately and surfaces omitted or truncated results", () => {
    const { tools } = harness();
    const theme = {
      fg: (color: string, text: string) => `[${color}]${text}`,
    };
    const component = (
      tools.get("background_status")!.renderResult as (...args: unknown[]) => {
        render(width: number): string[];
      }
    )(
      {
        details: {
          jobs: [
            { jobId: "bg_ok", status: "completed", durationMs: 1_000 },
            { jobId: "bg_bad", status: "failed", durationMs: 2_000 },
          ],
          text: "",
          truncated: true,
          omittedCount: 4,
          omittedJobs: {
            count: 4,
            firstJobId: "bg_old_1",
            lastJobId: "bg_old_4",
            guidance: "Inspect a specific job with background_status.",
          },
        },
      },
      { expanded: false },
      theme,
    );
    const text = component.render(200).join("\n");
    expect(text).toContain("[success]✓ bg_ok");
    expect(text).toContain("[error]✗ bg_bad");
    expect(text).toContain("4 jobs omitted");
    expect(text).toContain("Result payload truncated");
  });

  it("renders pending launch cwd and command, then persisted details in priority order", () => {
    const { tools } = harness();
    const theme = {
      bold: (value: string) => value,
      fg: (_color: string, value: string) => value,
    };
    const call = (
      tools.get("background_run")!.renderCall as (...args: unknown[]) => { text: string }
    )({ command: "nub run test", description: "tests" }, theme, {
      expanded: true,
      cwd: "/work/project",
    });
    expect(call.text).toContain("/work/project\n$ nub run test");

    const result = (
      tools.get("background_status")!.renderResult as (...args: unknown[]) => { text: string }
    )(
      {
        details: {
          jobs: [
            {
              jobId: "bg_1",
              kind: "background_run",
              status: "completed",
              command: "nub run test",
              cwd: "/work/project",
              durationMs: 2_000,
              outputBytes: 4,
              tail: "pass",
              outputPath: "/artifacts/output.log",
              metadataPath: "/artifacts/job.json",
              deliveryState: "sent",
            },
          ],
          text: "",
          truncated: false,
          omittedCount: 0,
        },
      },
      { expanded: true },
      theme,
    );
    const markers = [
      "/work/project",
      "$ nub run test",
      "✓ completed · 2s",
      "Output",
      "Delivery",
      "Artifacts",
    ].map((value) => result.text.indexOf(value));
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
  });

  it("renders completion and live-event cards with shared hierarchy and configured expand hints", async () => {
    const { handlers, tools, renderers } = harness();
    const ctx = context("tui");
    await handlers.get("session_start")?.({} as never, ctx as never);
    const theme = {
      bold: (value: string) => value,
      fg: (_color: string, value: string) => value,
    };
    const payload = {
      jobs: [
        {
          jobId: "bg_1",
          kind: "background_run",
          status: "completed",
          command: "nub run test",
          cwd: "/work/project",
          durationMs: 2_000,
          outputBytes: 4,
          outputPath: "/artifacts/output.log",
          metadataPath: "/artifacts/job.json",
          deliveryState: "sent",
        },
      ],
      text: "",
      truncated: false,
      omittedCount: 0,
    };
    const toolCollapsed = (
      tools.get("background_status")!.renderResult as (...args: unknown[]) => {
        render(width: number): string[];
      }
    )({ details: payload }, { expanded: false }, theme)
      .render(200)
      .join("\n");
    expect(toolCollapsed).toContain("expand");

    const completion = renderers.get("background-process-completion") as (...args: unknown[]) => {
      text: string;
    };
    expect(
      completion({ details: payload, content: "" }, { expanded: false }, theme).text,
    ).toContain("expand");

    mocks.runtime.get.mockReturnValueOnce({
      ...mocks.job,
      command: "nub run watch",
      cwd: "/work/events",
      kind: "background_event_stream",
    } as never);
    const event = renderers.get("background-monitor-event") as (...args: unknown[]) => {
      text: string;
    };
    const message = {
      details: {
        jobId: "bg_1",
        delivery: 3,
        firstSequence: 4,
        lastSequence: 5,
        lines: ["line one", "line two"],
      },
      content: "line one\nline two",
    };
    const collapsed = event(message, { expanded: false }, theme).text;
    expect(collapsed).toContain("■ bg_1");
    expect(collapsed).toContain("expand");
    const expanded = event(message, { expanded: true }, theme).text;
    const markers = [
      "/work/events",
      "$ nub run watch",
      "running",
      "Output",
      "line one",
      "Delivery",
      "Artifacts",
    ].map((value) => expanded.indexOf(value));
    expect(markers.every((index) => index >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
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
