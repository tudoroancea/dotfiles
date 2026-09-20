import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { h, render } from "preact";
import { useSession } from "../src/client/session.ts";
import {
  imageAttachmentCapabilityFixture,
  outboundImageAttachmentFixture,
  sessionSnapshotFixture,
} from "../src/testing/index.ts";

// A minimal DOM so Preact can render the hook harness and flush effects.
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
    url: "http://127.0.0.1/session/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
    history: window.history,
    location: window.location,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  });
  return dom;
}

function tick(ms = 160) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Render `useSession(transport)` and expose the latest controller reference. */
function mountController(transport) {
  const box = { current: null };
  function Harness() {
    box.current = useSession(transport);
    return null;
  }
  render(h(Harness, {}), document.querySelector("#app"));
  return box;
}

const GENERATION = sessionSnapshotFixture().generation;

function acceptedResponse(command) {
  return {
    version: 1,
    type: "command-response",
    commandId: command.commandId,
    generation: command.generation,
    commandEpoch: command.commandEpoch,
    accepted: true,
  };
}

test("an ambiguous submission preserves its command id so a retry cannot duplicate", async () => {
  const dom = installDom();
  try {
    const ids = [];
    let calls = 0;
    const transport = {
      connect(handlers) {
        handlers.onStatus("online");
        handlers.onEnvelope(sessionSnapshotFixture());
        return () => {};
      },
      async getHistory() {
        throw new Error("unused");
      },
      async submit(command) {
        ids.push(command.commandId);
        calls += 1;
        // First attempt fails at the transport (network/parse); the host may still
        // have admitted it. The retry must reuse the same id so the host dedupes.
        if (calls === 1) throw new Error("network failure");
        return acceptedResponse(command);
      },
      async complete() {
        return { version: 1, type: "completion-response", generation: GENERATION, items: [] };
      },
      close() {},
    };
    const box = mountController(transport);
    await tick();

    const first = await box.current.submit("hello", "immediate");
    assert.equal(first.accepted, false);
    assert.equal(first.ambiguous, true);

    const other = await box.current.submit("another draft", "immediate");
    assert.equal(other.accepted, true);

    const second = await box.current.submit("hello", "immediate");
    assert.equal(second.accepted, true);

    assert.equal(ids.length, 3);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(ids[0], ids[2], "the later retry reuses the ambiguous attempt's command id");
    assert.equal(second.commandId, first.commandId);

    render(null, document.querySelector("#app"));
  } finally {
    dom.window.close();
  }
});

test("an ambiguous image submission reuses only its stable attachment-draft identity", async () => {
  const dom = installDom();
  try {
    const commands = [];
    let calls = 0;
    const transport = {
      connect(handlers) {
        handlers.onStatus("online");
        const snapshot = sessionSnapshotFixture();
        handlers.onEnvelope({
          ...snapshot,
          snapshot: { ...snapshot.snapshot, imageAttachments: imageAttachmentCapabilityFixture() },
        });
        return () => {};
      },
      async getHistory() {
        throw new Error("unused");
      },
      async submit(command) {
        commands.push(command);
        calls += 1;
        if (calls === 1) throw new Error("network failure");
        return acceptedResponse(command);
      },
      async complete() {
        return { version: 1, type: "completion-response", generation: GENERATION, items: [] };
      },
      close() {},
    };
    const box = mountController(transport);
    await tick();
    const attachment = outboundImageAttachmentFixture();

    const first = await box.current.submit("look", "immediate", [attachment], "draft-a");
    const second = await box.current.submit("look", "immediate", [attachment], "draft-a");
    const changed = await box.current.submit("look", "immediate", [attachment], "draft-b");

    assert.equal(first.ambiguous, true);
    assert.equal(first.commandId, second.commandId);
    assert.notEqual(second.commandId, changed.commandId);
    assert.equal(
      commands.every((command) => command.type === "image-command"),
      true,
    );
    render(null, document.querySelector("#app"));
  } finally {
    dom.window.close();
  }
});

test("an authoritative rejection settles the command so the next attempt is a fresh id", async () => {
  const dom = installDom();
  try {
    const ids = [];
    const transport = {
      connect(handlers) {
        handlers.onStatus("online");
        handlers.onEnvelope(sessionSnapshotFixture());
        return () => {};
      },
      async getHistory() {
        throw new Error("unused");
      },
      async submit(command) {
        ids.push(command.commandId);
        return {
          version: 1,
          type: "command-response",
          commandId: command.commandId,
          generation: command.generation,
          commandEpoch: command.commandEpoch,
          accepted: false,
          error: "Pi is busy; choose Steer or Queue",
        };
      },
      async complete() {
        return { version: 1, type: "completion-response", generation: GENERATION, items: [] };
      },
      close() {},
    };
    const box = mountController(transport);
    await tick();

    const first = await box.current.submit("same prompt", "immediate");
    assert.equal(first.accepted, false);
    assert.notEqual(first.ambiguous, true, "an authoritative rejection is not ambiguous");

    const second = await box.current.submit("same prompt", "immediate");
    assert.equal(second.accepted, false);
    assert.notEqual(ids[0], ids[1], "a settled command does not pin its id for the next attempt");

    render(null, document.querySelector("#app"));
  } finally {
    dom.window.close();
  }
});

