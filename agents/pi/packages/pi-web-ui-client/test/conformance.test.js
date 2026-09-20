import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  applySessionEnvelope,
  createSessionState,
  prependHistoryPage,
} from "../src/client/index.tsx";
import { isImageAttachmentCommandPreflightValid, SessionCommandSchema } from "../src/wire/index.ts";
import {
  coreConformanceScenario,
  createMockIncrementalTransport,
  imageAttachmentCapabilityFixture,
  invalidCoreConformanceFixtures,
  outboundImageAttachmentFixture,
} from "../src/testing/index.ts";

function initialState() {
  const result = createSessionState(coreConformanceScenario().initial);
  assert.equal(result.status, "applied");
  return result.state;
}

test("draft core golden stream reaches each published reducer state", () => {
  const scenario = coreConformanceScenario();
  let result = createSessionState(scenario.initial);
  assert.equal(result.status, "applied");
  let state = result.state;

  for (const step of scenario.steps) {
    result =
      step.reducer === "history"
        ? prependHistoryPage(state, step.input)
        : applySessionEnvelope(state, step.input);
    assert.equal(result.status, "applied", step.name);
    assert.deepEqual(result.state, step.expected, step.name);
    state = result.state;
  }

  assert.equal(scenario.commandOutcomes.accepted.accepted, true);
  assert.equal(scenario.commandOutcomes.rejected.accepted, false);
  assert.equal(scenario.commandOutcomes.completed.status, "completed");
  assert.equal(scenario.commandOutcomes.failed.status, "failed");
});

test("mock transport enforces the reset-varying command scope", async () => {
  const scenario = coreConformanceScenario();
  const transport = createMockIncrementalTransport(scenario.initial);
  const signal = new AbortController().signal;

  transport.emit(scenario.steps[0].input);
  let operationReconnect;
  const disconnectOperation = transport.connect({
    onStatus() {},
    onEnvelope(envelope) {
      operationReconnect = envelope;
    },
  });
  assert.equal(operationReconnect.revision, 4);
  assert.equal(operationReconnect.snapshot.entries.at(-1).id, "entry-3");
  disconnectOperation();

  assert.equal((await transport.submit(scenario.commandCases.beforeReset, signal)).accepted, true);
  const reset = scenario.steps.find((step) => step.input.type === "reset").input;
  transport.emit(reset);
  assert.equal(
    (await transport.submit(scenario.commandCases.staleAfterReset, signal)).accepted,
    false,
  );
  assert.equal((await transport.submit(scenario.commandCases.afterReset, signal)).accepted, true);

  let reconnectSnapshot;
  const disconnect = transport.connect({
    onStatus() {},
    onEnvelope(envelope) {
      reconnectSnapshot = envelope;
    },
  });
  assert.equal(
    reconnectSnapshot.snapshot.commandEpoch,
    scenario.commandCases.afterReset.commandEpoch,
  );
  disconnect();

  transport.emit({
    ...reset,
    revision: reset.revision - 1,
    snapshot: { ...reset.snapshot, commandEpoch: "rejected-stale-epoch" },
  });
  assert.equal((await transport.submit(scenario.commandCases.afterReset, signal)).accepted, true);
});

test("mock transport admits images only under the current advertised capability", async () => {
  const scenario = coreConformanceScenario();
  const transport = createMockIncrementalTransport(scenario.initial);
  const signal = new AbortController().signal;
  let latestSnapshot = scenario.initial;
  transport.connect({
    onStatus() {},
    onEnvelope(envelope) {
      if (envelope.type === "snapshot" || envelope.type === "reset") latestSnapshot = envelope;
    },
  });
  const attachmentCommand = {
    ...scenario.commandCases.beforeReset,
    type: "image-command",
    commandId: "future-image-command",
    attachments: [outboundImageAttachmentFixture()],
  };

  assert.equal(Check(SessionCommandSchema, attachmentCommand), false);
  assert.equal((await transport.submit(attachmentCommand, signal)).accepted, false);
  assert.equal(isImageAttachmentCommandPreflightValid(attachmentCommand, undefined), false);

  const reset = scenario.steps.find((step) => step.input.type === "reset").input;
  transport.emit({
    ...reset,
    snapshot: { ...reset.snapshot, imageAttachments: imageAttachmentCapabilityFixture() },
  });
  const resetScopedCommand = {
    ...attachmentCommand,
    generation: reset.generation,
    commandEpoch: reset.snapshot.commandEpoch,
  };
  assert.equal(
    isImageAttachmentCommandPreflightValid(
      resetScopedCommand,
      latestSnapshot.snapshot.imageAttachments,
    ),
    true,
  );
  assert.equal((await transport.submit(resetScopedCommand, signal)).accepted, true);
});

test("published invalid core fixtures recover with their declared reasons", () => {
  for (const fixture of invalidCoreConformanceFixtures()) {
    const state = initialState();
    const result =
      fixture.reducer === "history"
        ? prependHistoryPage(state, fixture.input)
        : applySessionEnvelope(state, fixture.input);
    assert.equal(result.status, "reset-needed", fixture.name);
    assert.equal(result.reason, fixture.expectedReason, fixture.name);
    assert.equal(result.state, state, fixture.name);
  }
});
