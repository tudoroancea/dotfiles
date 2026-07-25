// @vitest-environment jsdom

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SessionStateStore } from "../src/server/state.js";
import {
  PROTOCOL_VERSION,
  type HistoryPageMessage,
  type PersistedEntry,
  type SessionState,
} from "../src/shared/wire.js";
import { BrowserSessionStore } from "../src/web/session-store.js";

const entry = (id: string): PersistedEntry => ({
  id,
  parentId: null,
  timestamp: id,
  entryType: "custom",
  payload: {},
});

const state = (
  historyGeneration: string,
  ids: string[],
  hasOlder = true,
  olderCursor = "cursor-1",
): SessionState => ({
  persisted: {
    sessionId: "session",
    leafId: ids.at(-1) ?? null,
    historyGeneration,
    entries: ids.map(entry),
    hasOlder,
    ...(hasOlder ? { olderCursor } : {}),
  },
  live: { isRunning: false, finalizedMessages: [], tools: [] },
  metadata: { cwd: "/repo", isIdle: true, activeTools: [] },
});

const snapshot = (generation: string, value: SessionState, revision = 0) => ({
  type: "snapshot" as const,
  protocolVersion: PROTOCOL_VERSION,
  generation,
  revision,
  state: value,
});

const page = (
  request: NonNullable<ReturnType<BrowserSessionStore["requestOlderHistory"]>>,
  ids: string[],
  overrides: Partial<HistoryPageMessage> = {},
): HistoryPageMessage => ({
  type: "history_page",
  protocolVersion: PROTOCOL_VERSION,
  commandId: request.commandId,
  generation: request.generation,
  historyGeneration: request.historyGeneration,
  revision: 0,
  entries: ids.map(entry),
  hasOlder: false,
  ...overrides,
});

const historyIds = (browser: BrowserSessionStore) =>
  Array.from({ length: browser.history.length }, (_, index) => browser.history.at(index)!.id);

const context = {
  cwd: "/repo",
  model: undefined,
  sessionManager: {
    getBranch: () => [],
    getSessionId: () => "session-store",
    getLeafId: () => null,
  },
  isIdle: () => true,
  getContextUsage: () => undefined,
} as unknown as ExtensionContext;

