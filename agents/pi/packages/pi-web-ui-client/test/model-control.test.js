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

function transportWith(submitModelControl, onConnect = () => {}) {
  const snapshot = sessionSnapshotFixture();
  return {
    connect(handlers) {
      onConnect(handlers, snapshot);
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
    async mutatePendingInput() {
      throw new Error("unused");
    },
    submitModelControl,
    async complete() {
      return {
        version: 1,
        type: "completion-response",
        generation: snapshot.generation,
        items: [],
      };
    },
    imageUrl() {
      return "";
    },
    close() {},
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 160));

test("model control retries preserve identity only for the exact ambiguous target", async () => {
  const commands = [];
  let calls = 0;
  const { dom, box } = mount(
    transportWith(async (command) => {
      commands.push(command);
      calls += 1;
      if (calls === 1) throw new Error("response lost");
      return accepted(command);
    }),
  );
  await tick();

  const target = { type: "set-model", provider: "fixture", modelId: "model-2" };
  const first = await box.current.submitModelControl(target);
  const other = await box.current.submitModelControl({
    type: "set-thinking",
    thinkingLevel: "high",
  });
  const retry = await box.current.submitModelControl(target);

  assert.equal(first.ambiguous, true);
  assert.equal(other.accepted, true);
  assert.equal(retry.accepted, true);
  assert.equal(commands[0].commandId, commands[2].commandId);
  assert.notEqual(commands[0].commandId, commands[1].commandId);
  assert.deepEqual(
    commands.map(({ type }) => type),
    ["set-model", "set-thinking", "set-model"],
  );
  render(null, document.querySelector("#app"));
  dom.window.close();
});

test("model-control rejection preserves its dedicated reason", async () => {
  const { dom, box } = mount(
    transportWith(async (command) => ({
      ...accepted(command),
      accepted: false,
      error: "Model queue is busy",
      reason: "queue-busy",
    })),
  );
  await tick();

  const result = await box.current.submitModelControl({
    type: "set-thinking",
    thinkingLevel: "high",
  });
  assert.deepEqual(
    { accepted: result.accepted, error: result.error, reason: result.reason },
    { accepted: false, error: "Model queue is busy", reason: "queue-busy" },
  );
  render(null, document.querySelector("#app"));
  dom.window.close();
});

test("concurrent exact model-control submissions coalesce", async () => {
  const commands = [];
  let resolveResponse;
  const { dom, box } = mount(
    transportWith(
      (command) =>
        new Promise((resolve) => {
          commands.push(command);
          resolveResponse = () => resolve(accepted(command));
        }),
    ),
  );
  await tick();

  const target = { type: "set-model", provider: "fixture", modelId: "model-2" };
  const first = box.current.submitModelControl(target);
  const concurrent = box.current.submitModelControl({ ...target });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(commands.length, 1);
  resolveResponse();
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  assert.equal(firstResult.accepted, true);
  assert.equal(concurrentResult.accepted, true);
  assert.equal(firstResult.commandId, concurrentResult.commandId);
  render(null, document.querySelector("#app"));
  dom.window.close();
});

test("authoritative confirmation clears an ambiguous id before divergence and resubmission", async () => {
  const commands = [];
  let calls = 0;
  let connectedHandlers;
  let sourceSnapshot;
  const { dom, box } = mount(
    transportWith(
      async (command) => {
        commands.push(command);
        calls += 1;
        if (calls === 1) throw new Error("response lost");
        return accepted(command);
      },
      (handlers, snapshot) => {
        connectedHandlers = handlers;
        sourceSnapshot = snapshot;
      },
    ),
  );
  await tick();

  const target = { type: "set-model", provider: "fixture", modelId: "model-2" };
  const first = await box.current.submitModelControl(target);
  assert.equal(first.ambiguous, true);
  const metadata = (revision, modelId) => ({
    version: 1,
    type: "operations",
    generation: sourceSnapshot.generation,
    fromRevision: revision - 1,
    revision,
    operations: [
      {
        kind: "metadata",
        metadata: {
          cwd: "/repo",
          home: "/home/test",
          sessionCost: 0,
          model: { provider: "fixture", id: modelId, name: modelId },
          thinkingLevel: "low",
        },
      },
    ],
  });
  connectedHandlers.onEnvelope(metadata(sourceSnapshot.revision + 1, "model-2"));
  connectedHandlers.onEnvelope(metadata(sourceSnapshot.revision + 2, "model-1"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const resubmitted = await box.current.submitModelControl(target);
  assert.equal(resubmitted.accepted, true);
  assert.notEqual(commands[0].commandId, commands[1].commandId);
  render(null, document.querySelector("#app"));
  dom.window.close();
});

test("a non-matching model-control response is ambiguous and reuses the command id", async () => {
  const ids = [];
  let calls = 0;
  const { dom, box } = mount(
    transportWith(async (command) => {
      ids.push(command.commandId);
      calls += 1;
      return calls === 1
        ? { ...accepted(command), commandEpoch: "stale-command-epoch" }
        : accepted(command);
    }),
  );
  await tick();

  const target = { type: "set-thinking", thinkingLevel: "medium" };
  const stale = await box.current.submitModelControl(target);
  const retry = await box.current.submitModelControl(target);

  assert.equal(stale.ambiguous, true);
  assert.match(stale.error, /Stale/);
  assert.equal(retry.accepted, true);
  assert.equal(ids[0], ids[1]);
  render(null, document.querySelector("#app"));
  dom.window.close();
});
