// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/app.js";
import {
  PROTOCOL_VERSION,
  type HistoryPageMessage,
  type PersistedEntry,
  type ServerMessage,
} from "../src/shared/wire.js";

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

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  emit(message: ServerMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;
let offsetHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  ResizeObserverMock.instances = [];
  FakeWebSocket.instances = [];
  window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn(async () => new Response(undefined, { status: 204 }));
  offsetHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 100,
  });
  window.HTMLElement.prototype.scrollTo = vi.fn();
  history.replaceState(null, "", "/#bootstrap=secret-credential");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalWebSocket;
  if (offsetHeight)
    Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", offsetHeight);
  else delete (window.HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

const entry = (id: string, text: string): PersistedEntry => ({
  id,
  parentId: null,
  timestamp: `2026-01-01T00:00:00.000Z`,
  entryType: "message",
  payload: { message: { role: "user", content: [{ type: "text", text }] } },
});

const snapshot = (
  entries: PersistedEntry[],
  hasOlder: boolean,
  olderCursor?: string,
): ServerMessage => ({
  type: "snapshot",
  protocolVersion: PROTOCOL_VERSION,
  generation: "generation-1",
  revision: 0,
  state: {
    persisted: {
      sessionId: "session-1234",
      leafId: entries.at(-1)?.id ?? null,
      historyGeneration: "history-1",
      entries,
      hasOlder,
      ...(hasOlder && olderCursor ? { olderCursor } : {}),
    },
    live: { isRunning: false, finalizedMessages: [], tools: [] },
    metadata: { cwd: "/repo", isIdle: true, activeTools: [] },
  },
});

async function boot(entries: PersistedEntry[], hasOlder: boolean, olderCursor?: string) {
  const rendered = render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
  });
  await act(async () => {
    socket.emit({
      type: "ready",
      protocolVersion: PROTOCOL_VERSION,
      generation: "generation-1",
      revision: 0,
    });
    socket.emit(snapshot(entries, hasOlder, olderCursor));
  });
  const scroller = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLElement>(".timeline-scroll");
    expect(element).toBeTruthy();
    return element!;
  });
  const observer = ResizeObserverMock.instances.find((candidate) =>
    candidate.targets.has(scroller),
  );
  await act(async () => observer?.triggerHeight(scroller, 400));
  return { rendered, socket };
}

const pageMessage = (
  commandId: string,
  entries: PersistedEntry[],
  hasOlder: boolean,
): HistoryPageMessage => ({
  type: "history_page",
  protocolVersion: PROTOCOL_VERSION,
  commandId,
  generation: "generation-1",
  historyGeneration: "history-1",
  revision: 0,
  entries,
  hasOlder,
});

describe("app history paging integration", () => {
  it("routes rejected and successful history pages through the session store", async () => {
    const { rendered, socket } = await boot(
      [entry("c", "third"), entry("d", "fourth")],
      true,
      "cursor-1",
    );

    const loader = rendered.container.querySelector<HTMLButtonElement>(".timeline__earlier-button");
    expect(loader?.textContent).toContain("Load earlier messages");
    const noticeBefore = rendered.container.querySelector(".composer__notice")?.textContent ?? "";

    // Loading earlier history sends a correlated history_page command.
    await act(async () => {
      fireEvent.click(loader!);
    });
    const request = socket.sent.find((message) => message.type === "history_page");
    expect(request).toMatchObject({
      type: "history_page",
      generation: "generation-1",
      historyGeneration: "history-1",
      cursor: "cursor-1",
    });
    const commandId = request!.commandId as string;
    expect(typeof commandId).toBe("string");

    // A rejection reaches the store (surfaced as the load error) and never
    // becomes a generic composer command notice.
    await act(async () => {
      socket.emit({
        type: "command_response",
        protocolVersion: PROTOCOL_VERSION,
        generation: "generation-1",
        commandId,
        command: "history_page",
        accepted: false,
        error: "History cursor is stale",
      });
    });
    await waitFor(() =>
      expect(rendered.container.querySelector(".timeline__earlier-error")?.textContent).toContain(
        "History cursor is stale",
      ),
    );
    expect(rendered.container.querySelector(".composer__notice")?.textContent ?? "").toBe(
      noticeBefore,
    );

    // Retrying issues a fresh correlated request that succeeds and prepends.
    const retry = rendered.container.querySelector<HTMLButtonElement>(".timeline__earlier-button")!;
    expect(retry.textContent).toContain("Retry loading earlier messages");
    await act(async () => {
      fireEvent.click(retry);
    });
    const retryRequest = socket.sent.filter((message) => message.type === "history_page").at(-1)!;
    const retryId = retryRequest.commandId as string;
    expect(retryId).not.toBe(commandId);

    await act(async () => {
      socket.emit(pageMessage(retryId, [entry("a", "first"), entry("b", "second")], false));
    });
    await waitFor(() => expect(rendered.container.querySelector(".timeline__earlier")).toBeNull());
    // Reaching the first entry replaces the loader with the session intro.
    expect(rendered.container.querySelector('[aria-label="Session details"]')).toBeTruthy();
  });

  it("ignores a stale page response from a superseded correlation", async () => {
    const { rendered, socket } = await boot([entry("c", "third")], true, "cursor-1");
    const loader = rendered.container.querySelector<HTMLButtonElement>(
      ".timeline__earlier-button",
    )!;
    await act(async () => {
      fireEvent.click(loader);
    });
    const request = socket.sent.find((message) => message.type === "history_page")!;

    // A page carrying a mismatched command id must not mutate history.
    await act(async () => {
      socket.emit(pageMessage("not-the-pending-id", [entry("z", "ghost")], false));
    });
    expect(rendered.container.textContent).not.toContain("ghost");
    // The genuine correlation still resolves.
    await act(async () => {
      socket.emit(pageMessage(request.commandId as string, [entry("a", "first")], false));
    });
    await waitFor(() => expect(rendered.container.querySelector(".timeline__earlier")).toBeNull());
  });
});
