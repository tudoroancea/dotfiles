// @vitest-environment jsdom

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SessionStateStore } from "../src/server/state.js";
import { BrowserSessionStore } from "../src/web/session-store.js";

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

  it("treats a snapshot from a new extension generation as a reset barrier", () => {
    const browser = new BrowserSessionStore();
    const first = new SessionStateStore(context, "generation-old");
    const replacement = new SessionStateStore(context, "generation-new");
    browser.apply(first.snapshot());
    expect(
      browser.apply({
        type: "ready",
        protocolVersion: 3,
        generation: "generation-new",
        revision: 0,
      }),
    ).toBe("resync");
    expect(browser.apply(replacement.snapshot())).toBe("applied");
    expect(browser.getSnapshot()).toMatchObject({
      generation: "generation-new",
      revision: 0,
      needsResync: false,
    });
  });
});
