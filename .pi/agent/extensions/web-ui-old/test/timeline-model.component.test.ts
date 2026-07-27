import { describe, expect, it } from "vitest";
import type { PersistedEntry, ProjectedMessage, ToolExecution } from "../src/shared/wire.js";
import {
  anchorScrollOffset,
  buildLiveRows,
  captureTopAnchor,
  distanceFromBottom,
  findRowStart,
  indexPersistedTimeline,
  indexToolCalls,
  isRenderableEntry,
  messageIdentity,
  persistedRowKey,
  persistedTailState,
} from "../src/web/components/timeline-model.js";

const assistant = (timestamp: number, calls: Array<Record<string, unknown>>): ProjectedMessage => ({
  role: "assistant",
  timestamp,
  content: calls,
});

const toolResult = (timestamp: number, id: string, name: string): ProjectedMessage => ({
  role: "toolResult",
  timestamp,
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text: `${name} done` }],
  isError: false,
});

const tool = (id: string, name: string, ordinal: number): ToolExecution => ({
  toolCallId: id,
  toolName: name,
  ordinal,
  status: "completed",
  args: {},
  result: { content: [{ type: "text", text: `${name} done` }] },
  isError: false,
});

const entry = (id: string, message: unknown): PersistedEntry => ({
  id,
  parentId: null,
  timestamp: id,
  entryType: "message",
  payload: { message },
});

describe("timeline row model", () => {
  it("orders live rounds and derives stable, index-independent row keys", () => {
    const messages = [
      assistant(1, [{ type: "toolCall", id: "a", name: "bash", arguments: {} }]),
      toolResult(2, "a", "bash"),
      assistant(3, [
        { type: "toolCall", id: "b", name: "read", arguments: {} },
        { type: "toolCall", id: "c", name: "write", arguments: {} },
      ]),
      toolResult(4, "b", "read"),
      toolResult(5, "c", "write"),
    ];
    const tools = [tool("a", "bash", 0), tool("b", "read", 1), tool("c", "write", 2)];
    const rows = buildLiveRows(messages, undefined, tools);

    expect(rows.map((row) => row.key)).toEqual([
      `live-message:${messageIdentity(messages[0]!)}`,
      "tool:a",
      `live-message:${messageIdentity(messages[2]!)}`,
      "tool:b",
      "tool:c",
    ]);
    // Matching tool-result overlays are dropped in favor of the tool panels.
    expect(rows.filter((row) => row.message?.role === "toolResult")).toHaveLength(0);
  });

  it("keeps the partial assistant tail and trails orphaned tools deterministically", () => {
    const partial = assistant(9, [{ type: "toolCall", id: "p", name: "read", arguments: {} }]);
    const rows = buildLiveRows([], partial, [tool("p", "read", 0), tool("orphan", "bash", 1)]);
    expect(rows.map((row) => row.key)).toEqual(["partial-assistant", "tool:p", "tool:orphan"]);
  });

  it("disambiguates repeated message identities without depending on array order", () => {
    const twin = assistant(7, [
      { type: "text", text: "same" } as unknown as Record<string, unknown>,
    ]);
    const rows = buildLiveRows([twin, twin], undefined, []);
    const base = `live-message:${messageIdentity(twin)}`;
    expect(rows.map((row) => row.key)).toEqual([base, `${base}#1`]);
  });

  it("indexes persisted assistant tool-call arguments by tool-call id", () => {
    const entries = [
      entry("assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
      }),
      entry("result", { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [] }),
    ];
    const calls = indexToolCalls(entries);
    expect(calls.get("call-1")).toEqual({ name: "bash", args: { command: "ls" } });
    expect(calls.size).toBe(1);
  });

  it("collects only the bounded persisted tail identities used for overlay de-duplication", () => {
    const entries = [
      entry("a", { role: "assistant", content: [], timestamp: 1 }),
      entry("b", { role: "toolResult", toolCallId: "tc", toolName: "bash", content: [] }),
    ];
    const state = persistedTailState(entries);
    expect(
      state.messages.has(messageIdentity({ role: "assistant", content: [], timestamp: 1 })),
    ).toBe(true);
    expect(state.toolResults.has("tc")).toBe(true);
  });

  it("indexes only visible persisted rows while retaining all overlay identities", () => {
    const startup: PersistedEntry = {
      id: "startup",
      parentId: null,
      timestamp: "0",
      entryType: "custom",
      payload: { customType: "web-ui-startup" },
    };
    const hidden: PersistedEntry = {
      ...startup,
      id: "hidden",
      entryType: "custom_message",
      payload: { customType: "notice", display: false },
    };
    const result = entry("result", toolResult(3, "call-hidden", "bash"));
    const indexed = indexPersistedTimeline([startup, hidden, result]);

    expect(indexed.visibleIndexes).toEqual([2]);
    expect(indexed.toolResults.has("call-hidden")).toBe(true);
    expect(isRenderableEntry(startup)).toBe(false);
    expect(isRenderableEntry(hidden)).toBe(false);
    expect(isRenderableEntry(entry("real", { role: "user", content: [] }))).toBe(true);
    expect(persistedRowKey(result)).toBe("tool:call-hidden");
    expect(persistedRowKey(entry("real", { role: "user", content: [] }))).toBe("entry:real");
  });
});

describe("scroll anchoring helpers", () => {
  const spans = [
    { key: "load", start: 0, end: 40 },
    { key: "entry:a", start: 40, end: 140 },
    { key: "entry:b", start: 140, end: 260 },
    { key: "entry:c", start: 260, end: 420 },
  ];

  it("captures the first transcript row crossing the viewport top with its pixel offset", () => {
    const anchor = captureTopAnchor(spans, 160);
    expect(anchor).toEqual({ key: "entry:b", delta: 140 - 160 });
    expect(captureTopAnchor(spans, 0)).toEqual({ key: "entry:a", delta: 40 });
  });

  it("never falls back to a synthetic head row", () => {
    expect(captureTopAnchor([{ key: "load", start: 0, end: 40 }], 0)).toBeUndefined();
    expect(captureTopAnchor([{ key: "intro", start: 0, end: 80 }], 0)).toBeUndefined();
  });

  it("restores the captured row to the same viewport offset after a prepend", () => {
    const anchor = captureTopAnchor(spans, 160)!;
    // After prepending one 300px page, entry:b moved down by 300px.
    const measurementsAfter = [
      { key: "load", start: 0, end: 40 },
      { key: "entry:x", start: 40, end: 190 },
      { key: "entry:y", start: 190, end: 340 },
      { key: "entry:a", start: 340, end: 440 },
      { key: "entry:b", start: 440, end: 560 },
    ];
    const start = findRowStart(measurementsAfter, anchor.key);
    expect(start).toBe(440);
    // delta is (140 - 160) = -20, so the restored scroll keeps the row 20px above the top.
    expect(anchorScrollOffset(start!, anchor.delta)).toBe(460);
  });

  it("never returns a negative scroll offset", () => {
    expect(anchorScrollOffset(10, 40)).toBe(0);
  });

  it("measures the distance from the bottom of a scroller", () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 })).toBe(0);
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 100 })).toBe(500);
  });
});
