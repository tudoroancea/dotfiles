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

import { stopLiveRedraw } from "../../lib/tools/live.ts";
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
    events: { on: vi.fn(), emit: vi.fn() },
  };
  backgroundProcessesExtension(pi as never);
  return { pi, handlers, tools, commands, renderers };
}

/** The per-call render context Pi's tool-execution shell passes to both renderer slots. */
function slotContext(args: unknown, overrides: Record<string, unknown> = {}) {
  return {
    args,
    toolCallId: "call-1",
    cwd: "/work/project",
    expanded: false,
    isError: false,
    isPartial: false,
    executionStarted: true,
    argsComplete: true,
    showImages: false,
    lastComponent: undefined,
    state: {},
    invalidate: () => {},
    ...overrides,
  };
}

/** Render one tool's result body over a `SerializedJobs` payload. */
function renderBody(
  name: string,
  details: unknown,
  options: { expanded: boolean; isError?: boolean },
  theme: unknown,
): string[] {
  const { tools } = harness();
  const render = tools.get(name)!.renderResult as (...values: unknown[]) => {
    render(width: number): string[];
  };
  return render(
    { details, content: [{ type: "text", text: "" }] },
    { expanded: options.expanded, isPartial: false },
    theme,
    slotContext({}, { expanded: options.expanded, isError: options.isError ?? false }),
  ).render(200);
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
    expect(runGuidance).toContain("normally finish the turn");
    expect(runGuidance).toContain("automatically trigger a follow-up turn");
    expect(runGuidance).toContain("same-turn continuation is specifically important");
    expect(runGuidance).toContain("not by mutability or duration");
    const waitGuidance = tools.get("background_wait")!.promptGuidelines!.join(" ");
    expect(waitGuidance).toContain("Prefer ending the turn");
    expect(waitGuidance).toContain("short and bounded");
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

  it("unwinds runtime ownership when session initialization fails", async () => {
    const { handlers, tools } = harness();
    const ctx = context("tui");
    mocks.runtime.initialize.mockRejectedValueOnce(new Error("initialize failed"));

    await expect(handlers.get("session_start")?.({} as never, ctx as never)).rejects.toThrow(
      "initialize failed",
    );

    expect(mocks.runtime.shutdown).toHaveBeenCalledOnce();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("background-processes", undefined);
    await expect(
      tools.get("background_status")!.execute("call", {}, undefined, undefined, ctx),
    ).rejects.toThrow("not initialized");
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

  it("validates event stream mode before allocation and applies timeout semantics", async () => {
    const { handlers, tools } = harness();
    const ctx = context();
    await handlers.get("session_start")?.({} as never, ctx as never);
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
    const { pi, handlers, commands } = harness();
    const ctx = context("tui");
    mocks.runtime.list.mockReturnValue([mocks.job]);
    await handlers.get("session_start")?.({} as never, ctx as never);

    await commands.get("background-tasks")!.handler("", ctx);

    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalled();
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
      bg: (_color: string, value: string) => value,
    };
    const isSafe = (value: string) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code === 0x0a || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f));
      });

    const renderCall = (name: string, args: unknown) =>
      (tools.get(name)!.renderCall as (...values: unknown[]) => unknown)(
        args,
        theme,
        slotContext(args),
      );
    renderCall("background_run", { command: unsafe });
    renderCall("background_run", { command: "ignored", description: unsafe });
    renderCall("background_event_stream", { command: "ignored", description: unsafe });
    renderCall("background_status", { jobId: unsafe });
    renderCall("background_wait", { jobIds: [unsafe, unsafe] });
    renderCall("background_stop", { jobIds: [unsafe, unsafe] });
    expect(themedValues.every(isSafe)).toBe(true);

    const payload = {
      jobs: [{ jobId: unsafe, status: "completed", error: unsafe, tail: unsafe }],
      text: unsafe,
      truncated: false,
      omittedCount: 0,
    };
    renderBody("background_status", payload, { expanded: true }, theme);
    expect(themedValues.every(isSafe)).toBe(true);

    const renderMessage = renderers.get("background-process-completion") as (
      ...args: unknown[]
    ) => { render(width: number): string[] };
    const expanded = renderMessage(
      { details: payload, content: unsafe },
      { expanded: true, outputPad: 1 },
      theme,
    );
    expect(expanded.render(200).every(isSafe)).toBe(true);
  });

  it("reports the aggregate job state with a semantic icon and colour while collapsed", () => {
    const fg = vi.fn((color: string, text: string) => `[${color}]${text}`);
    const base = {
      jobId: "bg_1",
      kind: "background_run",
      cwd: "/tmp",
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
      const lines = renderBody(
        "background_status",
        { jobs: [{ ...base, status }], text: "", truncated: false, omittedCount: 0 },
        { expanded: false },
        { fg },
      );
      expect(lines.join("\n")).toContain(`[${color}]${icon} ${status}`);
      expect(lines.join("\n")).toContain("1 job");
    }
  });

  it("reports the worst state of a mixed list and surfaces omitted jobs", () => {
    const theme = { fg: (color: string, text: string) => `[${color}]${text}` };
    const text = renderBody(
      "background_status",
      {
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
      { expanded: false },
      theme,
    ).join("\n");
    expect(text).toContain("[error]✗ failed");
    expect(text).toContain("2 jobs");
    expect(text).toContain("4 jobs omitted (bg_old_1…bg_old_4)");
    expect(text).toContain("Inspect a specific job with background_status.");

    const truncatedOnly = renderBody(
      "background_status",
      {
        jobs: [{ jobId: "bg_ok", status: "completed" }],
        text: "",
        truncated: true,
        omittedCount: 0,
      },
      { expanded: false },
      theme,
    ).join("\n");
    expect(truncatedOnly).toContain("Result payload or output tail truncated");
  });

  it("advances a running job's elapsed time while its card is open", () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z") });
    try {
      const theme = {
        bold: (value: string) => value,
        fg: (_color: string, value: string) => value,
      };
      const { tools } = harness();
      const render = tools.get("background_status")!.renderResult as (...values: unknown[]) => {
        render(width: number): string[];
      };
      const jobs = (status: string) => ({
        jobs: [{ jobId: "bg_1", kind: "background_run", status, cwd: "/tmp", durationMs: 2_000 }],
        text: "",
        truncated: false,
        omittedCount: 0,
      });
      let redraws = 0;
      const ctx = slotContext({}, { expanded: true, invalidate: () => (redraws += 1) });
      const body = (status: string) =>
        render(
          { details: jobs(status), content: [{ type: "text", text: "" }] },
          { expanded: true, isPartial: false },
          theme,
          ctx,
        )
          .render(200)
          .join("\n");

      // `durationMs` was measured when the payload was written, so a running job counts on from
      // there for as long as the row has been shown.
      expect(body("running")).toContain("Elapsed: 2.0s");
      vi.advanceTimersByTime(3_000);
      expect(redraws).toBe(3);
      expect(body("running")).toContain("Elapsed: 5.0s");

      // A settled job reports what the payload measured, and stops asking for redraws.
      expect(body("completed")).toContain("Elapsed: 2.0s");
      vi.advanceTimersByTime(3_000);
      expect(redraws).toBe(3);
    } finally {
      stopLiveRedraw();
      vi.useRealTimers();
    }
  });

  it("keeps a launch header compact and puts the job facts in the expanded body", () => {
    const { tools } = harness();
    const theme = {
      bold: (value: string) => value,
      fg: (_color: string, value: string) => value,
    };
    const args = { command: "nub run test", description: "tests", timeout: 30 };
    const call = (
      tools.get("background_run")!.renderCall as (...values: unknown[]) => {
        render(width: number): string[];
      }
    )(args, theme, slotContext(args, { expanded: false }));
    expect(call.render(200)[0]!.trimEnd()).toBe(
      "background_run · nub run test · tests · 30s timeout",
    );

    const body = renderBody(
      "background_status",
      {
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
      { expanded: true },
      theme,
    ).join("\n");
    const markers = [
      "✓ completed",
      "nub run test",
      "Job: bg_1",
      "Cwd: /work/project",
      "Elapsed: 2.0s",
      "Delivery: sent",
      "Log: /artifacts/output.log",
      "pass",
    ].map((value) => body.indexOf(value));
    expect(markers.every((index) => index >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
  });

  it("renders boxed completion and live-event messages with expand hints and job context", async () => {
    const { handlers, renderers } = harness();
    const ctx = context("tui");
    await handlers.get("session_start")?.({} as never, ctx as never);
    const bg = vi.fn((_color: string, value: string) => value);
    const theme = {
      bold: (value: string) => value,
      fg: (_color: string, value: string) => value,
      bg,
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
    expect(
      renderBody("background_status", payload, { expanded: false }, theme).join("\n"),
    ).toContain("expand");

    const completion = renderers.get("background-process-completion") as (...args: unknown[]) => {
      render(width: number): string[];
    };
    const completionLines = completion(
      { details: payload, content: "" },
      { expanded: false, outputPad: 1 },
      theme,
    ).render(200);
    expect(completionLines.join("\n")).toContain("bg_1 · completed");
    expect(completionLines.join("\n")).toContain("expand");
    expect(completionLines[0]).toBe(" ".repeat(200));
    expect(completionLines.at(-1)).toBe(" ".repeat(200));
    expect(bg).toHaveBeenCalledWith("customMessageBg", expect.any(String));

    mocks.runtime.get.mockReturnValue({
      ...mocks.job,
      command: "nub run watch",
      cwd: "/work/events",
      kind: "background_event_stream",
    } as never);
    const event = renderers.get("background-monitor-event") as (...args: unknown[]) => {
      render(width: number): string[];
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
    const collapsed = event(message, { expanded: false, outputPad: 1 }, theme)
      .render(200)
      .join("\n");
    expect(collapsed).toContain("■ bg_1 · #3 · 4-5");
    expect(collapsed).toContain("expand");

    const expanded = event(message, { expanded: true, outputPad: 1 }, theme).render(200).join("\n");
    const markers = ["■ bg_1", "line one", "nub run watch", "Cwd: /work/events"].map((value) =>
      expanded.indexOf(value),
    );
    expect(markers.every((index) => index >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
  });

  it("does not expose redundant stop or tail slash commands", () => {
    const { commands, tools } = harness();
    expect(commands.has("background-stop")).toBe(false);
    expect(commands.has("background-tail")).toBe(false);
    expect(tools.has("background_stop")).toBe(true);
    expect(tools.has("background_status")).toBe(true);
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
