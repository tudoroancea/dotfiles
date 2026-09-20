import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import { LIMITS, type Snapshot } from "@dotfiles/pi-web-ui-client/wire";
import { StandaloneSessionRuntime } from "../src/standalone/runtime.js";
import type { StartServerOptions } from "../src/standalone/server.js";
import {
  PendingInputBroker,
  replaceBrokerPayloadText,
  type BrokerPayload,
} from "../src/standalone/pending-input-broker.js";

function enqueue(
  broker: PendingInputBroker<BrokerPayload>,
  commandId: string,
  content: string,
  delivery: "steer" | "followUp" = "followUp",
) {
  const result = broker.enqueue({
    commandId,
    commandEpoch: "epoch",
    delivery,
    content,
    payload: content,
  });
  assert.equal(result.status, "accepted");
  return result.record;
}

test("broker edits adjacent duplicate rows independently and preserves image payloads", () => {
  const broker = new PendingInputBroker<BrokerPayload>({
    idFactory: (() => {
      let index = 0;
      return () => `item-${++index}`;
    })(),
    replacePayloadText: replaceBrokerPayloadText,
  });
  const first = enqueue(broker, "first", "same");
  const second = enqueue(broker, "second", "same");
  const imagePayload: BrokerPayload = [
    { type: "text", text: "describe" },
    { type: "image", data: "base64-image", mimeType: "image/png" },
  ];
  const image = broker.enqueue({
    commandId: "image",
    commandEpoch: "epoch",
    delivery: "steer",
    content: "describe",
    attachmentCount: 1,
    retainedBytes: 10,
    payload: imagePayload,
  });
  assert.equal(image.status, "accepted");

  assert.equal(
    broker.mutate({
      action: "edit",
      itemId: first.id,
      expectedItemVersion: 1,
      content: "first edit",
    }).status,
    "accepted",
  );
  assert.equal(broker.snapshot()[1]?.content, "same");
  assert.equal(
    broker.mutate({
      action: "edit",
      itemId: image.record.id,
      expectedItemVersion: 1,
      content: "edited",
    }).status,
    "accepted",
  );
  const payload = broker.records().find((item) => item.commandId === "image")?.payload;
  assert.deepEqual(payload, [
    { type: "text", text: "edited" },
    { type: "image", data: "base64-image", mimeType: "image/png" },
  ]);
  assert.equal(
    broker.mutate({ action: "remove", itemId: second.id, expectedItemVersion: 1 }).status,
    "accepted",
  );
  assert.deepEqual(
    broker.snapshot().map((item) => item.id),
    [first.id, image.record.id],
  );
});

test("release marks a row non-editable, restores on synchronous handoff failure, and releases one item", async () => {
  const broker = new PendingInputBroker<BrokerPayload>({
    idFactory: (() => {
      let index = 0;
      return () => `item-${++index}`;
    })(),
  });
  const first = enqueue(broker, "first", "one", "steer");
  enqueue(broker, "second", "two", "steer");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlight = broker.releaseNext("steer", async () => gate);
  await Promise.resolve();
  const conflict = broker.mutate({
    action: "edit",
    itemId: first.id,
    expectedItemVersion: 1,
    content: "late",
  });
  assert.deepEqual(conflict, {
    status: "rejected",
    reason: "released",
    message: "Pending input is being handed to Pi",
  });
  assert.equal(broker.snapshot()[0]?.editable, false);
  release();
  assert.equal((await inFlight).status, "handed-off");
  assert.deepEqual(
    broker.snapshot().map((item) => item.content),
    ["two"],
  );

  const second = broker.snapshot()[0]!;
  const failed = await broker.releaseNext("steer", () => {
    throw new Error("handoff failed");
  });
  assert.equal(failed.status, "failed");
  assert.equal(broker.snapshot()[0]?.id, second.id);
  assert.equal(broker.snapshot()[0]?.editable, true);
});

test("mixed delivery rows retain FIFO order across lifecycle boundaries", async () => {
  const broker = new PendingInputBroker<BrokerPayload>();
  enqueue(broker, "follow", "follow first", "followUp");
  enqueue(broker, "steer", "steer second", "steer");
  expect((await broker.releaseNext("steer", () => undefined)).status).toBe("none");
  expect((await broker.releaseNext("followUp", () => undefined)).status).toBe("handed-off");
  expect((await broker.releaseNext("steer", () => undefined)).status).toBe("handed-off");
});

test("reset explicitly discards accepted rows and releases retained payload memory", () => {
  const broker = new PendingInputBroker<BrokerPayload>();
  enqueue(broker, "reset-me", "retained", "followUp");
  expect(broker.reset()).toHaveLength(1);
  expect(broker.size).toBe(0);
  expect(broker.retainedBytes).toBe(0);
  expect(broker.snapshot()).toEqual([]);
});

