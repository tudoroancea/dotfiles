import { Buffer } from "node:buffer";

export const TAIL_MAX_BYTES = 50 * 1024;
export const TAIL_MAX_LINES = 2_000;

export interface BoundedTailSnapshot {
  content: string;
  bytes: number;
  lines: number;
  truncated: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function countLines(value: string): number {
  if (value.length === 0) return 0;

  let lines = value.endsWith("\n") ? 0 : 1;
  for (const character of value) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function trimToBytes(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;

  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

function trimToLines(value: string, maxLines: number): string {
  const linesToDrop = countLines(value) - maxLines;
  if (linesToDrop <= 0) return value;

  let remaining = linesToDrop;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") continue;
    remaining -= 1;
    if (remaining === 0) return value.slice(index + 1);
  }
  return "";
}

export class BoundedTail {
  private content = "";
  private wasTruncated = false;

  constructor(
    readonly maxBytes = TAIL_MAX_BYTES,
    readonly maxLines = TAIL_MAX_LINES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxLines) || maxLines < 0) {
      throw new RangeError("maxLines must be a non-negative safe integer");
    }
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;

    const combined = this.content + chunk;
    const byteBounded = trimToBytes(combined, this.maxBytes);
    const bounded = trimToLines(byteBounded, this.maxLines);
    if (bounded !== combined) this.wasTruncated = true;
    this.content = bounded;
  }

  snapshot(): BoundedTailSnapshot {
    return {
      content: this.content,
      bytes: byteLength(this.content),
      lines: countLines(this.content),
      truncated: this.wasTruncated,
    };
  }

  clear(): void {
    this.content = "";
    this.wasTruncated = false;
  }
}