describe("browser session store", () => {
  it("applies contiguous coalesced updates and requests resync on a gap", () => {
    const server = new SessionStateStore(context, "generation-1");
    const browser = new BrowserSessionStore();
    const listener = vi.fn();
    browser.subscribe(listener);
    expect(browser.apply(server.snapshot())).toBe("applied");

    const first = server.agentStart()!;
    expect(browser.apply(first)).toBe("applied");
    const skipped = server.updateMetadata({ ...context, cwd: "/other" } as ExtensionContext)!;
    const later = server.messageUpdate({
      role: "assistant",
      content: [{ type: "text", text: "x" }],
    })!;
    expect(skipped.revision).toBe(first.revision + 1);
    expect(browser.apply(later)).toBe("resync");
    const another = server.messageUpdate({
      role: "assistant",
      content: [{ type: "text", text: "later" }],
    })!;
    expect(browser.apply(another)).toBe("ignored");
    expect(browser.getSnapshot().needsResync).toBe(true);
    expect(listener).toHaveBeenCalled();
  });

  it("merges overlapping older pages and same-lineage tails chronologically", () => {
    const browser = new BrowserSessionStore();
    browser.apply(snapshot("generation", state("lineage", ["c", "d"])));

    const request = browser.requestOlderHistory("older-1")!;
    expect(browser.requestOlderHistory("older-2")).toBeUndefined();
    expect(browser.apply(page(request, ["a", "b", "c"]))).toBe("applied");
    expect(historyIds(browser)).toEqual(["a", "b", "c", "d"]);

    browser.apply({
      type: "state_update",
      protocolVersion: PROTOCOL_VERSION,
      generation: "generation",
      baseRevision: 0,
      revision: 1,
      patch: { persisted: state("lineage", ["d", "e"], true, "moving-tail").persisted },
    });
    expect(historyIds(browser)).toEqual(["a", "b", "c", "d", "e"]);
    expect(browser.getHistorySnapshot()).toMatchObject({ hasOlder: false, loadingOlder: false });
  });

  it("rejects stale page correlations and clears pending requests on lineage resets", () => {
    const browser = new BrowserSessionStore();
    browser.apply(snapshot("generation", state("lineage-1", ["c"])));
    const request = browser.requestOlderHistory("current")!;

    expect(browser.apply(page(request, ["a"], { commandId: "stale-command" }))).toBe("ignored");
    expect(browser.apply(page(request, ["a"], { generation: "stale-generation" }))).toBe("ignored");
    expect(browser.apply(page(request, ["a"], { historyGeneration: "stale-lineage" }))).toBe(
      "ignored",
    );
    expect(browser.getHistorySnapshot().loadingOlder).toBe(true);

    browser.apply(snapshot("generation", state("lineage-2", ["x"], true, "cursor-2"), 1));
    expect(browser.getHistorySnapshot()).toMatchObject({
      historyGeneration: "lineage-2",
      loadingOlder: false,
    });
    expect(browser.apply(page(request, ["a"]))).toBe("ignored");
    expect(historyIds(browser)).toEqual(["x"]);
  });

  it("indexes many history chunks for length and random access without a snapshot array", () => {
    const browser = new BrowserSessionStore();
    const pageSize = 64;
    const pageCount = 32;
    const ids = Array.from({ length: pageSize * (pageCount + 1) }, (_, index) =>
      index.toString().padStart(4, "0"),
    );
    browser.apply(snapshot("generation", state("lineage", ids.slice(-pageSize), true, "page-32")));
    const materialize = vi.spyOn(browser.history, "toArray");

    for (let pageIndex = pageCount - 1; pageIndex >= 0; pageIndex -= 1) {
      const request = browser.requestOlderHistory(`request-${pageIndex}`)!;
      const hasOlder = pageIndex > 0;
      expect(
        browser.apply(
          page(request, ids.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize), {
            hasOlder,
            ...(hasOlder ? { olderCursor: `page-${pageIndex}` } : {}),
          }),
        ),
      ).toBe("applied");
    }

    expect(browser.history.length).toBe(ids.length);
    for (const index of [0, 1, 63, 64, 511, 1024, ids.length - 2, ids.length - 1]) {
      expect(browser.history.at(index)?.id).toBe(ids[index]);
    }
    expect(browser.history.at(-1)).toBeUndefined();
    expect(browser.history.at(ids.length)).toBeUndefined();
    expect("entries" in browser.getHistorySnapshot()).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("keeps paged history references and versions stable across live updates", () => {
    const browser = new BrowserSessionStore();
    browser.apply(snapshot("generation", state("lineage", ["tail"])));
    const history = browser.getHistorySnapshot();
    const firstEntry = browser.history.at(0);

    browser.apply({
      type: "state_update",
      protocolVersion: PROTOCOL_VERSION,
      generation: "generation",
      baseRevision: 0,
      revision: 1,
      patch: {
        live: {
          isRunning: true,
          finalizedMessages: [],
          partialAssistant: { role: "assistant", content: [{ type: "text", text: "token" }] },
          tools: [],
        },
      },
    });
    expect(browser.getHistorySnapshot()).toBe(history);
    expect(browser.history.at(0)).toBe(firstEntry);
    expect(browser.getHistorySnapshot().version).toBe(history.version);
  });

  it("cancels a lost page request at a same-generation reconnect barrier", () => {
    const browser = new BrowserSessionStore();
    browser.apply(snapshot("generation", state("lineage", ["tail"], true, "cursor")));
    expect(browser.requestOlderHistory("lost")).toBeTruthy();
    expect(browser.getHistorySnapshot().loadingOlder).toBe(true);

    expect(
      browser.apply({
        type: "ready",
        protocolVersion: PROTOCOL_VERSION,
        generation: "generation",
        revision: 0,
      }),
    ).toBe("applied");
    expect(browser.getHistorySnapshot().loadingOlder).toBe(false);
    browser.apply(snapshot("generation", state("lineage", ["tail"], true, "cursor")));
    expect(browser.requestOlderHistory("retry")).toBeTruthy();
  });

  it("ignores a delayed rejection from an obsolete generation", () => {
    const browser = new BrowserSessionStore();
    browser.apply(snapshot("old", state("old-lineage", ["old"], true, "old-cursor")));
    browser.requestOlderHistory("same-id");
    browser.apply({
      type: "ready",
      protocolVersion: PROTOCOL_VERSION,
      generation: "new",
      revision: 0,
    });
    browser.apply(snapshot("new", state("new-lineage", ["new"], true, "new-cursor")));
    browser.requestOlderHistory("same-id");

    expect(
      browser.apply({
        type: "command_response",
        protocolVersion: PROTOCOL_VERSION,
        generation: "old",
        commandId: "same-id",
        command: "history_page",
        accepted: false,
        error: "stale",
      }),
    ).toBe("ignored");
    expect(browser.getHistorySnapshot().loadingOlder).toBe(true);
  });

  it("treats a snapshot from a new extension generation as a reset barrier", () => {
    const browser = new BrowserSessionStore();
    const first = new SessionStateStore(context, "generation-old");
    const replacement = new SessionStateStore(context, "generation-new");
    browser.apply(first.snapshot());
    expect(
      browser.apply({
        type: "ready",
        protocolVersion: PROTOCOL_VERSION,
        generation: "generation-new",
        revision: 0,
      }),
    ).toBe("resync");
    expect(browser.apply(first.snapshot())).toBe("ignored");
    expect(browser.apply(replacement.snapshot())).toBe("applied");
    expect(browser.getSnapshot()).toMatchObject({
      generation: "generation-new",
      revision: 0,
      needsResync: false,
    });
  });
});
