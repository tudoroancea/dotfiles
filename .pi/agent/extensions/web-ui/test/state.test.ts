import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectJson, projectPersistedState } from "../src/server/projection.js";
import { mergeStateUpdates, SessionStateStore } from "../src/server/state.js";

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/session-events.json", import.meta.url)), "utf8"),
) as { persistedBranch: unknown[]; liveEvents: Array<Record<string, unknown>> };

function harness(initialBranch: unknown[] = fixtures.persistedBranch) {
  let branch = [...initialBranch];
  let idle = true;
  const context = {
    cwd: "/repo",
    model: undefined,
    thinkingLevel: "medium",
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-1",
      getLeafId: () => {
        const last = branch.at(-1) as { id?: string } | undefined;
        return last?.id ?? null;
      },
    },
    isIdle: () => idle,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
  } as unknown as ExtensionContext;
  return {
    context,
    setBranch: (next: unknown[]) => (branch = next),
    setIdle: (next: boolean) => (idle = next),
  };
}

function contentText(result: unknown): string | undefined {
  const record = result as { content?: Array<{ text?: string }> };
  return record.content?.[0]?.text;
}

describe("SessionStateStore", () => {
  it("keeps persisted and live state separate with a sanitized structural startup entry", () => {
    const previous = fixtures.persistedBranch.at(-1) as { id: string };
    const startup = {
      type: "custom",
      id: "startup",
      parentId: previous.id,
      timestamp: "2026-07-24T12:00:05.000Z",
      customType: "web-ui-startup",
      data: { url: "http://stale", generation: "old" },
    };
    const session = harness([...fixtures.persistedBranch, startup]);
    const store = new SessionStateStore(session.context, "generation-1", ["read", "bash"]);
    const state = store.state();
    expect(state.persisted.entries.at(-1)).toMatchObject({
      id: "startup",
      payload: { customType: "web-ui-startup" },
    });
    expect(JSON.stringify(state.persisted.entries.at(-1))).not.toContain("http://stale");
    expect(state.persisted.leafId).toBe("startup");
    const ids = new Set(state.persisted.entries.map((entry) => entry.id));
    expect(
      state.persisted.entries.every((entry) => entry.parentId === null || ids.has(entry.parentId)),
    ).toBe(true);
    expect(state.persisted.entries).toHaveLength(fixtures.persistedBranch.length + 1);
    expect(state.live).toEqual({ isRunning: false, finalizedMessages: [], tools: [] });
    expect(state.metadata.activeTools).toEqual(["read", "bash"]);
    expect(store.revision).toBe(0);
  });

  it("replaces accumulated tool updates and preserves source order for parallel tools", () => {
    const session = harness([]);
    const store = new SessionStateStore(session.context, "generation-2");
    const events = fixtures.liveEvents;

    store.toolStart(events[1] as never);
    store.toolStart(events[2] as never);
    const firstPartial = store.toolUpdate(events[3] as never)!;
    const firstRevision = firstPartial.revision;
    const replacement = store.toolUpdate(events[4] as never)!;
    expect(replacement.baseRevision).toBe(firstRevision);
    expect(store.state().live.tools.map((tool) => tool.toolCallId)).toEqual([
      "parallel-a",
      "parallel-b",
    ]);
    expect(contentText(store.state().live.tools[1]?.result)).toBe(
      "half complete\nfailed: assertion",
    );
    expect(contentText(store.state().live.tools[1]?.result)).not.toBe(
      "half completehalf complete\nfailed: assertion",
    );

    const revision = store.revision;
    expect(store.toolUpdate(events[4] as never)).toBeUndefined();
    expect(store.revision).toBe(revision);

    store.toolEnd(events[6] as never);
    store.toolEnd(events[7] as never);
    expect(store.state().live.tools.map((tool) => tool.status)).toEqual(["completed", "error"]);
  });

  it("publishes busy metadata and a user overlay before persistence", () => {
    const session = harness([]);
    const store = new SessionStateStore(session.context, "generation-busy");
    const started = store.agentStart()!;
    expect(started.patch).toMatchObject({
      live: { isRunning: true },
      metadata: { isIdle: false },
    });
    const user = {
      role: "user",
      content: [{ type: "text", text: "start the task" }],
      timestamp: 100,
    };
    store.messageStart(user);
    expect(store.state().live.finalizedMessages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [{ text: "start the task", type: "text" }],
      }),
    );
    const revision = store.revision;
    expect(store.messageEnd(user)).toBeUndefined();
    expect(store.revision).toBe(revision);

    session.setBranch([
      {
        type: "message",
        id: "persisted-user",
        parentId: null,
        timestamp: "2026-07-24T12:00:00.000Z",
        message: user,
      },
    ]);
    session.setIdle(true);
    store.reconcile(session.context, { settled: true });
    expect(store.state().persisted.entries).toHaveLength(1);
    expect(store.state().live.finalizedMessages).toEqual([]);
    expect(store.state().metadata.isIdle).toBe(true);
  });

  it("preserves complete tool images or emits an explicit omission", () => {
    const session = harness([]);
    const store = new SessionStateStore(session.context, "generation-images");
    const image = { type: "image", mimeType: "image/png", data: "eA==" };
    store.toolUpdate({
      toolCallId: "image-tool",
      toolName: "read",
      args: { path: "image.png" },
      partialResult: { content: [image] },
    });
    expect(store.state().live.tools[0]?.result).toMatchObject({
      content: [image],
    });
    store.toolUpdate({
      toolCallId: "image-tool",
      toolName: "read",
      args: { path: "image.png" },
      partialResult: {
        content: [
          { type: "text", text: "x".repeat(2 * 1024 * 1024) },
          { type: "text", text: "y".repeat(2 * 1024 * 1024) },
          image,
        ],
      },
    });
    const exhaustedContent = (
      store.state().live.tools[0]!.result as { content: Array<Record<string, unknown>> }
    ).content;
    expect(exhaustedContent.at(-1)).toMatchObject({
      type: "image",
      omitted: true,
      count: 1,
    });
    store.toolEnd({
      toolCallId: "image-tool",
      toolName: "read",
      result: {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "eA==".repeat(400_000),
          },
        ],
      },
      isError: false,
    });
    expect(store.state().live.tools[0]?.result).toMatchObject({
      content: [{ type: "image", mimeType: "image/png", omitted: true }],
    });
  });

  it("retains event finals until an atomic settled reconciliation captures persistence", () => {
    const session = harness([]);
    const store = new SessionStateStore(session.context, "generation-3");
    const updateEvent = fixtures.liveEvents[0]!;
    store.messageUpdate(updateEvent.message);
    const finalMessage = {
      ...(updateEvent.message as Record<string, unknown>),
      content: [{ type: "text", text: "Working complete" }],
      stopReason: "stop",
    };
    store.messageEnd(finalMessage);
    expect(store.state().persisted.entries).toEqual([]);
    expect(store.state().live.partialAssistant).toBeUndefined();
    expect(store.state().live.finalizedMessages).toHaveLength(1);

    const revisionBeforeReconnect = store.revision;
    expect(store.reconcile(session.context)).toBeUndefined();
    expect(store.revision).toBe(revisionBeforeReconnect);
    expect(store.state().live.finalizedMessages).toHaveLength(1);

    session.setBranch([
      {
        type: "message",
        id: "assistant-final",
        parentId: null,
        timestamp: "2026-07-24T12:00:10.000Z",
        message: finalMessage,
      },
    ]);
    const settled = store.reconcile(session.context, { settled: true })!;
    expect(settled.baseRevision).toBe(revisionBeforeReconnect);
    expect(settled.revision).toBe(revisionBeforeReconnect + 1);
    expect(settled.patch.persisted?.entries).toHaveLength(1);
    expect(settled.patch.live).toEqual({ isRunning: false, finalizedMessages: [], tools: [] });
    expect(store.state().live.finalizedMessages).toEqual([]);
  });

  it("keeps quote-heavy persisted and live state within the serialized snapshot budget", () => {
    const huge = '\\"'.repeat(256 * 1024);
    const persisted = Array.from({ length: 20 }, (_, index) => ({
      type: "message",
      id: `persisted-${index}`,
      parentId: index === 0 ? null : `persisted-${index - 1}`,
      timestamp: `2026-07-24T12:00:${String(index).padStart(2, "0")}.000Z`,
      message: {
        role: "user",
        content: [{ type: "text", text: huge }],
        timestamp: index,
      },
    }));
    const session = harness(persisted);
    const store = new SessionStateStore(session.context, "generation-bounded");
    store.agentStart();
    for (let index = 0; index < 12; index += 1) {
      store.messageStart({
        role: "user",
        content: [{ type: "text", text: huge }],
        timestamp: index,
      });
    }
    for (let index = 0; index < 12; index += 1) {
      store.toolUpdate({
        toolCallId: `tool-${index}`,
        toolName: "hostile",
        args: { value: huge },
        partialResult: { content: [{ type: "text", text: huge }] },
      });
    }
    store.messageUpdate({
      role: "assistant",
      content: [{ type: "text", text: huge }],
    });
    expect(store.state().live.finalizedMessages).toHaveLength(8);
    expect(store.state().live.tools.length).toBeGreaterThan(0);
    expect(store.state().live.tools.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(JSON.stringify(store.snapshot()))).toBeLessThan(8 * 1024 * 1024);
  });

  it("merges contiguous replacement-complete patches without inventing revisions", () => {
    const session = harness([]);
    const store = new SessionStateStore(session.context, "generation-4");
    const first = store.agentStart()!;
    const second = store.messageUpdate(fixtures.liveEvents[0]!.message)!;
    const merged = mergeStateUpdates(first, second);
    expect(merged.baseRevision).toBe(first.baseRevision);
    expect(merged.revision).toBe(second.revision);
    expect(merged.patch.live?.partialAssistant?.role).toBe("assistant");
    expect(() => mergeStateUpdates(second, first)).toThrow("not contiguous");
  });
});

