import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  ImageAttachmentCapabilitySchema,
  ImageAttachmentCommandSchema,
  ImageOmissionReasonSchema,
  ImageOmissionSchema,
  ImageReferenceSchema,
  inspectRasterImage,
  isImageAttachmentCommandPreflightValid,
  isImageReference,
  LIMITS,
  OutboundImageAttachmentSchema,
  RemoteImageBlockSchema,
  SessionCommandSchema,
} from "../src/wire/index.ts";
import {
  imageAttachmentCapabilityFixture,
  outboundImageAttachmentFixture,
  sessionSnapshotFixture,
} from "../src/testing/index.ts";
import { images } from "../src/client/format.ts";

const reference = {
  type: "image-reference",
  id: "a".repeat(46),
  mimeType: "image/png",
  width: 640,
  height: 480,
  byteLength: 1024,
};

const reasons = [
  "invalid-data",
  "unsupported-format",
  "signature-mismatch",
  "animated-image",
  "image-too-large",
  "dimensions-exceeded",
  "pixels-exceeded",
  "count-exceeded",
  "aggregate-bytes-exceeded",
];

test("remote image DTOs are strict, bounded, and schema-derived", () => {
  assert.equal(LIMITS.maxImagesPerEntry, 8);
  assert.equal(LIMITS.maxImageSourceBytesPerEntry, 5 * 1024 * 1024);
  assert.equal(LIMITS.maxImageBytes, 5 * 1024 * 1024);
  assert.ok(Check(ImageReferenceSchema, reference));
  assert.ok(Check(RemoteImageBlockSchema, reference));
  assert.ok(isImageReference(reference));
  for (const reason of reasons) {
    assert.ok(Check(ImageOmissionReasonSchema, reason), reason);
    assert.ok(Check(ImageOmissionSchema, { type: "image-omission", reason }), reason);
  }
  const overPixelReference = {
    ...reference,
    width: LIMITS.maxImageWidth,
    height: LIMITS.maxImageHeight,
  };
  assert.ok(
    Check(ImageReferenceSchema, overPixelReference),
    "structural schema remains composable",
  );
  assert.equal(isImageReference(overPixelReference), false, "semantic decoder enforces pixel area");

  for (const value of [
    { ...reference, id: "short" },
    { ...reference, id: "a".repeat(LIMITS.maxImageIdChars + 1) },
    { ...reference, id: `${"a".repeat(40)}.` },
    { ...reference, mimeType: "image/gif" },
    { ...reference, width: 0 },
    { ...reference, width: LIMITS.maxImageWidth + 1 },
    { ...reference, height: LIMITS.maxImageHeight + 1 },
    { ...reference, byteLength: LIMITS.maxImageBytes + 1 },
    { ...reference, source: "file:///secret.png" },
    { type: "image-omission", reason: "other" },
    { type: "image-omission", reason: reasons[0], detail: "leak" },
  ]) {
    assert.equal(Check(RemoteImageBlockSchema, value), false, JSON.stringify(value));
  }
});

