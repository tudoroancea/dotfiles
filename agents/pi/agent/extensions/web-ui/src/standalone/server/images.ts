import { createHmac, randomBytes } from "node:crypto";
import {
  ImageOmissionSchema,
  inspectRasterImage,
  LIMITS,
  type ImageMimeType,
  type ImageOmission,
  type ImageOmissionReason,
  type ImageReference,
} from "@dotfiles/pi-web-ui-client/wire";
import { Check } from "typebox/value";

interface StoredImage {
  reference: ImageReference;
  content: Buffer;
}

interface ImageProjectionBudget {
  count: number;
  sourceBytes: number;
}

export interface ProjectedTranscript {
  payload: unknown;
}

export type ImageLookup =
  | { status: "found"; image: StoredImage }
  | { status: "evicted" | "unknown" | "busy" };

const MAX_EVICTED_IDS = 512;

function omission(reason: ImageOmissionReason): ImageOmission {
  return { type: "image-omission", reason };
}

function decodeBase64(value: unknown): Buffer | ImageOmissionReason {
  if (typeof value !== "string" || !value || value.length % 4 !== 0) return "invalid-data";
  if (value.length > Math.ceil(LIMITS.maxImageBytes / 3) * 4 + 4) return "image-too-large";
  const firstPadding = value.indexOf("=");
  const bodyEnd = firstPadding < 0 ? value.length : firstPadding;
  const padding = value.length - bodyEnd;
  if (padding > 2 || (padding > 0 && bodyEnd < value.length - 2)) return "invalid-data";
  for (let index = 0; index < bodyEnd; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return "invalid-data";
  }
  for (let index = bodyEnd; index < value.length; index += 1)
    if (value.charCodeAt(index) !== 61) return "invalid-data";
  const content = Buffer.from(value, "base64");
  if (content.length > LIMITS.maxImageBytes) return "image-too-large";
  return content;
}

export class ImageResolver {
  private readonly secret = randomBytes(32);
  private readonly retained = new Map<string, StoredImage>();
  private readonly evicted = new Set<string>();
  private retainedBytes = 0;
  private activeResponses = 0;

  constructor(private readonly generation: string) {}

  project(value: unknown): ProjectedTranscript {
    const budget: ImageProjectionBudget = { count: 0, sourceBytes: 0 };
    const drop = Symbol("drop-excess-image");
    const projectValue = (candidate: unknown, applyToJson = true): unknown | typeof drop => {
      if (!candidate || typeof candidate !== "object") return candidate;
      const block = candidate as Record<string, unknown>;
      if (applyToJson && typeof block.toJSON === "function")
        return projectValue(block.toJSON.call(candidate), false);
      const imageTagged =
        block.type === "image" ||
        block.type === "image-reference" ||
        block.type === "image-omission";
      if (imageTagged) {
        budget.count += 1;
        if (budget.count > LIMITS.maxImagesPerEntry)
          return budget.count === LIMITS.maxImagesPerEntry + 1 ? omission("count-exceeded") : drop;
        if (block.type === "image-omission")
          return Check(ImageOmissionSchema, block)
            ? omission(block.reason as ImageOmissionReason)
            : omission("invalid-data");
        if (block.type === "image-reference") return omission("invalid-data");
        const decoded = decodeBase64(block.data);
        if (typeof decoded === "string") return omission(decoded);
        budget.sourceBytes += decoded.length;
        if (budget.sourceBytes > LIMITS.maxImageSourceBytesPerEntry)
          return omission("aggregate-bytes-exceeded");
        const inspected = inspectRasterImage(decoded, block.mimeType);
        if (typeof inspected === "string") return omission(inspected);
        return this.retain(decoded, inspected);
      }
      if (Array.isArray(candidate)) {
        const projected: unknown[] = [];
        for (const item of candidate) {
          const next = projectValue(item);
          if (next !== drop) projected.push(next);
        }
        return projected;
      }
      const projected: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(block)) {
        if (typeof item === "function") continue;
        const next = projectValue(item);
        if (next !== drop) projected[key] = next;
      }
      return projected;
    };
    const projected = projectValue(value);
    const serialized = JSON.stringify(projected === drop ? omission("count-exceeded") : projected);
    if (serialized === undefined) throw new Error("Unserializable transcript value");
    return { payload: JSON.parse(serialized) };
  }

  acquire(id: string): ImageLookup {
    const image = this.retained.get(id);
    if (!image) return { status: this.evicted.has(id) ? "evicted" : "unknown" };
    if (this.activeResponses >= LIMITS.maxConcurrentImageResponses) return { status: "busy" };
    this.activeResponses += 1;
    return { status: "found", image };
  }

  releaseResponse(): void {
    this.activeResponses = Math.max(0, this.activeResponses - 1);
  }

  private retain(
    content: Buffer,
    metadata: { mimeType: ImageMimeType; width: number; height: number },
  ): ImageReference {
    const id = createHmac("sha256", this.secret)
      .update(this.generation)
      .update("\0")
      .update(content)
      .digest("base64url");
    const existing = this.retained.get(id);
    if (existing) return existing.reference;
    const reference: ImageReference = {
      type: "image-reference",
      id,
      ...metadata,
      byteLength: content.length,
    };
    this.retained.set(id, { reference, content });
    this.retainedBytes += content.length;
    this.evicted.delete(id);
    while (
      this.retainedBytes > LIMITS.maxRetainedImageBytes ||
      this.retained.size > LIMITS.maxRetainedImageCount
    ) {
      const oldest = this.retained.entries().next().value as [string, StoredImage] | undefined;
      if (!oldest) break;
      this.retained.delete(oldest[0]);
      this.retainedBytes -= oldest[1].content.length;
      this.evicted.add(oldest[0]);
      while (this.evicted.size > MAX_EVICTED_IDS)
        this.evicted.delete(this.evicted.values().next().value!);
    }
    return reference;
  }
}
