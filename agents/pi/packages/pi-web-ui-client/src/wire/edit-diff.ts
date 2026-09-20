import {
  Array as TypeArray,
  Boolean as TypeBoolean,
  Literal as TypeLiteral,
  Number as TypeNumber,
  Object as TypeObject,
  Optional as TypeOptional,
  String as TypeString,
  Union as TypeUnion,
  type Static,
  type TProperties,
} from "typebox";
import { Check } from "typebox/value";

/**
 * Browser normalization limits for opaque edit-tool transcript details.
 * This renderer view is not an obligation on transcript producers or wire envelopes.
 * The limits include adversarial headroom over the observed edit-diff corpus while
 * keeping text and row allocation independently bounded.
 */
export const EDIT_DIFF_LIMITS = {
  maxRetainedBytes: 128 * 1_024,
  maxRetainedLines: 1_024,
  maxRetainedLineBytes: 8 * 1_024,
  maxResultContentCandidates: 16,
  maxCount: 0x7fff_ffff,
} as const;

const StrictObject = <T extends TProperties>(properties: T) =>
  TypeObject(properties, { additionalProperties: false });
const CountSchema = TypeNumber({ minimum: 0, maximum: EDIT_DIFF_LIMITS.maxCount, multipleOf: 1 });

export const EditDiffLineKindSchema = TypeUnion([
  TypeLiteral("meta"),
  TypeLiteral("hunk"),
  TypeLiteral("added"),
  TypeLiteral("removed"),
  TypeLiteral("context"),
  TypeLiteral("fallback"),
]);
export type EditDiffLineKind = Static<typeof EditDiffLineKindSchema>;

export const EditDiffLineViewSchema = StrictObject({
  kind: EditDiffLineKindSchema,
  text: TypeString({ maxLength: EDIT_DIFF_LIMITS.maxRetainedLineBytes }),
  sourceLine: CountSchema,
  truncated: TypeBoolean(),
  omittedBytes: CountSchema,
  omittedBytesExact: TypeBoolean(),
});
export type EditDiffLineView = Static<typeof EditDiffLineViewSchema>;

export const EditDiffStatsViewSchema = StrictObject({
  additions: CountSchema,
  removals: CountSchema,
  partial: TypeBoolean(),
});
export type EditDiffStatsView = Static<typeof EditDiffStatsViewSchema>;

export const EditDiffRendererViewSchema = StrictObject({
  mode: TypeUnion([TypeLiteral("diff"), TypeLiteral("fallback")]),
  lines: TypeArray(EditDiffLineViewSchema, { maxItems: EDIT_DIFF_LIMITS.maxRetainedLines }),
  stats: EditDiffStatsViewSchema,
  retainedBytes: TypeNumber({
    minimum: 0,
    maximum: EDIT_DIFF_LIMITS.maxRetainedBytes,
    multipleOf: 1,
  }),
  sourceTruncated: TypeBoolean(),
  lineTruncated: TypeBoolean(),
  omittedLines: CountSchema,
  omittedLinesExact: TypeBoolean(),
  reason: TypeOptional(TypeString({ maxLength: 160 })),
});
export type EditDiffRendererView = Static<typeof EditDiffRendererViewSchema>;

type RawRecord = Record<string, unknown>;

function record(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function byteWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function codePointAt(
  source: string,
  index: number,
): { text: string; width: number; units: number } {
  const first = source.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < source.length) {
    const second = source.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return { text: source.slice(index, index + 2), width: 4, units: 2 };
    }
  }
  if (first >= 0xd800 && first <= 0xdfff) return { text: "�", width: 3, units: 1 };
  return { text: source[index], width: byteWidth(first), units: 1 };
}

function isLineBreak(value: number): boolean {
  return value === 0x0a || value === 0x0d;
}

/** Skip one line-bounded ANSI/control sequence without materializing a match string. */
function skipControlSequence(source: string, index: number): number {
  const first = source.charCodeAt(index);
  const escaped = first === 0x1b;
  const introducer = escaped ? source.charCodeAt(index + 1) : first;
  const start = index + (escaped ? 2 : 1);
  const isCsi = introducer === 0x5b || introducer === 0x9b;
  const isString =
    introducer === 0x5d ||
    introducer === 0x50 ||
    introducer === 0x5e ||
    introducer === 0x5f ||
    introducer === 0x9d ||
    introducer === 0x90 ||
    introducer === 0x9e ||
    introducer === 0x9f;

  if (isCsi) {
    let cursor = start;
    while (cursor < source.length && !isLineBreak(source.charCodeAt(cursor))) {
      const value = source.charCodeAt(cursor++);
      if (value >= 0x40 && value <= 0x7e) break;
    }
    return cursor;
  }
  if (isString) {
    let cursor = start;
    while (cursor < source.length && !isLineBreak(source.charCodeAt(cursor))) {
      const value = source.charCodeAt(cursor++);
      if (value === 0x9c || ((introducer === 0x5d || introducer === 0x9d) && value === 0x07)) break;
      if (value === 0x1b && source.charCodeAt(cursor) === 0x5c) {
        cursor += 1;
        break;
      }
    }
    return cursor;
  }
  if (escaped && index + 1 < source.length && !isLineBreak(source.charCodeAt(index + 1))) {
    return index + 2;
  }
  return index + 1;
}

