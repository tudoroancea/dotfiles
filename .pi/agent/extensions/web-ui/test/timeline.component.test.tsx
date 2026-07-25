// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type PersistedEntry, type SnapshotMessage } from "../src/shared/wire.js";
import { Timeline } from "../src/web/components/Timeline.js";
import { ExpansionContext, useExpansionState } from "../src/web/components/expansion.js";
import { ToolCall } from "../src/web/components/ToolCall.js";
import { normalizeTool } from "../src/web/lib/tool-model.js";
import { BrowserSessionStore } from "../src/web/session-store.js";

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly targets = new Set<Element>();
  readonly observe = vi.fn((target: Element) => this.targets.add(target));
  readonly unobserve = vi.fn((target: Element) => this.targets.delete(target));
  readonly disconnect = vi.fn(() => this.targets.clear());
  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }
  triggerHeight(target: Element, height: number): void {
    this.callback(
      [
        {
          target,
          borderBoxSize: [{ inlineSize: 800, blockSize: height }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

let offsetHeight: PropertyDescriptor | undefined;
let authoredStyle: HTMLStyleElement;

beforeEach(() => {
  authoredStyle = document.createElement("style");
  authoredStyle.textContent = ".timeline[data-virtual-list] { position: relative; }";
  document.head.append(authoredStyle);
  ResizeObserverMock.instances = [];
  window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  // jsdom reports every element as zero-height; give measured rows a real size.
  offsetHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 100,
  });
  window.HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  authoredStyle.remove();
  if (offsetHeight)
    Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", offsetHeight);
  else delete (window.HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
  vi.restoreAllMocks();
});

function observerFor(target: Element): ResizeObserverMock {
  const observer = ResizeObserverMock.instances.find((candidate) => candidate.targets.has(target));
  expect(observer, "target should be observed").toBeDefined();
  return observer!;
}

const message = (id: number): PersistedEntry => ({
  id: `entry-${id}`,
  parentId: id === 0 ? null : `entry-${id - 1}`,
  timestamp: `2026-01-01T00:00:${String(id % 60).padStart(2, "0")}.000Z`,
  entryType: "message",
  payload: { message: { role: "user", content: [{ type: "text", text: `message ${id}` }] } },
});

function snapshotWith(
  entries: PersistedEntry[],
  hasOlder: boolean,
  options: {
    historyGeneration?: string;
    revision?: number;
    live?: SnapshotMessage["state"]["live"];
  } = {},
): SnapshotMessage {
  return {
    type: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    generation: "generation-1",
    revision: options.revision ?? 0,
    state: {
      persisted: {
        sessionId: "session-1234",
        leafId: entries.at(-1)?.id ?? null,
        historyGeneration: options.historyGeneration ?? "history-1",
        entries,
        hasOlder,
        ...(hasOlder ? { olderCursor: "cursor-older" } : {}),
      },
      live: options.live ?? { isRunning: false, finalizedMessages: [], tools: [] },
      metadata: { cwd: "/repo", isIdle: true, activeTools: [] },
    },
  };
}

describe("virtual transcript", () => {
  it("keeps the mounted row count bounded for a large session", () => {
    const store = new BrowserSessionStore();
    const entries = Array.from({ length: 400 }, (_, index) => message(index));
    store.apply(snapshotWith(entries, false));

    const rendered = render(
      <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    act(() => observerFor(scroller).triggerHeight(scroller, 400));

    const rows = rendered.container.querySelectorAll<HTMLElement>("[data-row-key]");
    expect(rows.length).toBeGreaterThan(0);
    // A 400-entry session renders only a small measured window, never the whole branch.
    expect(rows.length).toBeLessThan(40);

    const keys = [...rows].map((row) => row.dataset.rowKey!);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key === "intro" || key.startsWith("entry:"))).toBe(true);
    // hasOlder is false, so the first logical row is the session intro, not a loader.
    expect(rendered.container.querySelector(".timeline__earlier")).toBeNull();
    expect(rendered.container.querySelector("[style]")).toBeNull();
  });

  it("cleans its scoped CSSOM rules on unmount", () => {
    const store = new BrowserSessionStore();
    store.apply(
      snapshotWith(
        Array.from({ length: 20 }, (_, index) => message(index)),
        false,
      ),
    );
    const baseline = authoredStyle.sheet!.cssRules.length;
    const rendered = render(
      <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
    );
    const listId =
      rendered.container.querySelector<HTMLElement>("[data-virtual-list]")!.dataset.virtualList!;
    expect([...authoredStyle.sheet!.cssRules].some((rule) => rule.cssText.includes(listId))).toBe(
      true,
    );

    rendered.unmount();
    expect(authoredStyle.sheet!.cssRules).toHaveLength(baseline);
  });

  it("invalidates equal-count persisted and live key maps without token-key churn", () => {
    const store = new BrowserSessionStore();
    store.apply(snapshotWith([message(1), message(2)], false));
    const rendered = render(
      <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    act(() => observerFor(scroller).triggerHeight(scroller, 400));
    expect(rendered.container.querySelector('[data-row-key="entry:entry-1"]')).toBeTruthy();

    act(() => {
      store.apply(
        snapshotWith([message(11), message(12)], false, { historyGeneration: "history-2" }),
      );
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    expect(rendered.container.querySelector('[data-row-key="entry:entry-1"]')).toBeNull();
    expect(rendered.container.querySelector('[data-row-key="entry:entry-11"]')).toBeTruthy();

    const live = (timestamp: number, text: string) => ({
      isRunning: true,
      finalizedMessages: [
        { role: "assistant" as const, timestamp, content: [{ type: "text", text }] },
      ],
      tools: [],
    });
    act(() => {
      store.apply(
        snapshotWith([], false, {
          historyGeneration: "history-3",
          revision: 1,
          live: live(1, "one"),
        }),
      );
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    const firstLiveKey = rendered.container.querySelector<HTMLElement>(
      '[data-row-key^="live-message:"]',
    )!.dataset.rowKey;
    act(() => {
      store.apply(
        snapshotWith([], false, {
          historyGeneration: "history-3",
          revision: 2,
          live: live(2, "two"),
        }),
      );
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    const replacementKey = rendered.container.querySelector<HTMLElement>(
      '[data-row-key^="live-message:"]',
    )!.dataset.rowKey;
    expect(replacementKey).not.toBe(firstLiveKey);
    act(() => {
      store.apply(
        snapshotWith([], false, {
          historyGeneration: "history-3",
          revision: 3,
          live: live(2, "two streamed"),
        }),
      );
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    expect(
      rendered.container.querySelector<HTMLElement>('[data-row-key^="live-message:"]')!.dataset
        .rowKey,
    ).toBe(replacementKey);
  });

  it("creates no virtual blank row for startup-only or hidden persisted entries", () => {
    const store = new BrowserSessionStore();
    const startup: PersistedEntry = {
      id: "startup",
      parentId: null,
      timestamp: "0",
      entryType: "custom",
      payload: { customType: "web-ui-startup" },
    };
    store.apply(snapshotWith([startup], false));
    const rendered = render(
      <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
    );
    expect(rendered.container.querySelectorAll("[data-row-key]")).toHaveLength(0);
    expect(rendered.container.querySelector(".timeline--empty")).toBeTruthy();
  });

  it("keeps a focused stable row mounted and focused across a page prepend", () => {
    const store = new BrowserSessionStore();
    store.apply(snapshotWith(persistedToolEntries("tail"), true));
    const rendered = render(
      <Timeline
        store={store}
        session={store.getSnapshot()}
        onRequestOlder={() => Boolean(store.requestOlderHistory("older-1"))}
      />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    act(() => observerFor(scroller).triggerHeight(scroller, 300));
    const summary = rendered.container.querySelector<HTMLElement>(".tool__head")!;
    act(() => summary.focus());
    expect(document.activeElement).toBe(summary);
    const request = store.requestOlderHistory("older-1")!;
    const older = Array.from({ length: 20 }, (_, index) => message(100 + index));

    act(() => {
      store.apply({
        type: "history_page",
        protocolVersion: PROTOCOL_VERSION,
        commandId: request.commandId,
        generation: request.generation,
        historyGeneration: request.historyGeneration,
        revision: 0,
        entries: older,
        hasOlder: false,
      });
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    const focusedRow = rendered.container.querySelector<HTMLElement>(
      '[data-row-key="tool:tool-1"]',
    );
    expect(focusedRow).toBeTruthy();
    expect(focusedRow?.contains(document.activeElement)).toBe(true);
  });

  it("discards an in-flight prepend anchor when the reader moves", () => {
    const store = new BrowserSessionStore();
    store.apply(snapshotWith([message(10), message(11)], true));
    let request: ReturnType<BrowserSessionStore["requestOlderHistory"]>;
    const rendered = render(
      <Timeline
        store={store}
        session={store.getSnapshot()}
        onRequestOlder={() => Boolean((request = store.requestOlderHistory("move-request")))}
      />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    act(() => observerFor(scroller).triggerHeight(scroller, 300));
    act(() => {
      fireEvent.click(rendered.container.querySelector(".timeline__earlier-button")!);
    });
    act(() => {
      fireEvent.wheel(scroller, { deltaY: 100 });
    });
    vi.mocked(scroller.scrollTo).mockClear();
    act(() => {
      store.apply({
        type: "history_page",
        protocolVersion: PROTOCOL_VERSION,
        commandId: request!.commandId,
        generation: request!.generation,
        historyGeneration: request!.historyGeneration,
        revision: 0,
        entries: [message(9)],
        hasOlder: false,
      });
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("clears a rejected anchor before a later tail append", () => {
    const store = new BrowserSessionStore();
    store.apply(snapshotWith([message(10), message(11)], true));
    let request: ReturnType<BrowserSessionStore["requestOlderHistory"]>;
    const rendered = render(
      <Timeline
        store={store}
        session={store.getSnapshot()}
        onRequestOlder={() => Boolean((request = store.requestOlderHistory("failed-request")))}
      />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    act(() => observerFor(scroller).triggerHeight(scroller, 300));
    act(() => {
      fireEvent.click(rendered.container.querySelector(".timeline__earlier-button")!);
    });
    act(() => {
      store.apply({
        type: "command_response",
        protocolVersion: PROTOCOL_VERSION,
        generation: request!.generation,
        commandId: request!.commandId,
        command: "history_page",
        accepted: false,
        error: "rejected",
      });
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    vi.mocked(scroller.scrollTo).mockClear();
    act(() => {
      store.apply(snapshotWith([message(10), message(11), message(12)], true, { revision: 1 }));
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("shows the keyboard-reachable load control while older history remains", () => {
    const store = new BrowserSessionStore();
    store.apply(snapshotWith([message(998), message(999)], true));
    const requests: number[] = [];

    const rendered = render(
      <Timeline
        store={store}
        session={store.getSnapshot()}
        onRequestOlder={() => {
          requests.push(1);
          return true;
        }}
      />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    act(() => observerFor(scroller).triggerHeight(scroller, 400));

    const loader = rendered.container.querySelector<HTMLButtonElement>(
      ".timeline__earlier-button",
    )!;
    expect(loader).toBeTruthy();
    expect(loader.textContent).toContain("Load earlier messages");
    expect(loader.tagName).toBe("BUTTON");

    act(() => {
      fireEvent.click(loader);
    });
    expect(requests.length).toBe(1);
  });
});

const persistedToolEntries = (prefix: string, callId = "tool-1"): PersistedEntry[] => [
  {
    ...message(1),
    id: `${prefix}-call`,
    payload: {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }],
      },
    },
  },
  {
    ...message(2),
    id: `${prefix}-result`,
    payload: {
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "bash",
        content: [{ type: "text", text: `${prefix} result` }],
      },
    },
  },
];

const bashView = () =>
  normalizeTool({
    toolName: "bash",
    args: { command: "ls -a" },
    result: { content: [{ type: "text", text: "file-a\nfile-b" }] },
    status: "completed",
  });

function ExpansionHarness() {
  const [mounted, setMounted] = useState(true);
  const expansion = useExpansionState();
  return (
    <ExpansionContext.Provider value={expansion}>
      <button
        type="button"
        data-testid="toggle-mount"
        onClick={() => setMounted((value) => !value)}
      >
        toggle
      </button>
      {mounted ? <ToolCall id="tool-1" view={bashView()} /> : <p data-testid="unmounted">gone</p>}
    </ExpansionContext.Provider>
  );
}

describe("externalized tool expansion", () => {
  it("survives a live-to-persisted transition using the canonical tool-call id", () => {
    const store = new BrowserSessionStore();
    store.apply(
      snapshotWith([], false, {
        live: {
          isRunning: true,
          finalizedMessages: [],
          tools: [
            {
              toolCallId: "tool-1",
              toolName: "bash",
              ordinal: 0,
              status: "completed",
              args: { command: "ls" },
              result: { content: [{ type: "text", text: "live result" }] },
              isError: false,
            },
          ],
        },
      }),
    );
    const rendered = render(
      <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    act(() => observerFor(scroller).triggerHeight(scroller, 400));
    const disclosure = () =>
      rendered.container.querySelector<HTMLDetailsElement>(
        '[data-tool-id="tool-1"] details.tool__disclosure',
      );
    act(() => {
      fireEvent.click(rendered.container.querySelector<HTMLElement>(".tool__head")!);
    });
    expect(disclosure()?.open).toBe(true);
    const summary = rendered.container.querySelector<HTMLElement>(".tool__head")!;
    act(() => summary.focus());
    expect(document.activeElement).toBe(summary);
    expect(summary.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey).toBe("tool:tool-1");

    act(() => {
      store.apply(snapshotWith(persistedToolEntries("persisted"), false, { revision: 1 }));
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    expect(rendered.container.querySelectorAll('[data-tool-id="tool-1"]')).toHaveLength(1);
    expect(disclosure()?.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(summary.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey).toBe("tool:tool-1");
  });

  it("resets expansion and follow-bottom state on an equal-size history generation change", () => {
    const store = new BrowserSessionStore();
    store.apply(snapshotWith(persistedToolEntries("old"), false));
    const rendered = render(
      <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
    );
    const scroller = rendered.container.querySelector<HTMLElement>(".timeline-scroll")!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 100 },
    });
    act(() => observerFor(scroller).triggerHeight(scroller, 400));
    act(() => {
      fireEvent.click(rendered.container.querySelector<HTMLElement>(".tool__head")!);
    });
    expect(rendered.container.querySelector<HTMLDetailsElement>(".tool__disclosure")?.open).toBe(
      true,
    );
    act(() => {
      scroller.scrollTop = 300;
      fireEvent.scroll(scroller);
    });
    expect(rendered.container.querySelector(".timeline__jump")).toBeTruthy();

    act(() => {
      store.apply(
        snapshotWith(persistedToolEntries("new"), false, {
          historyGeneration: "history-2",
          revision: 1,
        }),
      );
      rendered.rerender(
        <Timeline store={store} session={store.getSnapshot()} onRequestOlder={() => false} />,
      );
    });
    expect(rendered.container.querySelector(".timeline__jump")).toBeNull();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(rendered.container.querySelector<HTMLDetailsElement>(".tool__disclosure")?.open).toBe(
      false,
    );
  });

  it("survives an unmount and remount because state is keyed by a stable id", () => {
    const rendered = render(<ExpansionHarness />);
    const summary = () => rendered.container.querySelector<HTMLElement>(".tool__head");
    const details = () => rendered.container.querySelector<HTMLDetailsElement>(".tool__disclosure");

    expect(details()?.open).toBe(false);
    act(() => {
      fireEvent.click(summary()!);
    });
    expect(details()?.open).toBe(true);

    act(() => {
      fireEvent.click(rendered.getByTestId("toggle-mount"));
    });
    expect(rendered.container.querySelector(".tool")).toBeNull();
    expect(rendered.getByTestId("unmounted")).toBeTruthy();

    act(() => {
      fireEvent.click(rendered.getByTestId("toggle-mount"));
    });
    // Remounted row reads the externalized state and reopens without a re-click.
    expect(details()?.open).toBe(true);
  });
});
