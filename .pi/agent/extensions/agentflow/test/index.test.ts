import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const engine = {
    snapshots: [] as unknown[],
    recover: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => engine.snapshots),
    flushBackgroundDeliveries: vi.fn(),
  };
  let emit: ((name: string, payload: unknown) => void) | undefined;
  let deliver: ((message: string, result: { snapshot: unknown }) => unknown) | undefined;
  class RunEngine {
    constructor(
      onEvent: (name: string, payload: unknown) => void,
      _activeTools: unknown,
      onDelivery: (message: string, result: { snapshot: unknown }) => unknown,
    ) {
      emit = onEvent;
      deliver = onDelivery;
      return engine;
    }
  }
  return { engine, RunEngine, emit: () => emit, deliver: () => deliver };
});
vi.mock("../src/runtime/run-engine.ts", () => ({ RunEngine: mocks.RunEngine }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal()),
  keyHint: () => "alt+e to expand",
}));

import agentflowExtension from "../src/index.ts";

function load(raw: boolean): { beforeStart: string[]; afterStart: string[]; commands: string[] } {
  const tools: string[] = [];
  const commands: string[] = [];
  const flags = new Map<string, unknown>();
  let start: (() => void) | undefined;
  const pi = {
    registerFlag(name: string, options: { default?: unknown }) {
      flags.set(name, name === "agentflow-raw" ? raw : options.default);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand: vi.fn((name: string) => commands.push(name)),
    registerMessageRenderer: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "session_start" && !start) start = handler;
    }),
    getActiveTools: () => [],
    getThinkingLevel: () => undefined,
    sendMessage: vi.fn(),
    events: { emit: vi.fn() },
  };
  agentflowExtension(pi as never);
  const beforeStart = [...tools];
  start?.();
  return { beforeStart, afterStart: tools, commands };
}

describe("extension tool registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engine.snapshots = [];
  });
  it("hides raw launch tools by default", () => {
    expect(load(false).afterStart).toEqual([
      "agentflow_finder",
      "agentflow_oracle",
      "agentflow_librarian",
      "agentflow_look_at",
      "agentflow_delegate",
      "agentflow_review",
      "agentflow_status",
      "agentflow_wait",
      "agentflow_cancel",
      "agentflow_steer",
    ]);
  });

  it("keeps status and steering model-only while exposing the unified dashboard command", () => {
    expect(load(false).commands).toEqual(["agentflow"]);
  });

  it("registers raw launch tools at session start only behind --agentflow-raw", () => {
    const tools = load(true);
    expect(tools.beforeStart).not.toContain("agentflow_agent");
    expect(tools.beforeStart).not.toContain("agentflow_workflow");
    expect(tools.afterStart).toEqual([
      "agentflow_finder",
      "agentflow_oracle",
      "agentflow_librarian",
      "agentflow_look_at",
      "agentflow_delegate",
      "agentflow_review",
      "agentflow_status",
      "agentflow_wait",
      "agentflow_cancel",
      "agentflow_steer",
      "agentflow_agent",
      "agentflow_workflow",
    ]);
  });

  it("retains recovered snapshots in asynchronous result cards and reuses semantic rendering", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const renderers = new Map<string, (...args: any[]) => { render(width: number): string[] }>();
    const sendMessage = vi.fn();
    const snapshot = {
      runId: "af_recovered",
      kind: "agent",
      name: "finder",
      semanticRole: "finder",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      phases: [],
      logs: [],
      artifactDir: "/artifacts/af_recovered",
      nodes: [
        {
          id: "finder_1",
          label: "finder",
          semanticRole: "finder",
          prompt: "Inspect the recovered authentication boundary",
          cwd: "/work/project",
          status: "completed",
          queuedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          resultPreview: '{"findings":[{"title":"issue"}]}',
          tools: 1,
          toolCalls: [
            {
              id: "read_1",
              name: "read",
              status: "completed",
              startedAt: "2026-01-01T00:00:00.000Z",
              argumentSummary: "src/auth.ts",
            },
          ],
          usage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            total: 120,
            cost: 0.01,
          },
        },
      ],
    };
    mocks.engine.snapshots = [snapshot];
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => false),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn((type: string, renderer: (...args: any[]) => any) =>
        renderers.set(type, renderer),
      ),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }),
      getActiveTools: () => [],
      getAllTools: () => [],
      getThinkingLevel: () => undefined,
      sendMessage,
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
    };
    agentflowExtension(pi as never);
    const ctx = { ui: { setStatus: vi.fn() }, isIdle: () => true };
    for (const handler of handlers.get("session_start") ?? [])
      await handler({} as never, ctx as never);

    await mocks.deliver()?.("finder completed", { snapshot });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "agentflow-result",
        details: expect.objectContaining({ snapshot }),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );

    const renderer = renderers.get("agentflow-result")!;
    const message = sendMessage.mock.calls[0]![0];
    const theme = {
      bold: (text: string) => text,
      fg: (_role: string, text: string) => text,
    };
    const collapsed = renderer(message, { expanded: false }, theme).render(200).join("\n");
    expect(collapsed).toContain("1 findings · 1 tools");
    expect(collapsed).toContain("expand");
    const expanded = renderer(message, { expanded: true }, theme).render(200).join("\n");
    const markers = [
      "Prompt",
      "Inspect the recovered authentication boundary",
      "2s · 120 tokens · $0.0100",
      "Tool calls",
      "read",
      "Output",
      "Artifacts: /artifacts/af_recovered",
    ].map((value) => expanded.indexOf(value));
    expect(markers.every((index) => index >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
  });

  it("publishes aggregate task progress only, clears on inactivity and every shutdown", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const setStatus = vi.fn();
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => false),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }),
      getActiveTools: () => [],
      getAllTools: () => [],
      getThinkingLevel: () => undefined,
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
    };
    const ctx = { ui: { setStatus }, isIdle: () => true };
    agentflowExtension(pi as never);
    mocks.engine.snapshots = [
      {
        runId: "secret-run-id",
        kind: "agent",
        name: "private prompt",
        status: "running",
        nodes: [{ status: "completed" }, { status: "running" }],
      },
      {
        runId: "other-id",
        kind: "workflow",
        status: "queued",
        nodes: [{ status: "completed" }, { status: "queued" }, { status: "queued" }],
      },
    ];
    for (const handler of handlers.get("session_start") ?? [])
      await handler({} as never, ctx as never);

    expect(setStatus).toHaveBeenLastCalledWith("agentflow", "◆ /agentflow 2 · 2/5 tasks");
    const status = setStatus.mock.calls.at(-1)?.[1] as string;
    expect(status).not.toMatch(/secret|prompt|token|cost|elapsed|other-id/);

    mocks.engine.snapshots = [];
    mocks.emit()?.("agentflow:run.updated", {});
    expect(setStatus).toHaveBeenLastCalledWith("agentflow", undefined);

    setStatus.mockClear();
    for (const handler of handlers.get("session_shutdown") ?? [])
      await handler({ reason: "reload" } as never, ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith("agentflow", undefined);
    expect(mocks.engine.shutdown).toHaveBeenCalledOnce();
  });
});
