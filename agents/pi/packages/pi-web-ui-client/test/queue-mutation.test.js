import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { h, render } from "preact";
import { useSession } from "../src/client/session.ts";
import { sessionSnapshotFixture } from "../src/testing/index.ts";

function mount(transport) {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
    url: "http://127.0.0.1/session/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    history: dom.window.history,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  });
  const box = { current: null };
  function Harness() {
    box.current = useSession(transport);
    return null;
  }
  render(h(Harness, {}), document.querySelector("#app"));
  return { dom, box };
}

const accepted = (command) => ({
  version: 1,
  type: "command-response",
  commandId: command.commandId,
  generation: command.generation,
  commandEpoch: command.commandEpoch,
  accepted: true,
});

test("queue mutation retries reuse identity after ambiguous transport delivery", async () => {
  const snapshot = sessionSnapshotFixture();
  const calls = [];
  let attempts = 0;
  const transport = {
    connect(handlers) {
      handlers.onStatus("online");
      handlers.onEnvelope(snapshot);
      return () => {};
    },
    async getHistory() {
      throw new Error("unused");
    },
    async submit() {
      throw new Error("unused");
    },
    async mutatePendingInput(command) {
      calls.push(command);
      attempts += 1;
      if (attempts === 1) throw new Error("network lost");
      return accepted(command);
    },
    async complete() {
      return {
        version: 1,
        type: "completion-response",
        generation: snapshot.generation,
        items: [],
      };
    },
    close() {},
  };
  const { dom, box } = mount(transport);
  await new Promise((resolve) => setTimeout(resolve, 160));
  const first = await box.current.mutatePendingInput("row-1", 1, "edit", "new text");
  const second = await box.current.mutatePendingInput("row-1", 1, "edit", "new text");
  assert.equal(first.ambiguous, true);
  assert.equal(second.accepted, true);
  assert.equal(calls[0].commandId, calls[1].commandId);
  render(null, document.querySelector("#app"));
  dom.window.close();
});
