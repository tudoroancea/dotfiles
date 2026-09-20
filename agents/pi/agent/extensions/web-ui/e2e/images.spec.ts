import { expect, test } from "@playwright/test";
import { LIMITS, type ImageAttachmentCapability } from "@dotfiles/pi-web-ui-client/wire";
import { MAX_IMAGE_COMMAND_BODY_BYTES, MAX_INPUT_BYTES } from "../src/standalone/config.js";
import { ImageResolver } from "../src/standalone/server/images.js";
import { startServer, type Snapshot } from "../src/standalone/server/index.js";
import { OperationJournal } from "../src/standalone/server/journal.js";
import { JournalMetrics } from "../src/standalone/server/metrics.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(kind, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, "ascii"), body])));
  return Buffer.concat([header, body, checksum]);
}

function png(width = 2, height = 3, padding = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.alloc(Math.max(1, padding))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(width = 4, height = 5): Buffer {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height,
    width >> 8,
    width,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, scan, Buffer.from([0xff, 0xd9])]);
}

const STATIC_WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==", "base64");

test("image command reader admits the worst-case bounded JSON representation", () => {
  const worstCase =
    Math.ceil(LIMITS.maxImageSourceBytesPerEntry / 3) * 4 +
    LIMITS.maxImagesPerEntry * 4 +
    MAX_INPUT_BYTES * 6 +
    LIMITS.maxImagesPerEntry * 512 +
    4 * 1024;
  expect(MAX_IMAGE_COMMAND_BODY_BYTES).toBe(worstCase);
});

function webpChunk(kind: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(kind, 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, ...(body.length & 1 ? [Buffer.alloc(1)] : [])]);
}

function webpRiff(...chunks: Buffer[]): Buffer {
  const result = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP", "binary"), ...chunks]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function extendedWebp(
  width: number,
  height: number,
  payload: Buffer<ArrayBufferLike> = STATIC_WEBP.subarray(12),
): Buffer {
  const body = Buffer.alloc(10);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return webpRiff(webpChunk("VP8X", body), payload);
}

function webpWithFrameDimensions(width: number, height: number): Buffer {
  const body = Buffer.alloc(5);
  body[0] = 0x2f;
  body.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return webpRiff(webpChunk("VP8L", body));
}

function image(data: Buffer, mimeType: string): Record<string, unknown> {
  return { type: "image", mimeType, data: data.toString("base64") };
}

function projectedBlock(resolver: ImageResolver, block: unknown): Record<string, unknown> {
  const projected = resolver.project({ content: [block] }).payload as {
    content: Array<Record<string, unknown>>;
  };
  return projected.content[0];
}

test("validates PNG, JPEG, and non-animated WebP and substitutes every legacy block", () => {
  const resolver = new ImageResolver("image-test-generation");
  for (const [content, mimeType, dimensions] of [
    [png(), "image/png", [2, 3]],
    [jpeg(), "image/jpeg", [4, 5]],
    [STATIC_WEBP, "image/webp", [1, 1]],
  ] as const) {
    const block = projectedBlock(resolver, image(content, mimeType));
    expect(block).toMatchObject({
      type: "image-reference",
      mimeType,
      width: dimensions[0],
      height: dimensions[1],
      byteLength: content.length,
    });
    expect(JSON.stringify(block)).not.toContain("base64");
    expect(JSON.stringify(block)).not.toContain(content.toString("base64"));
  }
  expect(projectedBlock(resolver, { type: "image", url: "https://secret.invalid/a.png" })).toEqual({
    type: "image-omission",
    reason: "invalid-data",
  });
  expect(
    projectedBlock(resolver, { type: "image-reference", id: "forged", url: "file:///tmp/a" }),
  ).toEqual({
    type: "image-omission",
    reason: "invalid-data",
  });

  const omissionWithToJson = Object.assign(
    Object.create({
      toJSON: () => ({ type: "image", data: "secret-base64", source: "file:///tmp/secret" }),
    }),
    { type: "image-omission", reason: "unsupported-format" },
  );
  expect(projectedBlock(resolver, omissionWithToJson)).toEqual({
    type: "image-omission",
    reason: "invalid-data",
  });

  const wrapped = resolver.project({
    toJSON: () => ({
      content: [image(png(), "image/png")],
      source: undefined,
    }),
  }).payload as { content: Array<Record<string, unknown>> };
  expect(wrapped.content[0].type).toBe("image-reference");
  expect(JSON.stringify(wrapped)).not.toContain('"type":"image"');
  expect(JSON.stringify(wrapped)).not.toContain('"data"');
});

