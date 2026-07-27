import { Buffer } from "node:buffer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { HistoryManager } from "../src/server/history.js";
import { LIMITS } from "../src/shared/limits.js";
import type { HistoryPageCommand } from "../src/shared/wire.js";

function entry(index: number, text = `entry ${index}`) {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: index },
  };
}

function harness(initial: unknown[]) {
  let branch = initial;
  let sessionId = "session-history";
  let leafId = (branch.at(-1) as { id?: string } | undefined)?.id ?? null;
  const context = {
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
    },
  } as unknown as ExtensionContext;
  return {
    context,
    setBranch(next: unknown[]) {
      branch = next;
      leafId = (next.at(-1) as { id?: string } | undefined)?.id ?? null;
    },
    replaceLeaf(next: string | null) {
      leafId = next;
    },
    replaceSession(next: string) {
      sessionId = next;
    },
  };
}

function command(
  historyGeneration: string,
  cursor: string,
  commandId = "page-1",
): HistoryPageCommand {
  return {
    type: "history_page",
    commandId,
    generation: "extension-generation",
    historyGeneration,
    cursor,
  };
}

describe("HistoryManager", () => {
  it("pages from the newest window to the first entry chronologically without gaps", () => {
    const source = Array.from({ length: 251 }, (_, index) => entry(index));
    const session = harness(source);
    const history = new HistoryManager(session.context, "extension-generation");
    const window = history.window();
    expect(window.entries).toHaveLength(LIMITS.historyPageEntries);
    expect(window.entries[0]?.id).toBe("entry-151");
    expect(window.hasOlder).toBe(true);

    const chunks = [window.entries];
    let cursor = window.olderCursor;
    let request = 0;
    while (cursor) {
      const page = history.page(command(window.historyGeneration, cursor, `page-${request++}`), 17);
      expect(page.entries.length).toBeLessThanOrEqual(LIMITS.historyPageEntries);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIMITS.historyPageBytes);
      chunks.unshift(page.entries);
      cursor = page.olderCursor;
      expect(page.hasOlder).toBe(Boolean(cursor));
    }
    expect(chunks.flat().map((item) => item.id)).toEqual(source.map((item) => item.id));
  });

  it("accounts for quote-heavy UTF-8 envelopes and explicitly omits one oversized entry", () => {
    const quoteHeavy = '🙂\\"'.repeat(60_000);
    const huge = {
      type: "custom",
      id: "huge",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "hostile",
      data: Array.from({ length: 128 }, (_, index) => ({ index, text: quoteHeavy })),
    };
    const session = harness([
      huge,
      ...Array.from({ length: 8 }, (_, index) => ({
        ...entry(index + 1, quoteHeavy),
        parentId: index === 0 ? "huge" : `entry-${index}`,
      })),
    ]);
    const history = new HistoryManager(session.context, "extension-generation");
    const window = history.window();
    expect(Buffer.byteLength(JSON.stringify(window))).toBeLessThanOrEqual(LIMITS.historyPageBytes);

    let cursor = window.olderCursor;
    const pages = [];
    while (cursor) {
      const page = history.page(command(window.historyGeneration, cursor), 0);
      pages.push(page);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIMITS.historyPageBytes);
      cursor = page.olderCursor;
    }
    const omitted = [...window.entries, ...pages.flatMap((page) => page.entries)].find(
      (item) => item.id === "huge",
    );
    expect(omitted?.payload).toMatchObject({ omitted: true, reason: expect.any(String) });
  });

  it("accepts an exactly 512 KiB caller-supplied serialized envelope", () => {
    const session = harness([entry(0, 'quote: " and emoji: 🙂')]);
    const history = new HistoryManager(session.context, "extension-generation");
    const preliminary = history.buildInitialPage((candidate) =>
      Buffer.byteLength(JSON.stringify(candidate)),
    );
    const emptyEnvelopeBytes = Buffer.byteLength(
      JSON.stringify({ transport: "custom", padding: "", page: preliminary }),
    );
    const paddingBytes = LIMITS.historyPageBytes - emptyEnvelopeBytes;
    expect(paddingBytes).toBeGreaterThan(0);

    const page = history.buildInitialPage((candidate) =>
      Buffer.byteLength(
        JSON.stringify({ transport: "custom", padding: "x".repeat(paddingBytes), page: candidate }),
      ),
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({ transport: "custom", padding: "x".repeat(paddingBytes), page }),
      ),
    ).toBe(LIMITS.historyPageBytes);
    expect(page.entries).toHaveLength(1);
  });

  it("authenticates bounded lineage cursors and keeps retries idempotent across strict appends", () => {
    const source = Array.from({ length: 120 }, (_, index) => entry(index));
    const session = harness(source);
    const history = new HistoryManager(session.context, "extension-generation");
    const window = history.window();
    const cursor = window.olderCursor!;
    expect(Buffer.byteLength(cursor)).toBeLessThanOrEqual(LIMITS.historyCursorBytes);
    const request = command(window.historyGeneration, cursor);
    const first = history.page(request, 4);
    expect(history.page(request, 4)).toEqual(first);

    const appended = entry(120);
    session.setBranch([...source, appended]);
    history.refresh();
    expect(history.historyGeneration).toBe(window.historyGeneration);
    expect(history.page(request, 4)).toEqual(first);

    session.setBranch([
      ...source,
      appended,
      { ...entry(121), id: "entry-19", parentId: "entry-120" },
    ]);
    history.refresh();
    expect(history.historyGeneration).toBe(window.historyGeneration);
    expect(history.page(request, 4)).toEqual(first);

    const otherHistory = new HistoryManager(session.context, "extension-generation");
    expect(() => otherHistory.page(command(otherHistory.historyGeneration, cursor), 4)).toThrow(
      "invalid or stale",
    );

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    expect(() => history.page(command(window.historyGeneration, tampered), 4)).toThrow(
      "invalid or stale",
    );
    expect(() =>
      history.page(command(window.historyGeneration, "x".repeat(LIMITS.historyCursorBytes + 1)), 4),
    ).toThrow("invalid or stale");
  });

  it("rotates generation on replacement tails, leaf changes, explicit tree changes, and sessions", () => {
    const source = Array.from({ length: 120 }, (_, index) => entry(index));
    const session = harness(source);
    const history = new HistoryManager(session.context, "extension-generation");
    const original = history.window();

    session.setBranch([
      ...source.slice(0, -1),
      {
        ...source.at(-1)!,
        message: { role: "user", content: [{ type: "text", text: "changed" }] },
      },
    ]);
    history.refresh();
    const replaced = history.historyGeneration;
    expect(replaced).not.toBe(original.historyGeneration);
    expect(() =>
      history.page(command(original.historyGeneration, original.olderCursor!), 0),
    ).toThrow("invalid or stale");

    session.setBranch(
      source.map((item, index) => (index === 40 ? { ...item, parentId: "entry-2" } : item)),
    );
    history.rotate();
    const boundaryChanged = history.historyGeneration;
    expect(boundaryChanged).not.toBe(replaced);

    session.replaceLeaf("different-leaf");
    history.refresh();
    const leafChanged = history.historyGeneration;
    expect(leafChanged).not.toBe(boundaryChanged);

    history.rotate();
    const forced = history.historyGeneration;
    expect(forced).not.toBe(leafChanged);

    session.replaceSession("different-session");
    history.refresh();
    expect(history.historyGeneration).not.toBe(forced);
  });
});