test("image command preflight is strict, bounded, capability-scoped, and not text admission", () => {
  const capability = imageAttachmentCapabilityFixture();
  const attachment = outboundImageAttachmentFixture();
  const snapshot = sessionSnapshotFixture();
  const command = {
    version: 1,
    type: "image-command",
    commandId: "image-command",
    generation: snapshot.generation,
    commandEpoch: snapshot.snapshot.commandEpoch,
    content: "image",
    delivery: "immediate",
    attachments: [attachment],
  };

  assert.equal(Buffer.from(attachment.data, "base64").byteLength, 68);
  assert.ok(Check(ImageAttachmentCapabilitySchema, capability));
  assert.ok(Check(OutboundImageAttachmentSchema, attachment));
  assert.ok(Check(ImageAttachmentCommandSchema, command));
  assert.equal(Check(SessionCommandSchema, command), false, "current host route rejects the DTO");
  assert.ok(isImageAttachmentCommandPreflightValid(command, capability));
  assert.equal(
    isImageAttachmentCommandPreflightValid(command, undefined),
    false,
    "absence means unsupported",
  );
  assert.equal(
    isImageAttachmentCommandPreflightValid(command, {
      ...capability,
      supportedMimeTypes: ["image/jpeg"],
    }),
    false,
  );

  for (const invalid of [
    { ...attachment, data: "A===-" },
    { ...attachment, data: `${attachment.data}\n` },
    { ...attachment, data: "AB==", byteLength: 1 },
    { ...attachment, byteLength: 67 },
    { ...attachment, width: capability.maxWidth + 1 },
    { ...attachment, height: capability.maxHeight + 1 },
    { ...attachment, extra: true },
    { ...attachment, type: "image-reference", id: "a".repeat(46) },
  ]) {
    assert.equal(
      isImageAttachmentCommandPreflightValid({ ...command, attachments: [invalid] }, capability),
      false,
    );
  }

  assert.equal(
    isImageAttachmentCommandPreflightValid(
      { ...command, attachments: [{ ...attachment, width: 1001, height: 1000 }] },
      capability,
    ),
    false,
    "per-image pixel overflow",
  );
  assert.equal(
    isImageAttachmentCommandPreflightValid(
      { ...command, attachments: [attachment, attachment, attachment] },
      { ...capability, maxTotalBytes: 2 * attachment.byteLength },
    ),
    false,
    "aggregate byte overflow",
  );
  assert.equal(
    isImageAttachmentCommandPreflightValid(
      {
        ...command,
        attachments: [
          { ...attachment, width: 800, height: 800 },
          { ...attachment, width: 800, height: 800 },
        ],
      },
      { ...capability, maxTotalPixels: 1_000_000 },
    ),
    false,
    "aggregate declared-pixel preflight overflow",
  );
  assert.equal(Check(ImageAttachmentCommandSchema, { ...command, attachments: [] }), false);
  for (const invalidCapability of [
    { ...capability, maxAttachments: LIMITS.maxImagesPerEntry + 1 },
    { ...capability, maxBytesPerImage: LIMITS.maxImageBytes + 1 },
    { ...capability, maxTotalBytes: LIMITS.maxImageSourceBytesPerEntry + 1 },
    { ...capability, maxTotalPixels: LIMITS.maxImagePixels + 1 },
  ]) {
    assert.equal(Check(ImageAttachmentCapabilitySchema, invalidCapability), false);
  }
});

function pngCrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(kind, data = Buffer.alloc(0)) {
  const type = Buffer.from(kind, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc(Buffer.concat([type, data])), 8 + data.length);
  return chunk;
}

function webpChunk(kind, data) {
  const header = Buffer.alloc(8);
  header.write(kind, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.alloc(1)] : [])]);
}

function webp(...chunks) {
  const value = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP", "binary"), ...chunks]);
  value.writeUInt32LE(value.length - 8, 4);
  return value;
}

const losslessWebp = () => webp(webpChunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0])));
const lossyWebpChunk = () => {
  const value = Buffer.alloc(10);
  value.set([0x9d, 0x01, 0x2a], 3);
  value.writeUInt16LE(1, 6);
  value.writeUInt16LE(1, 8);
  return webpChunk("VP8 ", value);
};
const vp8x = (flags = 0, reserved = 0) => {
  const value = Buffer.alloc(10);
  value[0] = flags;
  value[1] = reserved;
  return webpChunk("VP8X", value);
};