test("a recoverable stream error reconnects instead of leaving the UI online and stale", async () => {
  const dom = installDom();
  try {
    let connects = 0;
    const transport = {
      connect(handlers) {
        connects += 1;
        handlers.onStatus("online");
        if (connects === 1) {
          // Stand in for a malformed/schema-invalid/oversized frame surfaced by the
          // transport: it must force recovery rather than apply as state.
          handlers.onEnvelope({
            version: 1,
            type: "error",
            code: "STREAM_INVALID",
            message: "Dropped a schema-invalid session frame",
            recoverable: true,
          });
        } else {
          handlers.onEnvelope(sessionSnapshotFixture());
        }
        return () => {};
      },
      async getHistory() {
        throw new Error("unused");
      },
      async submit() {
        throw new Error("unused");
      },
      async complete() {
        return { version: 1, type: "completion-response", generation: GENERATION, items: [] };
      },
      close() {},
    };
    const box = mountController(transport);
    await tick();

    // The invalid initial frame never becomes state; recovery reopens the stream and
    // a fresh snapshot lands.
    await tick();
    assert.equal(connects >= 2, true, "the controller reconnected after the recoverable error");
    assert.ok(box.current.state, "a fresh snapshot recovered the session state");
    assert.equal(box.current.state.generation, GENERATION);

    render(null, document.querySelector("#app"));
  } finally {
    dom.window.close();
  }
});

test("eventual command outcomes deduplicate replay and ignore a stale command epoch", async () => {
  const dom = installDom();
  try {
    let handlers;
    let admitted;
    const transport = {
      connect(nextHandlers) {
        handlers = nextHandlers;
        handlers.onStatus("online");
        handlers.onEnvelope(sessionSnapshotFixture());
        return () => {};
      },
      async getHistory() {
        throw new Error("unused");
      },
      async submit(command) {
        admitted = command;
        return acceptedResponse(command);
      },
      async complete() {
        return { version: 1, type: "completion-response", generation: GENERATION, items: [] };
      },
      close() {},
    };
    const box = mountController(transport);
    await tick();
    const result = await box.current.submit("finish me", "immediate");
    const completion = {
      version: 1,
      type: "command-completion",
      commandId: result.commandId,
      generation: admitted.generation,
      commandEpoch: admitted.commandEpoch,
      revision: sessionSnapshotFixture().revision,
      status: "completed",
    };
    handlers.onEnvelope(completion);
    handlers.onEnvelope(completion);
    await tick();
    assert.equal(box.current.commandCompletions.size, 1);
    assert.equal(box.current.commandCompletions.get(result.commandId).status, "completed");

    const snapshot = sessionSnapshotFixture();
    handlers.onEnvelope({
      ...snapshot,
      type: "reset",
      revision: snapshot.revision + 1,
      reason: "branch changed",
      snapshot: { ...snapshot.snapshot, commandEpoch: "fixture-command-epoch-2" },
    });
    handlers.onEnvelope(completion);
    await tick();
    assert.equal(box.current.commandCompletions.size, 0);

    render(null, document.querySelector("#app"));
  } finally {
    dom.window.close();
  }
});

test("a reset-varying command epoch discards ambiguous IDs from the prior branch", async () => {
  const dom = installDom();
  try {
    const ids = [];
    let calls = 0;
    let handlers;
    const transport = {
      connect(nextHandlers) {
        handlers = nextHandlers;
        handlers.onStatus("online");
        handlers.onEnvelope(sessionSnapshotFixture());
        return () => {};
      },
      async getHistory() {
        throw new Error("unused");
      },
      async submit(command) {
        ids.push(command.commandId);
        calls += 1;
        if (calls === 1) throw new Error("response lost");
        return acceptedResponse(command);
      },
      async complete() {
        return { version: 1, type: "completion-response", generation: GENERATION, items: [] };
      },
      close() {},
    };
    const box = mountController(transport);
    await tick();

    const first = await box.current.submit("same prompt", "immediate");
    assert.equal(first.ambiguous, true);

    const snapshot = sessionSnapshotFixture();
    handlers.onEnvelope({
      ...snapshot,
      type: "reset",
      revision: snapshot.revision + 1,
      reason: "branch changed",
      snapshot: { ...snapshot.snapshot, commandEpoch: "fixture-command-epoch-2" },
    });
    await tick();

    const second = await box.current.submit("same prompt", "immediate");
    assert.equal(second.accepted, true);
    assert.notEqual(ids[0], ids[1], "the replacement branch gets a fresh command identity");

    render(null, document.querySelector("#app"));
  } finally {
    dom.window.close();
  }
});