function isUnifiedHeader(text: string, marker: "---" | "+++"): boolean {
  if (!text.startsWith(marker)) return false;
  const next = text.charCodeAt(marker.length);
  return text.length === marker.length || next === 0x20 || next === 0x09;
}

function classify(text: string, fallback: boolean, beforeFirstHunk: boolean): EditDiffLineKind {
  if (fallback) return "fallback";
  if (
    (beforeFirstHunk && (isUnifiedHeader(text, "---") || isUnifiedHeader(text, "+++"))) ||
    text === "\\ No newline at end of file"
  )
    return "meta";
  if (text.startsWith("@@")) return "hunk";
  if (text.startsWith("+")) return "added";
  if (text.startsWith("-")) return "removed";
  return "context";
}

/**
 * Allocation-bounded normalization. It manually scans UTF-16 into UTF-8 widths,
 * never splits a surrogate pair, and does not call split/match over the source.
 */
function normalizeText(source: string, fallback: boolean): EditDiffRendererView {
  const lines: EditDiffLineView[] = [];
  let cursor = 0;
  let retainedBytes = 0;
  let lineTruncated = false;
  let sourceTruncated = false;
  let beforeFirstHunk = true;

  while (cursor < source.length || (cursor === 0 && source.length === 0)) {
    if (lines.length >= EDIT_DIFF_LIMITS.maxRetainedLines) {
      sourceTruncated = cursor < source.length;
      break;
    }
    const separatorBytes = lines.length ? 1 : 0;
    if (retainedBytes + separatorBytes >= EDIT_DIFF_LIMITS.maxRetainedBytes) {
      sourceTruncated = cursor < source.length;
      break;
    }

    const sourceLine = lines.length + 1;
    const retained: string[] = [];
    let retainedLineBytes = 0;
    let omittedBytes = 0;
    let omittedBytesExact = true;
    let endedByBreak = false;
    let retaining = true;

    while (cursor < source.length) {
      const value = source.charCodeAt(cursor);
      if (isLineBreak(value)) {
        if (value === 0x0d && source.charCodeAt(cursor + 1) === 0x0a) cursor += 2;
        else cursor += 1;
        endedByBreak = true;
        break;
      }
      if (value === 0x1b || (value >= 0x80 && value <= 0x9f)) {
        cursor = skipControlSequence(source, cursor);
        continue;
      }
      const point = codePointAt(source, cursor);
      cursor += point.units;
      if ((value < 0x20 && value !== 0x09) || value === 0x7f) continue;
      const withinLine = retainedLineBytes + point.width <= EDIT_DIFF_LIMITS.maxRetainedLineBytes;
      const withinTotal =
        retainedBytes + separatorBytes + retainedLineBytes + point.width <=
        EDIT_DIFF_LIMITS.maxRetainedBytes;
      if (retaining && withinLine && withinTotal) {
        retained.push(point.text);
        retainedLineBytes += point.width;
      } else {
        retaining = false;
        if (omittedBytes <= EDIT_DIFF_LIMITS.maxCount - point.width) omittedBytes += point.width;
        else {
          omittedBytes = EDIT_DIFF_LIMITS.maxCount;
          omittedBytesExact = false;
        }
      }
    }

    const text = retained.join("");
    const kind = classify(text, fallback, beforeFirstHunk);
    if (kind === "hunk") beforeFirstHunk = false;
    const truncated = omittedBytes > 0;
    lineTruncated ||= truncated;
    lines.push({
      kind,
      text,
      sourceLine,
      truncated,
      omittedBytes,
      omittedBytesExact,
    });
    retainedBytes += separatorBytes + retainedLineBytes;

    if (retainedBytes >= EDIT_DIFF_LIMITS.maxRetainedBytes && cursor < source.length) {
      sourceTruncated = true;
      break;
    }
    if (!endedByBreak) break;
    if (cursor === source.length) {
      if (lines.length < EDIT_DIFF_LIMITS.maxRetainedLines) {
        const nextSeparator = lines.length ? 1 : 0;
        if (retainedBytes + nextSeparator <= EDIT_DIFF_LIMITS.maxRetainedBytes) {
          lines.push({
            kind: classify("", fallback, beforeFirstHunk),
            text: "",
            sourceLine: lines.length + 1,
            truncated: false,
            omittedBytes: 0,
            omittedBytesExact: true,
          });
          retainedBytes += nextSeparator;
        } else sourceTruncated = true;
      } else sourceTruncated = true;
      break;
    }
  }

  let additions = 0;
  let removals = 0;
  if (!fallback) {
    for (const line of lines) {
      if (line.kind === "added") additions += 1;
      else if (line.kind === "removed") removals += 1;
    }
  }
  const partial = fallback || sourceTruncated || lineTruncated;
  return {
    mode: fallback ? "fallback" : "diff",
    lines,
    stats: { additions, removals, partial },
    retainedBytes,
    sourceTruncated,
    lineTruncated,
    omittedLines: sourceTruncated ? 1 : 0,
    omittedLinesExact: !sourceTruncated,
  };
}

