import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "../src/types.ts";
import { runCostDetails } from "../src/utils.ts";
import {
  AgentflowDashboard,
  availableWidgetRows,
  registerDashboard,
  renderRunDetail,
  renderRunList,
} from "../src/ui/dashboard.ts";

const usage = (total = 1_250, cost = 0.12) => ({
  input: total - 250,
  output: 250,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost,
});

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-visible-only-wide",
    kind: "workflow",
    name: "Review",
    semanticRole: "review",
    status: "running",
    createdAt: new Date(0).toISOString(),
    phases: ["inspect"],
    currentPhase: "inspect",
    logs: [],
    nodes: [
      {
        id: "node-1",
        label: "Inspect implementation",
        phase: "inspect",
        prompt: "Preserve this important initial prompt when the terminal is narrow",
        cwd: "/repo",
        status: "completed",
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(4_000).toISOString(),
        resultPreview: "The implementation is sound.",
        sessionFile: "/tmp/session.jsonl",
        tools: 1,
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            status: "completed",
            startedAt: new Date(2_000).toISOString(),
            completedAt: new Date(3_000).toISOString(),
            argumentSummary: "src/main.ts",
            argumentsPreview: '{"path":"src/main.ts"}',
            resultPreview: "source text",
          },
        ],
        usage: usage(),
      },
      {
        id: "node-2",
        label: "Report",
        prompt: "Report findings",
        cwd: "/repo",
        status: "running",
        startedAt: new Date(4_000).toISOString(),
        tools: 0,
        toolCalls: [],
        usage: usage(750, 0.03),
      },
    ],
    artifactDir: "/tmp/artifacts/run",
    ...overrides,
  };
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function keybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "u",
    "tui.select.down": "d",
    "tui.select.confirm": "c",
    "tui.select.cancel": "b",
    "tui.select.pageUp": "p",
    "tui.select.pageDown": "n",
  });
}

describe("Agentflow dashboard formatting", () => {
  it("preserves prompt and core usage instead of IDs in narrow rows", () => {
    const lines = renderRunList([snapshot()], "run-visible-only-wide", 70, 10_000);
    expect(lines.join("\n")).toContain("Preserve this important initial prompt");
    expect(lines.join("\n")).not.toContain("run-visible-only-wide");
    expect(lines.join("\n")).toContain("10.0s · 2.0k tokens · $0.150");
  });

  it("does not render or publish an authoritative zero when terminal cost is unavailable", () => {
    const value = snapshot({ status: "failed" });
    value.nodes[0]!.usage.costKnown = false;
    value.nodes[0]!.usage.cost = 0;
    value.nodes[1]!.usage.cost = 0;

    expect(renderRunList([value], undefined, 100, 10_000).join("\n")).toContain("cost unavailable");
    expect(runCostDetails(value)).toBeUndefined();
  });

  it("adds identity and workflow progress when width permits", () => {
    const lines = renderRunList([snapshot()], "run-visible-only-wide", 120, 10_000);
    expect(lines.join("\n")).toContain("Review · run-visible-only-wide");
    expect(lines.join("\n")).toContain("1/2 completed");
  });

  it("labels a workflow by its run kind instead of its first delegate node", () => {
    const value = snapshot({
      semanticRole: undefined,
      nodes: snapshot().nodes.map((node) => ({ ...node, semanticRole: "delegate" })),
    });
    const text = renderRunList([value], value.runId, 120, 10_000).join("\n");

    expect(text).toContain("◆ running · workflow");
    expect(text).not.toContain("◆ running · delegate");
  });

  it("renders detail hierarchy with expanded tool calls and operational references", () => {
    const lines = renderRunDetail(
      snapshot({ error: "run error" }),
      120,
      plainTheme as never,
      {
        runId: "run-visible-only-wide",
        status: "failed",
        result: "full result",
        snapshot: snapshot(),
      },
      10_000,
    );
    const text = lines.join("\n");
    const headings = [
      "Prompt",
      "Workflow",
      "Nodes",
      "Output / result",
      "Errors",
      "Sessions",
      "Artifacts",
    ];
    const headingIndexes = headings.map((heading) => lines.indexOf(heading));
    expect(headingIndexes).toEqual(headingIndexes.slice().sort((a, b) => a - b));
    expect(text).toContain('args: {"path":"src/main.ts"}');
    expect(text).toContain("result: source text");
    expect(text).toContain("full result");
    expect(text).toContain("run error");
    expect(text).toContain("/tmp/session.jsonl");
    expect(text).toContain("/tmp/artifacts/run");
  });

  it("does not repeat the run line as a node line for a single-node run", () => {
    const single = snapshot({ kind: "agent", nodes: [snapshot().nodes[0]!] });
    const lines = renderRunDetail(single, 120, plainTheme as never, undefined, 10_000);
    const text = lines.join("\n");

    expect(lines).toContain("Tool calls");
    expect(lines).not.toContain("Nodes");
    // The heading is the only place the run states its status, elapsed and usage.
    expect(text.match(/1\.3k tokens/g)).toHaveLength(1);
    expect(text).toContain('args: {"path":"src/main.ts"}');
    // The single node's result is the run's result.
    expect(text).toContain("The implementation is sound.");
  });

  it("uses the subagent tool-row colors and lets the status icon stand alone", () => {
    const taggedTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const text = renderRunDetail(snapshot(), 240, taggedTheme as never, undefined, 10_000).join(
      "\n",
    );

    expect(text).toContain("<success>✓</success> <toolTitle>read      </toolTitle>");
    expect(text).toContain('<muted>args:</muted> <dim>{"path":"src/main.ts"}</dim>');
    expect(text).not.toContain("completed read");
  });
});

