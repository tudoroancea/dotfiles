import { LIMITS } from "./limits.ts";
import type { ImageMimeType, ImageOmissionReason } from "./schema.ts";

export interface InspectedRasterImage {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function matches(content: Uint8Array, expected: Uint8Array, offset = 0): boolean {
  if (offset + expected.length > content.length) return false;
  return expected.every((value, index) => content[offset + index] === value);
}

function ascii(content: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length && index < content.length; index += 1)
    value += String.fromCharCode(content[index]);
  return value;
}

function u16be(content: Uint8Array, offset: number): number {
  return content[offset] * 0x100 + content[offset + 1];
}
function u16le(content: Uint8Array, offset: number): number {
  return content[offset] + content[offset + 1] * 0x100;
}
function u24le(content: Uint8Array, offset: number): number {
  return content[offset] + content[offset + 1] * 0x100 + content[offset + 2] * 0x10000;
}
function u32be(content: Uint8Array, offset: number): number {
  return (
    content[offset] * 0x1000000 +
    content[offset + 1] * 0x10000 +
    content[offset + 2] * 0x100 +
    content[offset + 3]
  );
}
function u32le(content: Uint8Array, offset: number): number {
  return (
    (content[offset] +
      content[offset + 1] * 0x100 +
      content[offset + 2] * 0x10000 +
      content[offset + 3] * 0x1000000) >>>
    0
  );
}

function dimensionsAllowed(width: number, height: number): ImageOmissionReason | undefined {
  if (width < 1 || height < 1) return "invalid-data";
  if (width > LIMITS.maxImageWidth || height > LIMITS.maxImageHeight) return "dimensions-exceeded";
  if (width * height > LIMITS.maxImagePixels) return "pixels-exceeded";
  return undefined;
}