test("rejects malformed, mismatched, unsupported, animated, bomb-style, and bounded images", () => {
  const resolver = new ImageResolver("image-bound-generation");
  const cases: Array<[unknown, string]> = [
    [{ type: "image", mimeType: "image/png", data: "!not-base64!" }, "invalid-data"],
    [image(png(), "image/jpeg"), "signature-mismatch"],
    [image(Buffer.from("GIF89a"), "image/gif"), "unsupported-format"],
    [image(Buffer.from("<svg/>"), "image/svg+xml"), "unsupported-format"],
    [
      image(
        (() => {
          const animatedHeader = Buffer.alloc(10);
          animatedHeader[0] = 0x02;
          return webpRiff(webpChunk("VP8X", animatedHeader), STATIC_WEBP.subarray(12));
        })(),
        "image/webp",
      ),
      "animated-image",
    ],
    [image(webpRiff(webpChunk("VP8X", Buffer.alloc(10))), "image/webp"), "invalid-data"],
    [
      image(extendedWebp(1, 1, webpWithFrameDimensions(8192, 8192).subarray(12)), "image/webp"),
      "invalid-data",
    ],
    [
      image(webpRiff(STATIC_WEBP.subarray(12), STATIC_WEBP.subarray(12)), "image/webp"),
      "invalid-data",
    ],
    [image(webpWithFrameDimensions(8192, 8192), "image/webp"), "pixels-exceeded"],
    [image(png(LIMITS.maxImageWidth + 1, 1), "image/png"), "dimensions-exceeded"],
    [image(png(7000, 7000), "image/png"), "pixels-exceeded"],
    [
      {
        type: "image",
        mimeType: "image/png",
        data: "A".repeat(Math.ceil(LIMITS.maxImageBytes / 3) * 4 + 8),
      },
      "image-too-large",
    ],
  ];
  for (const [block, reason] of cases)
    expect(projectedBlock(resolver, block)).toEqual({ type: "image-omission", reason });

  const many = Array.from({ length: LIMITS.maxImagesPerEntry + 1 }, () =>
    image(png(), "image/png"),
  );
  const projected = resolver.project({ content: many }).payload as {
    content: Array<Record<string, unknown>>;
  };
  expect(projected.content).toHaveLength(LIMITS.maxImagesPerEntry + 1);
  expect(projected.content.at(-1)).toEqual({ type: "image-omission", reason: "count-exceeded" });
  expect(
    projected.content.filter(
      (block) => block.type === "image-omission" && block.reason === "count-exceeded",
    ),
  ).toHaveLength(1);

  for (const input of [
    Array.from({ length: 20 }, () => ({ type: "image-reference", id: "forged" })),
    Array.from({ length: 20 }, () => ({ type: "image-omission", reason: "invalid-data" })),
  ]) {
    const bounded = (
      resolver.project({ content: input }).payload as {
        content: Array<Record<string, unknown>>;
      }
    ).content;
    expect(bounded).toHaveLength(LIMITS.maxImagesPerEntry + 1);
    expect(bounded.at(-1)).toEqual({ type: "image-omission", reason: "count-exceeded" });
    expect(bounded.filter((block) => block.reason === "count-exceeded")).toHaveLength(1);
  }

  const large = image(png(2, 2, 3 * 1024 * 1024), "image/png");
  const aggregate = resolver.project({ content: [large, large] }).payload as {
    content: Array<Record<string, unknown>>;
  };
  expect(aggregate.content.at(-1)).toEqual({
    type: "image-omission",
    reason: "aggregate-bytes-exceeded",
  });
});