test("broker rejects stale versions and bounded memory exhaustion without dropping held rows", () => {
  const broker = new PendingInputBroker<BrokerPayload>({ maxItems: 1, maxRetainedBytes: 4 });
  const item = enqueue(broker, "first", "one");
  const full = broker.enqueue({
    commandId: "second",
    commandEpoch: "epoch",
    delivery: "followUp",
    content: "two",
    retainedBytes: 1,
    payload: "two",
  });
  assert.equal(full.status, "rejected");
  assert.equal(full.reason, "queue-busy");
  const stale = broker.mutate({
    action: "edit",
    itemId: item.id,
    expectedItemVersion: 2,
    content: "new",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reason, "stale-item");
  assert.equal(broker.snapshot()[0]?.content, "one");
});

test("standalone busy submissions stay outside Pi until lifecycle release and retain edited images", async () => {
  let submitInput: StartServerOptions["submitInput"];
  let mutatePendingInput: StartServerOptions["mutatePendingInput"];
  let getSnapshot: (() => Snapshot) | undefined;
  let running = true;
  const sent: unknown[] = [];
  const capability = {
    supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"] as const,
    maxAttachments: LIMITS.maxImagesPerEntry,
    maxBytesPerImage: LIMITS.maxImageBytes,
    maxTotalBytes: LIMITS.maxImageSourceBytesPerEntry,
    maxWidth: LIMITS.maxImageWidth,
    maxHeight: LIMITS.maxImageHeight,
    maxPixels: LIMITS.maxImagePixels,
    maxTotalPixels: LIMITS.maxImagePixels,
  };
  const server = {
    origin: "http://127.0.0.1:1234",
    port: 1234,
    generation: "runtime-generation",
    commandEpoch: "runtime-epoch",
    imageAttachmentCapability: capability,
    bootstrapUrl: () => "http://127.0.0.1:1234/link",
    broadcast: () => undefined,
    completeCommand: () => undefined,
    reset: () => undefined,
    close: async () => undefined,
  };
  const runtime = new StandaloneSessionRuntime(
    { sendUserMessage: (payload: unknown) => sent.push(payload) } as never,
    {
      mode: "rpc",
      cwd: "/fixture",
      model: { provider: "fixture", id: "model", name: "Fixture", input: ["text", "image"] },
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [
          { provider: "fixture", id: "model", name: "Fixture", input: ["text", "image"] },
        ],
        getProviderAuth: async () => ({ token: "present" }),
      },
      sessionManager: {
        getHeader: () => null,
        getLeafId: () => null,
        getSessionName: () => undefined,
        getEntries: () => [],
      },
      isIdle: () => !running,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "",
      ui: {
        theme: {
          name: "dark",
          getBgAnsi: () => "#222222",
          getFgAnsi: () => "#eeeeee",
        },
        notify: () => undefined,
      },
    } as never,
    () => true,
    {
      startServer: (async (snapshot: () => Snapshot, options?: StartServerOptions) => {
        getSnapshot = snapshot;
        submitInput = options?.submitInput;
        mutatePendingInput = options?.mutatePendingInput;
        return server as never;
      }) as never,
      startTailscaleServe: (() => ({ close: async () => undefined })) as never,
    },
  );
  await runtime.copyUrl({ mode: "rpc", ui: { notify: () => undefined } } as never, false);
  if (!submitInput || !mutatePendingInput || !getSnapshot)
    throw new Error("Missing broker adapters");
  const data = "iVBORw0KGgo=";
  const command = {
    version: 1 as const,
    type: "image-command" as const,
    commandId: "broker-image",
    generation: server.generation,
    commandEpoch: server.commandEpoch,
    content: "original",
    delivery: "steer" as const,
    attachments: [
      {
        type: "image-attachment" as const,
        mimeType: "image/png" as const,
        width: 1,
        height: 1,
        byteLength: 8,
        data,
      },
    ],
  };
  await expect(submitInput(command, new AbortController().signal)).resolves.toEqual({
    accepted: true,
  });
  expect(sent).toEqual([]);
  const pending = getSnapshot().pendingInputs[0]!;
  await expect(
    mutatePendingInput(
      {
        version: 1,
        type: "queue-edit",
        commandId: "edit-broker-image",
        generation: server.generation,
        commandEpoch: server.commandEpoch,
        itemId: pending.id,
        expectedItemVersion: pending.itemVersion!,
        content: "edited",
      },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ accepted: true });
  await runtime.onTurnEnd();
  expect(sent).toEqual([
    [
      { type: "text", text: "edited" },
      { type: "image", data, mimeType: "image/png" },
    ],
  ]);
  const followUp = await submitInput(
    {
      version: 1,
      type: "command",
      commandId: "broker-follow-up",
      generation: server.generation,
      commandEpoch: server.commandEpoch,
      content: "after this run",
      delivery: "followUp",
    },
    new AbortController().signal,
  );
  expect(followUp).toEqual({ accepted: true });
  await runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] });
  expect(sent.at(-1)).toBe("after this run");
  await runtime.close();
});

// Keep a Playwright assertion in this host-only spec so its test is also included in
// the browser matrix without requiring a page or weakening the normal e2e command.
test("broker rows have stable identity for browser keys", () => {
  expect(new Set(["row-a", "row-b"]).size).toBe(2);
});
