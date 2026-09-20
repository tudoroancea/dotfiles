import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockIncrementalTransport, sessionSnapshotFixture } from "../src/testing/index.ts";

const signal = new AbortController().signal;

function controlBase(snapshot) {
  return {
    version: 1,
    commandId: "model-control-1",
    generation: snapshot.generation,
    commandEpoch: snapshot.snapshot.commandEpoch,
  };
}

test("mock transport admits only advertised model controls without changing metadata", async () => {
  const snapshot = sessionSnapshotFixture();
  snapshot.snapshot.metadata = {
    cwd: "/repo",
    home: "/home/test",
    sessionCost: 0,
    model: { provider: "fixture", id: "model-1", name: "Fixture Model" },
    thinkingLevel: "medium",
  };
  const transport = createMockIncrementalTransport(snapshot);
  let latest;
  transport.connect({ onEnvelope: (envelope) => (latest = envelope), onStatus() {} });

  const setModel = await transport.submitModelControl(
    {
      ...controlBase(snapshot),
      type: "set-model",
      provider: "fixture",
      modelId: "model-2",
    },
    signal,
  );
  assert.equal(setModel.accepted, true);
  const setThinking = await transport.submitModelControl(
    {
      ...controlBase(snapshot),
      commandId: "model-control-2",
      type: "set-thinking",
      thinkingLevel: "high",
    },
    signal,
  );
  assert.equal(setThinking.accepted, true);
  assert.equal(latest.snapshot.metadata.model.id, "model-1");
  assert.equal(latest.snapshot.metadata.thinkingLevel, "medium");

  const unavailable = await transport.submitModelControl(
    {
      ...controlBase(snapshot),
      commandId: "model-control-3",
      type: "set-model",
      provider: "fixture",
      modelId: "unadvertised",
    },
    signal,
  );
  assert.equal(unavailable.accepted, false);
  assert.equal(unavailable.reason, "invalid");
});

test("mock transport rejects a capability with duplicate provider and model identity", async () => {
  const snapshot = sessionSnapshotFixture();
  const transport = createMockIncrementalTransport(snapshot);
  snapshot.snapshot.modelControl.models[1] = {
    ...snapshot.snapshot.modelControl.models[0],
    name: "Duplicate identity",
  };
  const response = await transport.submitModelControl(
    {
      ...controlBase(snapshot),
      type: "set-model",
      provider: "fixture",
      modelId: "model-1",
    },
    signal,
  );
  assert.equal(response.accepted, false);
  assert.equal(response.reason, "invalid");
});

test("mock transport rejects model controls when capability is absent", async () => {
  const snapshot = sessionSnapshotFixture();
  delete snapshot.snapshot.modelControl;
  const transport = createMockIncrementalTransport(snapshot);
  const response = await transport.submitModelControl(
    { ...controlBase(snapshot), type: "set-thinking", thinkingLevel: "high" },
    signal,
  );
  assert.equal(response.accepted, false);
  assert.equal(response.reason, "capability-off");
});