function crc32(content: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= content[offset];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(content: Uint8Array): [number, number] | ImageOmissionReason {
  if (!matches(content, PNG_SIGNATURE)) return "signature-mismatch";
  if (content.length < 57) return "invalid-data";
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let leftData = false;
  while (offset + 12 <= content.length) {
    const length = u32be(content, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (!Number.isSafeInteger(end) || end > content.length) return "invalid-data";
    const kind = ascii(content, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(kind)) return "invalid-data";
    if (crc32(content, offset + 4, dataEnd) !== u32be(content, dataEnd)) return "invalid-data";
    if (!sawHeader && kind !== "IHDR") return "invalid-data";
    if (kind === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) return "invalid-data";
      width = u32be(content, dataStart);
      height = u32be(content, dataStart + 4);
      const bitDepth = content[dataStart + 8];
      colorType = content[dataStart + 9];
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
      if (
        !validDepth ||
        content[dataStart + 10] !== 0 ||
        content[dataStart + 11] !== 0 ||
        (content[dataStart + 12] !== 0 && content[dataStart + 12] !== 1)
      )
        return "invalid-data";
      sawHeader = true;
    } else if (kind === "acTL" || kind === "fcTL" || kind === "fdAT") {
      return "animated-image";
    } else if (kind === "PLTE") {
      if (
        sawPalette ||
        sawData ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0 ||
        colorType === 0
      )
        return "invalid-data";
      sawPalette = true;
    } else if (kind === "IDAT") {
      if (leftData || length === 0 || (colorType === 3 && !sawPalette)) return "invalid-data";
      sawData = true;
    } else if (kind === "IEND") {
      return length === 0 && sawHeader && sawData && end === content.length
        ? [width, height]
        : "invalid-data";
    } else {
      if (sawData) leftData = true;
      // Unknown critical chunks cannot be decoded safely. Ancillary chunks are bounded by the walk.
      if ((content[offset + 4] & 0x20) === 0) return "invalid-data";
    }
    if (kind !== "IDAT" && sawData) leftData = true;
    offset = end;
  }
  return "invalid-data";
}

function jpegDimensions(content: Uint8Array): [number, number] | ImageOmissionReason {
  if (content[0] !== 0xff || content[1] !== 0xd8) return "signature-mismatch";
  if (content.length < 8) return "invalid-data";
  let offset = 2;
  let dimensions: [number, number] | undefined;
  let sawScan = false;
  while (offset < content.length) {
    if (content[offset] !== 0xff) return "invalid-data";
    while (offset < content.length && content[offset] === 0xff) offset += 1;
    if (offset >= content.length) return "invalid-data";
    const marker = content[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      return "invalid-data";
    if (marker === 0xd9)
      return dimensions && sawScan && offset === content.length ? dimensions : "invalid-data";
    if (offset + 2 > content.length) return "invalid-data";
    const length = u16be(content, offset);
    if (length < 2 || offset + length > content.length) return "invalid-data";
    if (JPEG_SOF.has(marker)) {
      if (dimensions || length < 8) return "invalid-data";
      const components = content[offset + 7];
      if (components < 1 || components > 4 || length !== 8 + components * 3) return "invalid-data";
      dimensions = [u16be(content, offset + 5), u16be(content, offset + 3)];
    }
    offset += length;
    if (marker !== 0xda) continue;
    if (!dimensions || length < 6) return "invalid-data";
    sawScan = true;
    let entropyBytes = 0;
    while (offset < content.length) {
      if (content[offset] !== 0xff) {
        entropyBytes += 1;
        offset += 1;
        continue;
      }
      if (offset + 1 >= content.length) return "invalid-data";
      const next = content[offset + 1];
      if (next === 0x00) {
        entropyBytes += 1;
        offset += 2;
        continue;
      }
      if (next >= 0xd0 && next <= 0xd7) {
        offset += 2;
        continue;
      }
      break;
    }
    if (entropyBytes === 0) return "invalid-data";
  }
  return "invalid-data";
}

function webpDimensions(content: Uint8Array): [number, number] | ImageOmissionReason {
  if (content.length < 20 || ascii(content, 0, 4) !== "RIFF" || ascii(content, 8, 4) !== "WEBP")
    return "signature-mismatch";
  if (u32le(content, 4) + 8 !== content.length) return "invalid-data";

  let extended = false;
  let flags = 0;
  let canvas: [number, number] | undefined;
  let frame: [number, number] | undefined;
  let imageKind: "VP8 " | "VP8L" | undefined;
  let sawIcc = false;
  let sawAlpha = false;
  let sawExif = false;
  let sawXmp = false;
  let vp8lAlpha = false;
  let stage = 0;
  let offset = 12;
  while (offset + 8 <= content.length) {
    const kind = ascii(content, offset, 4);
    const length = u32le(content, offset + 4);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + (length & 1);
    if (
      !Number.isSafeInteger(paddedEnd) ||
      end > content.length ||
      paddedEnd > content.length ||
      (length & 1 && content[end] !== 0)
    )
      return "invalid-data";
    if (kind === "ANIM" || kind === "ANMF") return "animated-image";

    if (kind === "VP8X") {
      if (offset !== 12 || length !== 10 || extended) return "invalid-data";
      flags = content[start];
      if ((flags & 0x02) !== 0) return "animated-image";
      if ((flags & 0xc1) !== 0 || content[start + 1] || content[start + 2] || content[start + 3])
        return "invalid-data";
      extended = true;
      canvas = [u24le(content, start + 4) + 1, u24le(content, start + 7) + 1];
    } else if (kind === "ICCP") {
      if (!extended || stage !== 0 || sawIcc || length === 0) return "invalid-data";
      sawIcc = true;
    } else if (kind === "ALPH") {
      if (!extended || stage > 1 || sawAlpha || length < 2) return "invalid-data";
      const control = content[start];
      const preprocessing = (control >>> 4) & 0x03;
      if ((control & 0xc3) !== 0 || preprocessing > 1) return "invalid-data";
      sawAlpha = true;
      stage = 1;
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (imageKind || (extended && stage > 1) || (!extended && offset !== 12))
        return "invalid-data";
      imageKind = kind;
      stage = 2;
      if (
        kind === "VP8 " &&
        (length < 10 ||
          content[start + 3] !== 0x9d ||
          content[start + 4] !== 0x01 ||
          content[start + 5] !== 0x2a)
      )
        return "invalid-data";
      if (kind === "VP8L" && (length < 5 || content[start] !== 0x2f)) return "invalid-data";
      if (kind === "VP8 ")
        frame = [u16le(content, start + 6) & 0x3fff, u16le(content, start + 8) & 0x3fff];
      else {
        const bits = u32le(content, start + 1);
        if ((bits & 0xe0000000) !== 0) return "invalid-data";
        frame = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
        vp8lAlpha = Boolean(bits & 0x10000000);
      }
    } else if (kind === "EXIF") {
      if (!extended || stage < 2 || stage > 3 || sawExif || length === 0) return "invalid-data";
      sawExif = true;
      stage = 3;
    } else if (kind === "XMP ") {
      if (!extended || stage < 2 || sawXmp || length === 0) return "invalid-data";
      sawXmp = true;
      stage = 4;
    } else {
      return "invalid-data";
    }
    offset = paddedEnd;
  }
  if (offset !== content.length || !imageKind || !frame) return "invalid-data";
  if (!extended) return frame;
  if (!canvas || canvas[0] !== frame[0] || canvas[1] !== frame[1]) return "invalid-data";
  if (sawIcc !== Boolean(flags & 0x20) || sawExif !== Boolean(flags & 0x08)) return "invalid-data";
  if (sawXmp !== Boolean(flags & 0x04)) return "invalid-data";
  if (imageKind === "VP8 " && sawAlpha !== Boolean(flags & 0x10)) return "invalid-data";
  if (imageKind === "VP8L" && (sawAlpha || vp8lAlpha !== Boolean(flags & 0x10)))
    return "invalid-data";
  return frame;
}

/** CSP-safe, host-neutral bounded inspection for accepted raster input formats. */
export function inspectRasterImage(
  content: Uint8Array,
  claimed: unknown,
): InspectedRasterImage | ImageOmissionReason {
  if (content.length > LIMITS.maxImageBytes) return "image-too-large";
  if (claimed !== "image/png" && claimed !== "image/jpeg" && claimed !== "image/webp")
    return "unsupported-format";
  let actual: ImageMimeType | undefined;
  if (matches(content, PNG_SIGNATURE)) actual = "image/png";
  else if (content[0] === 0xff && content[1] === 0xd8) actual = "image/jpeg";
  else if (ascii(content, 0, 4) === "RIFF" && ascii(content, 8, 4) === "WEBP")
    actual = "image/webp";
  if (!actual || actual !== claimed) return "signature-mismatch";
  const dimensions =
    actual === "image/png"
      ? pngDimensions(content)
      : actual === "image/jpeg"
        ? jpegDimensions(content)
        : webpDimensions(content);
  if (typeof dimensions === "string") return dimensions;
  const rejected = dimensionsAllowed(dimensions[0], dimensions[1]);
  return rejected ?? { mimeType: actual, width: dimensions[0], height: dimensions[1] };
}