describe("Agentflow dashboard command blocked state", () => {
  function commandHarness(engineOverrides: Record<string, unknown> = {}, order?: string[]) {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const events: Array<{ event: string; data: unknown }> = [];
    const run = snapshot();
    const engine = {
      listAll: vi.fn(() => [run]),
      getResult: vi.fn(() => undefined),
      getSnapshot: vi.fn(() => run),
      getSessionScope: vi.fn(() => undefined),
      subscribe: vi.fn(() => vi.fn()),
      cancel: vi.fn(async () => undefined),
      ...engineOverrides,
    };
    const pi = {
      events: {
        emit: vi.fn((event: string, data: unknown) => {
          events.push({ event, data });
          order?.push((data as { active: boolean }).active ? "active" : "inactive");
        }),
      },
      registerCommand: vi.fn(
        (_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          handler = command.handler;
        },
      ),
    };
    registerDashboard(pi as never, engine as never);
    return { events, handler: handler!, run };
  }

  function context(mode: string, custom: unknown, confirm = vi.fn(async () => false)) {
    return {
      mode,
      ui: {
        custom,
        confirm,
        notify: vi.fn(),
      },
    };
  }

  it("does not block for user-initiated browsing or cancellation confirmation", async () => {
    const order: string[] = [];
    const { events, handler } = commandHarness({}, order);
    const confirm = vi.fn(async () => {
      order.push("confirm");
      return false;
    });
    const custom = vi.fn(
      async (
        factory: (
          tui: { requestRender(): void },
          theme: typeof plainTheme,
          bindings: KeybindingsManager,
          done: (value: void) => void,
        ) => AgentflowDashboard,
      ) => {
        order.push("custom");
        await new Promise<void>((resolve) => {
          const dashboard = factory({ requestRender: vi.fn() }, plainTheme, keybindings(), resolve);
          dashboard.handleInput("x");
          queueMicrotask(() => dashboard.handleInput("b"));
        });
      },
    );

    await handler("", context("tui", custom, confirm));

    expect(order).toEqual(["custom", "confirm"]);
    expect(events).toEqual([]);
  });

  it("does not block when the custom dashboard rejects", async () => {
    const { events, handler } = commandHarness();
    const failure = new Error("dashboard failed");
    const custom = vi.fn(async () => {
      throw failure;
    });

    await expect(handler("", context("tui", custom))).rejects.toBe(failure);
    expect(events).toEqual([]);
  });

  it.each([
    ["RPC", "", "rpc", {}],
    ["no runs", "", "tui", { listAll: vi.fn(() => []) }],
    ["unknown run", "missing", "tui", {}],
    [
      "runtime error",
      "",
      "tui",
      {
        listAll: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
      },
    ],
  ])("emits no blocked events for %s", async (_name, args, mode, overrides) => {
    const { events, handler } = commandHarness(overrides);
    const custom = vi.fn();

    await handler(args, context(mode, custom));

    expect(events).toEqual([]);
    expect(custom).not.toHaveBeenCalled();
  });

  it("sizes the open dashboard to the terminal minus the footer", async () => {
    const { handler } = commandHarness();
    const editorContainer = { children: [] as never[], render: () => [], invalidate() {} };
    const footer = { render: () => ["status"], invalidate() {} };
    const tui = {
      requestRender: vi.fn(),
      children: [editorContainer, footer],
      terminal: { rows: 40, columns: 100 },
    };
    const custom = vi.fn(
      async (
        factory: (
          tui: unknown,
          theme: unknown,
          bindings: unknown,
          done: (value: void) => void,
        ) => AgentflowDashboard,
      ) => {
        await new Promise<void>((resolve) => {
          const dashboard = factory(tui, plainTheme, keybindings(), resolve);
          editorContainer.children.push(dashboard as never);
          const lines = dashboard.render(100);
          expect(lines).toHaveLength(39);
          expect(lines[0]).toContain("╭─ Agentflow · Review");
          expect(lines.at(-1)).toContain("╰─");
          resolve();
        });
      },
    );

    await handler("run-visible-only-wide", context("tui", custom));
    expect(custom).toHaveBeenCalledOnce();
  });
});