test("shared raster inspection authoritatively validates dimensions and signatures", () => {
  const attachment = outboundImageAttachmentFixture();
  const bytes = Buffer.from(attachment.data, "base64");
  assert.deepEqual(inspectRasterImage(bytes, "image/png"), {
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  assert.equal(inspectRasterImage(bytes, "image/jpeg"), "signature-mismatch");
  assert.equal(inspectRasterImage(Buffer.from("GIF89a"), "image/gif"), "unsupported-format");
  assert.equal(inspectRasterImage(bytes.subarray(0, 24), "image/png"), "invalid-data");

  const animated = Buffer.concat([
    bytes.subarray(0, 33),
    pngChunk("acTL", Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
    bytes.subarray(33),
  ]);
  assert.equal(inspectRasterImage(animated, "image/png"), "animated-image");

  const metadataOnly = Buffer.concat([bytes.subarray(0, 33), bytes.subarray(-12)]);
  assert.equal(inspectRasterImage(metadataOnly, "image/png"), "invalid-data");
  const corruptCrc = Buffer.from(bytes);
  corruptCrc[corruptCrc.length - 5] ^= 1;
  assert.equal(inspectRasterImage(corruptCrc, "image/png"), "invalid-data");
  const nonemptyEnd = Buffer.concat([bytes.subarray(0, -12), pngChunk("IEND", Buffer.from([0]))]);
  assert.equal(inspectRasterImage(nonemptyEnd, "image/png"), "invalid-data");

  const metadataOnlyJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff,
    0xd9,
  ]);
  assert.equal(inspectRasterImage(metadataOnlyJpeg, "image/jpeg"), "invalid-data");

  const simple = losslessWebp();
  assert.deepEqual(inspectRasterImage(simple, "image/webp"), {
    mimeType: "image/webp",
    width: 1,
    height: 1,
  });
  assert.deepEqual(inspectRasterImage(webp(vp8x(), simple.subarray(12)), "image/webp"), {
    mimeType: "image/webp",
    width: 1,
    height: 1,
  });
  assert.deepEqual(
    inspectRasterImage(
      webp(vp8x(0x10), webpChunk("ALPH", Buffer.from([0, 0])), lossyWebpChunk()),
      "image/webp",
    ),
    { mimeType: "image/webp", width: 1, height: 1 },
  );
  const versionedLossless = Buffer.from(simple);
  versionedLossless[24] |= 0xe0;
  for (const malformed of [
    webp(simple.subarray(12), vp8x()),
    webp(vp8x(0x01), simple.subarray(12)),
    webp(vp8x(0, 1), simple.subarray(12)),
    webp(vp8x(0x20), simple.subarray(12)),
    webp(vp8x(), webpChunk("EXIF", Buffer.from([1])), simple.subarray(12)),
    webp(vp8x(), simple.subarray(12), webpChunk("JUNK", Buffer.from([1]))),
    versionedLossless,
    webp(vp8x(0x10), webpChunk("ALPH", Buffer.from([0x01, 0])), lossyWebpChunk()),
    webp(vp8x(0x10), webpChunk("ALPH", Buffer.from([0x20, 0])), lossyWebpChunk()),
    webp(vp8x(0x10), webpChunk("ALPH", Buffer.from([0x40, 0])), lossyWebpChunk()),
  ]) {
    assert.equal(inspectRasterImage(malformed, "image/webp"), "invalid-data");
  }
});

test("attachment preflight accepts established absolute boundaries", () => {
  const attachment = {
    ...outboundImageAttachmentFixture(),
    width: LIMITS.maxImageWidth,
    height: 1,
  };
  const capability = {
    supportedMimeTypes: ["image/png"],
    maxAttachments: LIMITS.maxImagesPerEntry,
    maxBytesPerImage: LIMITS.maxImageBytes,
    maxTotalBytes: LIMITS.maxImageSourceBytesPerEntry,
    maxWidth: LIMITS.maxImageWidth,
    maxHeight: LIMITS.maxImageHeight,
    maxPixels: LIMITS.maxImagePixels,
    maxTotalPixels: LIMITS.maxImagePixels,
  };
  const snapshot = sessionSnapshotFixture();
  assert.ok(
    isImageAttachmentCommandPreflightValid(
      {
        version: 1,
        type: "image-command",
        commandId: "boundary",
        generation: snapshot.generation,
        commandEpoch: snapshot.snapshot.commandEpoch,
        content: "",
        delivery: "followUp",
        attachments: [attachment],
      },
      capability,
    ),
  );
});

test("image extraction visibly omits malformed, legacy, and semantic-invalid tagged blocks", () => {
  const blocks = images([
    { type: "image", mimeType: "image/png", data: "legacy" },
    { type: "image-reference", id: "malformed" },
    {
      ...reference,
      width: LIMITS.maxImageWidth,
      height: LIMITS.maxImageHeight,
    },
    { type: "image-omission", reason: "unknown" },
    { type: "text", text: "not an image" },
  ]);
  assert.deepEqual(
    blocks,
    Array.from({ length: 4 }, () => ({ type: "image-omission", reason: "invalid-data" })),
  );
});

test("image extraction bounds references, omissions, and legacy blocks with one overflow", () => {
  for (const source of [
    Array.from({ length: 20 }, (_, index) => ({
      ...reference,
      id: String(index).padStart(46, "a"),
    })),
    Array.from({ length: 20 }, () => ({ type: "image-omission", reason: "invalid-data" })),
    Array.from({ length: 20 }, () => ({ type: "image", mimeType: "image/png", data: "legacy" })),
  ]) {
    const blocks = images(source);
    assert.equal(blocks.length, LIMITS.maxImagesPerEntry + 1);
    assert.deepEqual(blocks.at(-1), { type: "image-omission", reason: "count-exceeded" });
    assert.equal(
      blocks.filter((block) => block.type === "image-omission" && block.reason === "count-exceeded")
        .length,
      1,
    );
  }
});