test("uses stable deduplicated generation-scoped references and fresh per-entry budgets", () => {
  const resolver = new ImageResolver("image-stability-generation");
  const source = image(png(), "image/png");
  const first = projectedBlock(resolver, source);
  for (let index = 0; index < 20; index += 1)
    expect(projectedBlock(resolver, source)).toEqual(first);
  const replacementGeneration = new ImageResolver("replacement-image-generation");
  const replacement = projectedBlock(replacementGeneration, source);
  expect(replacement.id).not.toBe(first.id);
  expect(replacementGeneration.acquire(String(first.id)).status).toBe("unknown");

  const fullEntry = Array.from({ length: LIMITS.maxImagesPerEntry }, () => source);
  for (let index = 0; index < 3; index += 1) {
    const content = (resolver.project({ content: fullEntry }).payload as { content: unknown[] })
      .content;
    expect(content.every((block) => (block as { type: string }).type === "image-reference")).toBe(
      true,
    );
  }
});

test("unchanged live image projection keeps identity without operation churn", () => {
  const liveEntry = {
    id: "live-image",
    type: "message",
    message: { role: "user", content: [image(png(), "image/png")] },
  };
  const snapshot: Snapshot = {
    header: { id: "live-image-session" },
    leafId: null,
    isRunning: true,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const journal = new OperationJournal(
    {
      getSnapshot: () => snapshot,
      getPersistedEntries: () => [],
      getLiveEntries: () => [liveEntry],
    },
    new JournalMetrics(),
  );
  const initial = journal.snapshotEnvelope();
  expect(initial?.type).toBe("snapshot");
  if (initial?.type !== "snapshot") throw new Error("Expected snapshot");
  const initialBlock = (
    initial.snapshot.liveTail[0].payload as {
      message: { content: Array<{ id?: string }> };
    }
  ).message.content[0];
  const emitted: string[] = [];
  journal.subscribe((envelope) => emitted.push(envelope.type));
  for (let index = 0; index < 20; index += 1) journal.observe();
  expect(emitted).toEqual([]);
  expect(journal.revision).toBe(0);
  const acquired = journal.images.acquire(initialBlock.id!);
  expect(acquired.status).toBe("found");
  if (acquired.status === "found") journal.images.releaseResponse();
});

test("bounds retained image count independently from bytes", () => {
  const resolver = new ImageResolver("image-count-generation");
  const references = Array.from({ length: LIMITS.maxRetainedImageCount + 1 }, (_, index) =>
    projectedBlock(resolver, image(png(2, 2, index + 1), "image/png")),
  );
  expect(resolver.acquire(String(references[0].id)).status).toBe("evicted");
  const newest = resolver.acquire(String(references.at(-1)!.id));
  expect(newest.status).toBe("found");
  if (newest.status === "found") resolver.releaseResponse();
});

test("bounds retained bytes and concurrent responses with explicit eviction", () => {
  const resolver = new ImageResolver("image-resolver-generation");
  const references = Array.from({ length: 9 }, (_, index) =>
    projectedBlock(resolver, image(png(2, 2, 4 * 1024 * 1024 + index), "image/png")),
  );
  expect(resolver.acquire(String(references[0].id)).status).toBe("evicted");
  const currentId = String(references.at(-1)!.id);
  const acquired = Array.from({ length: LIMITS.maxConcurrentImageResponses }, () =>
    resolver.acquire(currentId),
  );
  expect(acquired.every((value) => value.status === "found")).toBe(true);
  expect(resolver.acquire(currentId).status).toBe("busy");
  for (const value of acquired) if (value.status === "found") resolver.releaseResponse();
  expect(resolver.acquire("unknown-keyed-reference").status).toBe("unknown");
});

test("substitutes images before snapshot, append, history, and reset envelopes are bounded", () => {
  const entries = Array.from({ length: 205 }, (_, index) => ({
    id: `projected-${index}`,
    type: "message",
    message: {
      role: "user",
      content:
        index === 0
          ? [{ type: "image", mimeType: "image/png", data: "malformed" }]
          : index === 203
            ? [image(png(), "image/png")]
            : index === 204
              ? [image(png(7000, 7000), "image/png")]
              : [{ type: "text", text: `entry ${index}` }],
    },
  }));
  const snapshot: Snapshot = {
    header: { id: "projection-images" },
    leafId: "projected-204",
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries,
  };
  const journal = new OperationJournal(
    { getSnapshot: () => snapshot, getPersistedEntries: () => entries },
    new JournalMetrics(),
  );
  const initial = journal.snapshotEnvelope();
  expect(initial?.type).toBe("snapshot");
  if (initial?.type !== "snapshot") throw new Error("Expected snapshot");
  const initialWire = JSON.stringify(initial);
  expect(initialWire).not.toContain('"type":"image"');
  expect(initialWire).not.toContain('"data"');
  expect(initialWire).toContain('"type":"image-reference"');
  expect(initialWire).toContain('"type":"image-omission","reason":"pixels-exceeded"');

  const cursor = initial.snapshot.history.beforeCursor;
  expect(cursor).not.toBeNull();
  const history = journal.historyPage({
    version: 1,
    type: "history-request",
    generation: journal.generation,
    revision: journal.revision,
    historyGeneration: initial.snapshot.history.historyGeneration,
    beforeCursor: cursor!,
    beforeId: "projected-5",
    limit: 5,
  });
  expect(JSON.stringify(history)).toContain('"type":"image-omission","reason":"invalid-data"');
  expect(JSON.stringify(history)).not.toContain('"data"');

  let appendedWire = "";
  let resetWire = "";
  journal.subscribe((envelope) => {
    if (envelope.type === "operations") appendedWire = JSON.stringify(envelope);
    if (envelope.type === "reset") resetWire = JSON.stringify(envelope);
  });
  entries.push({
    id: "projected-205",
    type: "message",
    message: {
      role: "user",
      content: [
        {
          type: "image-reference",
          id: "a".repeat(43),
          mimeType: "image/png",
          width: LIMITS.maxImageWidth,
          height: LIMITS.maxImageHeight,
          byteLength: 1,
        },
      ],
    },
  });
  snapshot.leafId = "projected-205";
  journal.observe();
  expect(appendedWire).toContain('"type":"image-omission","reason":"invalid-data"');
  expect(appendedWire).not.toContain('"data"');

  journal.forceReset("image projection reset");
  expect(resetWire).toContain('"type":"image-reference"');
  expect(resetWire).toContain('"type":"image-omission","reason":"pixels-exceeded"');
  expect(resetWire).not.toContain('"data"');
});

const ATTACHMENT_CAPABILITY: ImageAttachmentCapability = {
  supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxAttachments: 3,
  maxBytesPerImage: 1024,
  maxTotalBytes: 2048,
  maxWidth: 1024,
  maxHeight: 1024,
  maxPixels: 1_000_000,
  maxTotalPixels: 1_500_000,
};

function snapshotWithImage(): Snapshot {
  return {
    header: { id: "image-endpoint" },
    leafId: "image-entry",
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [
      {
        id: "image-entry",
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              mimeType: "image/webp",
              data: STATIC_WEBP.toString("base64"),
            },
          ],
        },
      },
    ],
  };
}