describe("Agentflow dashboard viewport accounting", () => {
  const fakeComponent = (lines: string[] = []) => ({
    render: () => lines,
    invalidate() {},
  });

  it("caps the widget to the terminal minus the rows rendered below its host", () => {
    const editorContainer = { children: [] as never[], render: () => [], invalidate() {} };
    const footer = fakeComponent(["status", "model stats"]);
    const host = {
      children: [editorContainer, { children: [], render: () => [], invalidate() {} }, footer],
      terminal: { rows: 24, columns: 100 },
    };
    const widget = fakeComponent();
    editorContainer.children.push(widget as never);

    expect(availableWidgetRows(host as never, widget as never)).toBe(22);
  });

  it("counts rows after a directly hosted widget and falls back when not found", () => {
    const footer = fakeComponent(["status"]);
    const host = { children: [fakeComponent(), footer], terminal: { rows: 24, columns: 100 } };
    const direct = fakeComponent();
    host.children.unshift(direct);

    expect(availableWidgetRows(host as never, direct as never)).toBe(23);
    expect(availableWidgetRows(host as never, fakeComponent() as never)).toBe(24);
  });
});

describe("Agentflow dashboard interaction", () => {
  it("uses j/k navigation, injected action bindings, and retains selection by run ID", () => {
    const close = vi.fn();
    const cancel = vi.fn();
    const rerender = vi.fn();
    const first = snapshot({ runId: "first", name: "First" });
    const second = snapshot({ runId: "second", name: "Second" });
    const dashboard = new AgentflowDashboard([first, second], plainTheme as never, keybindings(), {
      onClose: close,
      onCancel: cancel,
      requestRender: rerender,
    });

    dashboard.handleInput("d");
    expect(dashboard.render(120).join("\n")).toContain("> ◆ running · review · First");
    dashboard.handleInput("j");
    const list = dashboard.render(120);
    expect(list.join("\n")).toContain("> ◆ running · review · Second");
    expect(list[0]).toContain("╭─ Agentflow runs · 2");
    expect(list.at(-1)).toContain("j/k navigate");
    expect(list.every((line) => visibleWidth(line) === 120)).toBe(true);
    dashboard.replaceSnapshot({ ...first, status: "completed" });
    expect(dashboard.render(120).join("\n")).toContain("> ◆ running · review · Second");

    dashboard.handleInput("c");
    const detailLines = dashboard.render(120);
    const detail = detailLines.join("\n");
    expect(detailLines[0]).toContain("╭─ Agentflow · Second");
    expect(detailLines.at(-1)).toContain("╰─");
    expect(detailLines.every((line) => visibleWidth(line) === 120)).toBe(true);
    expect(detail).toContain("Agentflow · Second");
    expect(detail).not.toMatch(/steer|refresh|takeover/i);
    expect(detail).toContain("j/k scroll");
    expect(detail).toContain("b back");

    dashboard.handleInput("x");
    expect(cancel).toHaveBeenCalledWith("second");
    dashboard.handleInput("b");
    dashboard.handleInput("b");
    expect(close).toHaveBeenCalledOnce();
  });

  it("scrolls detail with configured line/page bindings and g/G in a stable viewport", () => {
    const long = Array.from({ length: 24 }, (_, index) => `output line ${index}`).join("\n");
    const run = snapshot({ resultPreview: long });
    const dashboard = new AgentflowDashboard([run], plainTheme as never, keybindings(), {
      initialRunId: run.runId,
      onClose: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    const initial = dashboard.render(100);
    dashboard.handleInput("j");
    const down = dashboard.render(100);
    expect(down).toHaveLength(initial.length);
    expect(down[1]).not.toBe(initial[1]);

    dashboard.handleInput("n");
    const paged = dashboard.render(100);
    expect(paged).toHaveLength(initial.length);
    expect(paged.join("\n")).toContain("Artifacts");

    dashboard.handleInput("g");
    expect(dashboard.render(100)[1]).toBe(initial[1]);
    dashboard.handleInput("G");
    expect(dashboard.render(100).join("\n")).toContain("Artifacts");
    dashboard.handleInput("p");
    expect(dashboard.render(100).join("\n")).toContain("Prompt");
  });

  it("caps the widget at the viewport and scrolls a long run list with j/k, pages, and g/G", () => {
    const runs = Array.from({ length: 20 }, (_, index) =>
      snapshot({ runId: `run-${index}`, name: `Run ${index}` }),
    );
    const dashboard = new AgentflowDashboard(runs, plainTheme as never, keybindings(), {
      onClose: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
      viewportHeight: () => 14,
    });

    const initial = dashboard.render(120);
    expect(initial).toHaveLength(14);
    expect(initial.join("\n")).toContain("> ◆ running · review · Run 0");

    // j moves inside the window without scrolling until the selection exits it.
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    let list = dashboard.render(120);
    expect(list.join("\n")).toContain("Run 3");
    expect(list.join("\n")).toContain("Run 0");

    dashboard.handleInput("j");
    list = dashboard.render(120);
    expect(list.join("\n")).toContain("> ◆ running · review · Run 4");
    expect(list.join("\n")).not.toContain("Run 0");
    expect(list).toHaveLength(14);

    // k scrolls back up.
    dashboard.handleInput("k");
    expect(dashboard.render(120).join("\n")).toContain("> ◆ running · review · Run 3");

    // Page down jumps by the visible window.
    dashboard.handleInput("n");
    list = dashboard.render(120);
    expect(list.join("\n")).toContain("> ◆ running · review · Run 7");
    expect(list.join("\n")).not.toContain("Run 3");

    // g/G jump to the ends of the list.
    dashboard.handleInput("g");
    expect(dashboard.render(120).join("\n")).toContain("> ◆ running · review · Run 0");
    dashboard.handleInput("G");
    list = dashboard.render(120);
    expect(list.join("\n")).toContain("> ◆ running · review · Run 19");
    expect(list.join("\n")).toContain("Run 16");
    expect(list.join("\n")).not.toContain("Run 15");
  });

  it("caps the detail viewport to the terminal height", () => {
    const run = snapshot({ resultPreview: "output line\n".repeat(60).trim() });
    const dashboard = new AgentflowDashboard([run], plainTheme as never, keybindings(), {
      initialRunId: run.runId,
      onClose: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
      viewportHeight: () => 12,
    });

    const lines = dashboard.render(100);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toContain("╭─");
    expect(lines.at(-1)).toContain("╰─");

    for (let step = 0; step < 60; step++) dashboard.handleInput("j");
    expect(dashboard.render(100).join("\n")).toContain("Artifacts");
  });

  it("scopes the list to the current session and toggles to all runs with provenance", () => {
    const current = snapshot({ runId: "current-run", name: "Current", sessionId: "sess-a-123" });
    const foreign = snapshot({ runId: "foreign-run", name: "Foreign", sessionId: "sess-b-456" });
    const legacy = snapshot({ runId: "legacy-run", name: "Legacy" });
    const dashboard = new AgentflowDashboard(
      [current, foreign, legacy],
      plainTheme as never,
      keybindings(),
      {
        onClose: vi.fn(),
        onCancel: vi.fn(),
        requestRender: vi.fn(),
        sessionScope: "sess-a-123",
      },
    );

    let list = dashboard.render(120).join("\n");
    expect(list).toContain("╭─ Agentflow runs · 1");
    expect(list).toContain("Current");
    expect(list).not.toContain("Foreign");
    expect(list).not.toContain("Legacy");
    expect(list).toContain("a all");

    dashboard.handleInput("a");
    list = dashboard.render(120).join("\n");
    expect(list).toContain("╭─ Agentflow runs (all) · 3");
    expect(list).toContain("Current · this session");
    expect(list).toContain("Foreign · sess-b-4");
    expect(list).toContain("Legacy · legacy");
    expect(list).toContain("a session");

    dashboard.handleInput("a");
    list = dashboard.render(120).join("\n");
    expect(list).toContain("╭─ Agentflow runs · 1");
    expect(list).toContain("Current");
    expect(list).not.toContain("Foreign");
    expect(list).not.toContain("Legacy");
  });

  it("shows session provenance in the detail view", () => {
    const scoped = renderRunDetail(
      snapshot({ sessionId: "session-abc" }),
      120,
      plainTheme as never,
      undefined,
      10_000,
    ).join("\n");
    expect(scoped).toContain("Session");
    expect(scoped).toContain("session-abc");

    const legacy = renderRunDetail(snapshot(), 120, plainTheme as never, undefined, 10_000).join(
      "\n",
    );
    expect(legacy).toContain("(legacy run without session scope)");
  });

  it("coalesces live snapshots and disposes subscription and timers idempotently", () => {
    vi.useFakeTimers();
    try {
      let listener: ((value: RunSnapshot[]) => void) | undefined;
      const unsubscribe = vi.fn();
      const rerender = vi.fn();
      const run = snapshot();
      const dashboard = new AgentflowDashboard([run], plainTheme as never, keybindings(), {
        onClose: vi.fn(),
        onCancel: vi.fn(),
        requestRender: rerender,
        subscribe: (next) => {
          listener = next;
          return unsubscribe;
        },
      });

      listener?.([{ ...run, status: "running" }]);
      listener?.([{ ...run, status: "completed", completedAt: new Date(2_000).toISOString() }]);
      vi.advanceTimersByTime(49);
      expect(rerender).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(rerender).toHaveBeenCalledOnce();
      expect(dashboard.render(120).join("\n")).toContain("✓ completed");

      vi.advanceTimersByTime(950);
      expect(rerender).toHaveBeenCalledTimes(2);
      dashboard.dispose();
      dashboard.dispose();
      listener?.([{ ...run, status: "failed" }]);
      vi.advanceTimersByTime(2_000);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(rerender).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