function firstResultText(result: unknown): string | null {
  const content = record(result)?.content;
  if (!Array.isArray(content)) return null;
  const count = Math.min(content.length, EDIT_DIFF_LIMITS.maxResultContentCandidates);
  for (let index = 0; index < count; index += 1) {
    const item = record(content[index]);
    if (item?.type === "text" && typeof item.text === "string") return item.text;
  }
  return null;
}

function hasVisibleText(view: EditDiffRendererView): boolean {
  return view.lines.some((line) => line.text.trim().length > 0);
}

function fallbackView(result: unknown, reason: string): EditDiffRendererView {
  const defaultText = `Edit diff unavailable: ${reason}.`;
  let view = normalizeText(firstResultText(result) ?? defaultText, true);
  if (!hasVisibleText(view)) view = normalizeText(defaultText, true);
  return { ...view, reason };
}

function utf8Bytes(source: string): number {
  let bytes = 0;
  for (let index = 0; index < source.length;) {
    const point = codePointAt(source, index);
    bytes += point.width;
    index += point.units;
  }
  return bytes;
}

/** Schema and semantic validation for renderer views crossing a trust boundary. */
export function isEditDiffRendererView(value: unknown): value is EditDiffRendererView {
  if (!Check(EditDiffRendererViewSchema, value)) return false;
  const view = value as EditDiffRendererView;
  let retainedBytes = Math.max(0, view.lines.length - 1);
  let additions = 0;
  let removals = 0;
  let anyLineTruncated = false;

  for (let index = 0; index < view.lines.length; index += 1) {
    const line = view.lines[index];
    const bytes = utf8Bytes(line.text);
    if (bytes > EDIT_DIFF_LIMITS.maxRetainedLineBytes || line.sourceLine !== index + 1)
      return false;
    if (line.truncated !== line.omittedBytes > 0 || (!line.truncated && !line.omittedBytesExact))
      return false;
    if (view.mode === "fallback" ? line.kind !== "fallback" : line.kind === "fallback")
      return false;
    retainedBytes += bytes;
    anyLineTruncated ||= line.truncated;
    if (line.kind === "added") additions += 1;
    else if (line.kind === "removed") removals += 1;
  }

  return (
    retainedBytes === view.retainedBytes &&
    retainedBytes <= EDIT_DIFF_LIMITS.maxRetainedBytes &&
    anyLineTruncated === view.lineTruncated &&
    view.stats.additions === additions &&
    view.stats.removals === removals &&
    view.stats.partial ===
      (view.mode === "fallback" || view.sourceTruncated || view.lineTruncated) &&
    (view.sourceTruncated ? view.omittedLines > 0 : view.omittedLines === 0) &&
    view.omittedLinesExact === !view.sourceTruncated &&
    (view.mode === "fallback" ? typeof view.reason === "string" : view.reason === undefined)
  );
}

/** Total decoder from opaque transcript details to one strict renderer view. */
export function decodeEditDiffRendererView(
  details: unknown,
  result?: unknown,
): EditDiffRendererView {
  try {
    const rawDiff = record(details)?.diff;
    if (typeof rawDiff !== "string") return fallbackView(result, "missing or malformed details");
    if (rawDiff.indexOf("\0") !== -1) return fallbackView(result, "unsafe NUL control payload");
    const view = normalizeText(rawDiff, false);
    const hasSemanticDiff = view.lines.some(
      (line) => line.kind !== "meta" && line.text.trim().length > 0,
    );
    if (!hasSemanticDiff) return fallbackView(result, "empty normalized details");
    return isEditDiffRendererView(view) ? view : fallbackView(result, "invalid normalized details");
  } catch {
    return fallbackView(undefined, "unreadable details");
  }
}