test("picker, paste, and drop preserve image drafts until authoritative acceptance", async ({
  browser,
}) => {
  let accepted = false;
  const admitted: unknown[] = [];
  const snapshot: Snapshot = {
    header: { id: "attachment-composer" },
    imageAttachments: ATTACHMENT_CAPABILITY,
    leafId: null,
    isRunning: false,
    systemPrompt: "",
    pendingInputs: [],
    entries: [],
  };
  const server = await startServer(() => snapshot, {
    submitInput: async (command) => {
      admitted.push(command);
      return accepted ? { accepted: true } : { accepted: false, error: "Host rejected image" };
    },
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const file = {
    name: "pixel.webp",
    mimeType: "image/webp",
    buffer: STATIC_WEBP,
  };
  try {
    await page.goto(server.bootstrapUrl());
    const [attachBounds, sendBounds] = await Promise.all([
      page.getByRole("button", { name: "Add image" }).boundingBox(),
      page.getByRole("button", { name: "Send message" }).boundingBox(),
    ]);
    expect(attachBounds).not.toBeNull();
    expect(sendBounds).not.toBeNull();
    expect(Math.abs(attachBounds!.y - sendBounds!.y)).toBeLessThan(1);
    expect(attachBounds!.height).toBe(sendBounds!.height);

    await page.locator(".composer-file-input").setInputFiles(file);
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove image 1" }).click();
    await expect(page.locator(".composer-attachment")).toHaveCount(0);

    await page.evaluate((encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "pasted.webp", { type: "image/webp" }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      document.querySelector(".composer-input")?.dispatchEvent(event);
    }, STATIC_WEBP.toString("base64"));
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove image 1" }).click();

    const mixedPastePreserved = await page.evaluate((encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add("keep this text", "text/plain");
      transfer.items.add(new File([bytes], "mixed.webp", { type: "image/webp" }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      return document.querySelector(".composer-input")?.dispatchEvent(event);
    }, STATIC_WEBP.toString("base64"));
    expect(mixedPastePreserved).toBe(true);
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove image 1" }).click();

    await page.evaluate((maxAttachments) => {
      const transfer = new DataTransfer();
      for (let index = 0; index < maxAttachments + 1; index += 1)
        transfer.items.add(new File(["corrupt"], `corrupt-${index}.webp`, { type: "image/webp" }));
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      document.querySelector(".composer")?.dispatchEvent(event);
    }, ATTACHMENT_CAPABILITY.maxAttachments);
    await expect(page.locator(".composer-notice")).toContainText("Too many images");
    await expect(page.locator(".composer-attachment")).toHaveCount(0);

    await page.evaluate((encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      const slow = new File([bytes], "slow.webp", { type: "image/webp" });
      Object.defineProperty(slow, "arrayBuffer", {
        value: () => new Promise((resolve) => setTimeout(() => resolve(bytes.buffer), 100)),
      });
      const first = new DataTransfer();
      first.items.add(slow);
      const firstEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(firstEvent, "dataTransfer", { value: first });
      document.querySelector(".composer")?.dispatchEvent(firstEvent);
      const second = new DataTransfer();
      second.items.add(new File([bytes], "queued.webp", { type: "image/webp" }));
      const secondEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(secondEvent, "dataTransfer", { value: second });
      document.querySelector(".composer")?.dispatchEvent(secondEvent);
    }, STATIC_WEBP.toString("base64"));
    await expect(page.locator(".composer-notice")).toContainText("current images");
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove image 1" }).click();

    await page.evaluate((encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "dropped.webp", { type: "image/webp" }));
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      document.querySelector(".composer")?.dispatchEvent(event);
    }, STATIC_WEBP.toString("base64"));
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    await page.getByRole("textbox", { name: "Message" }).fill("describe this");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("describe this");
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    await expect(page.locator(".composer-notice")).toContainText("Host rejected image");

    accepted = true;
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
    await expect(page.locator(".composer-attachment")).toHaveCount(0);
    expect(admitted).toHaveLength(2);
    expect(
      admitted.every((command) => (command as { type: string }).type === "image-command"),
    ).toBe(true);

    const malformed = await page.evaluate(
      async ({ generation, commandEpoch, data, byteLength }) => {
        const response = await fetch("input-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: 1,
            type: "image-command",
            commandId: "mismatched-dimensions",
            generation,
            commandEpoch,
            content: "bad declaration",
            delivery: "immediate",
            attachments: [
              {
                type: "image-attachment",
                mimeType: "image/webp",
                width: 2,
                height: 1,
                byteLength,
                data,
              },
            ],
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      {
        generation: server.generation,
        commandEpoch: server.commandEpoch,
        data: STATIC_WEBP.toString("base64"),
        byteLength: STATIC_WEBP.length,
      },
    );
    expect(malformed.status).toBe(409);
    expect(malformed.body.error).toContain("declared-dimensions-mismatch");
    expect(admitted).toHaveLength(2);
  } finally {
    await context.close();
    await server.close();
  }
});

test("image load failures remain visible with a keyboard-accessible retry", async ({ browser }) => {
  const server = await startServer(snapshotWithImage);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route("**/image/**", (route) => route.abort());
    await page.goto(server.bootstrapUrl());
    const status = page.getByRole("status").filter({ hasText: "failed to load or decode" });
    await expect(status).toBeVisible();
    const frame = status.locator("xpath=..");
    const bounds = await frame.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(240);
    expect(bounds?.height).toBeGreaterThanOrEqual(88);
    await expect(frame).toHaveAttribute("role", "group");
    const failedImage = status.getByRole("img", { name: "Image failed to load" });
    await expect(failedImage).toBeVisible();
    const retry = status.getByRole("button", { name: "Retry" });
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.unrouteAll({ behavior: "wait" });
    await retry.press("Enter");
    await expect(status).toHaveCount(0);
    const loaded = page.getByRole("img", { name: "Attached image" });
    await expect(loaded).toHaveJSProperty("naturalWidth", 1);
    const loadedBounds = await loaded.locator("xpath=..").boundingBox();
    expect(loadedBounds?.height).toBeLessThan(bounds!.height);
  } finally {
    await context.close();
    await server.close();
  }
});

test("serves image bytes only to authenticated same-origin clients with strict headers", async ({
  browser,
}) => {
  const server = await startServer(snapshotWithImage);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(server.bootstrapUrl());
    const element = page.getByRole("img", { name: "Attached image" });
    await expect(element).toHaveCount(1);
    await expect(element).toHaveJSProperty("naturalWidth", 1);
    await expect(element).toHaveJSProperty("naturalHeight", 1);
    const src = await element.getAttribute("src");
    expect(src).toMatch(/^image\/[A-Za-z0-9_-]+$/);
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        length: response.headers.get("content-length"),
        cache: response.headers.get("cache-control"),
        nosniff: response.headers.get("x-content-type-options"),
        resourcePolicy: response.headers.get("cross-origin-resource-policy"),
        bytes: (await response.arrayBuffer()).byteLength,
      };
    }, src!);
    expect(result).toEqual({
      status: 200,
      type: "image/webp",
      length: result.bytes.toString(),
      cache: "private, max-age=31536000, immutable",
      nosniff: "nosniff",
      resourcePolicy: "same-origin",
      bytes: result.bytes,
    });

    const headerless = await context.request.get(new URL(src!, server.url).href);
    expect(headerless.status()).toBe(200);

    const unknown = await page.evaluate(async () => {
      const response = await fetch("image/unknown-reference");
      return { status: response.status, cache: response.headers.get("cache-control") };
    });
    expect(unknown).toEqual({ status: 404, cache: "no-store" });

    const foreign = await context.request.get(new URL(src!, server.url).href, {
      headers: { Origin: "https://example.invalid" },
    });
    expect(foreign.status()).toBe(403);
    const tailscaleOrigin = "https://fixture.tailnet.ts.net";
    server.bootstrapUrl(tailscaleOrigin);
    const proxied = await context.request.get(new URL(src!, server.url).href, {
      headers: { Origin: tailscaleOrigin },
    });
    expect(proxied.status()).toBe(200);
    expect(foreign.headers()["x-content-type-options"]).toBe("nosniff");
    const crossSite = await context.request.get(new URL(src!, server.url).href, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status()).toBe(403);
    const isolated = await browser.newContext();
    try {
      const unauthenticated = await isolated.request.get(new URL(src!, server.url).href, {
        headers: { Origin: server.origin },
      });
      expect(unauthenticated.status()).toBe(401);
    } finally {
      await isolated.close();
    }
  } finally {
    await context.close();
    await server.close();
  }
});