describe("safe projection", () => {
  it("applies image count and source limits to persisted messages", () => {
    const images = Array.from({ length: 5 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: "eA==",
    }));
    const session = harness([
      {
        type: "message",
        id: "images",
        parentId: null,
        timestamp: "2026-07-24T12:00:00.000Z",
        message: { role: "user", content: images, timestamp: 1 },
      },
      {
        type: "message",
        id: "oversized-image",
        parentId: "images",
        timestamp: "2026-07-24T12:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "x".repeat(1_500_000),
            },
          ],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "fresh-image-count",
        parentId: "oversized-image",
        timestamp: "2026-07-24T12:00:02.000Z",
        message: { role: "user", content: [images[0]], timestamp: 3 },
      },
    ]);
    const persisted = projectPersistedState(session.context);
    const first = persisted.entries[0]!.payload as {
      message: { content: Array<{ omitted?: boolean }> };
    };
    const second = persisted.entries[1]!.payload as {
      message: { content: Array<{ omitted?: boolean }> };
    };
    const third = persisted.entries[2]!.payload as {
      message: { content: Array<{ data?: string; omitted?: boolean }> };
    };
    expect(first.message.content).toHaveLength(5);
    expect(first.message.content[4]).toMatchObject({ omitted: true });
    expect(second.message.content[0]).toMatchObject({ omitted: true });
    expect(third.message.content[0]).toMatchObject({ data: "eA==" });
  });

  it("bounds aggregate recursive payloads before serialization", () => {
    const projected = projectJson(
      Array.from({ length: 256 }, (_, index) => ({
        index,
        values: Array.from({ length: 256 }, () => "x".repeat(8_192)),
      })),
    );
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(70 * 1024);
  });

  it("bounds strings and removes cycles and executable object members", () => {
    expect(String(projectJson("x".repeat(2 * 1024 * 1024)))).toContain("[truncated]");
    const cyclic: Record<string, unknown> = {
      text: "short",
      callback: () => "secret",
      apiKey: "must-not-leak",
      nested: { authorization: "Bearer must-not-leak" },
    };
    cyclic.self = cyclic;
    const projected = projectJson(cyclic) as Record<string, unknown>;
    expect(projected.text).toBe("short");
    expect(projected.callback).toBeNull();
    expect(projected.apiKey).toBe("[redacted]");
    expect(projected.nested).toEqual({ authorization: "[redacted]" });
    expect(projected.self).toBe("[circular]");
    expect(() => JSON.stringify(projected)).not.toThrow();

    const hostile = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not escape projection");
      },
    });
    expect(projectJson(hostile)).toEqual({ secret: "[redacted]" });
  });
});
