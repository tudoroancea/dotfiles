// Image content-block handling with a strict data-MIME allow-list. Images
// arrive as base64 data blocks (never as Markdown), so only raster types the
// browser can safely inline are rendered; everything else shows an explicit
// omitted-image placeholder rather than a broken or dangerous element.

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BASE64_LENGTH = 8 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export type ImageView =
  | { readonly kind: "image"; readonly src: string; readonly mimeType: string }
  | { readonly kind: "omitted"; readonly label: string };

function omittedLabel(record: Record<string, unknown>): string {
  const count = record.count;
  if (typeof count === "number" && count > 1) return `${count} images omitted`;
  const mime = typeof record.mimeType === "string" ? record.mimeType : undefined;
  return mime ? `Image omitted (${mime})` : "Image omitted";
}

/** Resolve an image content block to either a safe data URL or an omitted state. */
export function resolveImage(block: unknown): ImageView {
  const record = block && typeof block === "object" ? (block as Record<string, unknown>) : {};
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
  const data = typeof record.data === "string" ? record.data : "";
  if (
    record.omitted === true ||
    !data ||
    !ALLOWED_MIME.has(mimeType) ||
    data.length > MAX_BASE64_LENGTH ||
    data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(data)
  ) {
    return { kind: "omitted", label: omittedLabel(record) };
  }
  return { kind: "image", src: `data:${mimeType};base64,${data}`, mimeType };
}

export function isImageBlock(block: unknown): boolean {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as Record<string, unknown>).type === "image"
  );
}
