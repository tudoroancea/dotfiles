import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const MAX_SELECTOR_WIDTH = 72;
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

export interface CopyRegion {
  label: string;
  payload: string;
  payloadStart: number;
  payloadEnd: number;
}

export type LatestAssistantTextResult =
  | { status: "no-assistant" }
  | { status: "no-meaningful-text"; text: string }
  | { status: "ok"; text: string };

export interface ParsedCopyRegions {
  regions: CopyRegion[];
  wholeText: string;
}

interface SourceLine {
  start: number;
  contentEnd: number;
  end: number;
  content: string;
}

interface Fence {
  openingLine: number;
  closingLine: number;
  info: string;
  payloadStart: number;
  payloadEnd: number;
}

interface Annotation {
  id: string;
  label: string;
  line: number;
}

export function extractLatestAssistantText(
  sessionManager: Pick<SessionManager, "getBranch">,
): LatestAssistantTextResult {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

    const text = entry.message.content
      .filter(
        (block): block is Extract<(typeof entry.message.content)[number], { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    return text.trim().length === 0
      ? { status: "no-meaningful-text", text }
      : { status: "ok", text };
  }
  return { status: "no-assistant" };
}

export function parseCopyRegions(source: string): ParsedCopyRegions {
  const originalLines = sourceLines(source);
  const lines = sourceLines(maskTopLevelHtmlBlocks(source));
  const fencedLine = Array.from<boolean>({ length: lines.length }).fill(false);
  const listNestedFenceLine = findListNestedFenceLines(lines);
  const fences: Fence[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (fencedLine[lineIndex] || listNestedFenceLine[lineIndex]) continue;
    const opener = openingFence(lines[lineIndex]?.content ?? "");
    if (!opener) continue;

    let closingLine = -1;
    for (let candidate = lineIndex + 1; candidate < lines.length; candidate += 1) {
      if (isClosingFence(lines[candidate]?.content ?? "", opener.character, opener.length)) {
        closingLine = candidate;
        break;
      }
    }

    if (closingLine < 0) {
      for (let candidate = lineIndex; candidate < lines.length; candidate += 1) {
        fencedLine[candidate] = true;
      }
      break;
    }

    for (let candidate = lineIndex; candidate <= closingLine; candidate += 1) {
      fencedLine[candidate] = true;
    }
    fences.push({
      openingLine: lineIndex,
      closingLine,
      info: opener.info,
      payloadStart: lines[lineIndex]?.end ?? source.length,
      payloadEnd: lines[closingLine]?.start ?? source.length,
    });
    lineIndex = closingLine;
  }

  const annotationCandidates: Annotation[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (
      fencedLine[lineIndex] ||
      listNestedFenceLine[lineIndex] ||
      !hasDefinitionSeparation(lines, lineIndex)
    )
      continue;
    const match = /^(?: {0,3})\[copy-region-(\d+)\]:[ \t]+#[ \t]+"([^"\r\n]+)"[ \t]*$/.exec(
      lines[lineIndex]?.content ?? "",
    );
    if (match && match[2]?.trim()) {
      annotationCandidates.push({ id: match[1] ?? "", label: match[2], line: lineIndex });
    }
  }

  const idCounts = new Map<string, number>();
  for (const annotation of annotationCandidates) {
    idCounts.set(annotation.id, (idCounts.get(annotation.id) ?? 0) + 1);
  }
  const annotations = annotationCandidates.filter(
    (annotation) => idCounts.get(annotation.id) === 1,
  );
  const annotationsByLine = new Map(annotations.map((annotation) => [annotation.line, annotation]));

  const regions = fences.map((fence) => {
    let annotationLine = fence.openingLine - 1;
    while (annotationLine >= 0 && isBlank(originalLines[annotationLine])) annotationLine -= 1;
    const annotation = annotationsByLine.get(annotationLine);
    const payload = source.slice(fence.payloadStart, fence.payloadEnd);
    return {
      label: boundedLabel(annotation?.label ?? deriveLabel(fence.info, payload)),
      payload,
      payloadStart: fence.payloadStart,
      payloadEnd: fence.payloadEnd,
    };
  });

  let wholeText = "";
  let cursor = 0;
  for (const annotation of annotations) {
    const line = originalLines[annotation.line];
    if (!line) continue;
    wholeText += source.slice(cursor, line.start);
    cursor = line.end;
  }
  wholeText += source.slice(cursor);

  return { regions, wholeText };
}

export function formatRegionSelectorLabels(regions: readonly CopyRegion[]): string[] {
  return regions.map((region, index) => {
    const prefix = `${index + 1}. `;
    return (
      prefix +
      truncateToWidth(boundedLabel(region.label), MAX_SELECTOR_WIDTH - prefix.length, "…").replace(
        ANSI_ESCAPE,
        "",
      )
    );
  });
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const contentEnd =
      newline < 0 ? end : newline > start && source[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ start, contentEnd, end, content: source.slice(start, contentEnd) });
    start = end;
  }
  return lines;
}

function maskTopLevelHtmlBlocks(source: string): string {
  const lines = sourceLines(source);
  const masked = Array.from<boolean>({ length: lines.length }).fill(false);
  let paragraphOpen = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const content = lines[lineIndex]?.content ?? "";
    if (isBlank(lines[lineIndex])) {
      paragraphOpen = false;
      continue;
    }

    const fence = openingFence(content);
    if (fence) {
      lineIndex = findFenceEnd(lines, lineIndex, fence, 0) ?? lines.length - 1;
      paragraphOpen = false;
      continue;
    }

    const htmlBlock = openingHtmlBlock(content, !paragraphOpen);
    if (!htmlBlock) {
      paragraphOpen = !isParagraphClosingBlockConstruct(content);
      continue;
    }

    let lastLine = lineIndex;
    if (htmlBlock.end === "blank") {
      while (lastLine + 1 < lines.length && !isBlank(lines[lastLine + 1])) lastLine += 1;
    } else {
      while (lastLine + 1 < lines.length && !htmlBlock.end.test(lines[lastLine]?.content ?? "")) {
        lastLine += 1;
      }
    }
    for (let candidate = lineIndex; candidate <= lastLine; candidate += 1) {
      masked[candidate] = true;
    }
    lineIndex = lastLine;
    paragraphOpen = false;
  }

  return lines
    .map((line, lineIndex) =>
      masked[lineIndex]
        ? " ".repeat(line.contentEnd - line.start) + source.slice(line.contentEnd, line.end)
        : source.slice(line.start, line.end),
    )
    .join("");
}

const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_TAG = new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t]|/?>|$)`, "i");
const COMPLETE_HTML_TAG =
  /^ {0,3}(?:<([A-Za-z][A-Za-z0-9-]*)(?:[ \t]+[^<>]*?)?[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;

function openingHtmlBlock(
  content: string,
  separatedFromParagraph: boolean,
): { end: RegExp | "blank" } | undefined {
  if (/^ {0,3}<!--/.test(content)) return { end: /-->/ };
  if (/^ {0,3}<\?/.test(content)) return { end: /\?>/ };
  if (/^ {0,3}<!\[CDATA\[/.test(content)) return { end: /\]\]>/ };
  if (/^ {0,3}<![A-Z]/.test(content)) return { end: />/ };

  const rawTag = /^ {0,3}<(script|pre|style|textarea)(?:[ \t]|>|$)/i.exec(content);
  if (rawTag?.[1]) return { end: new RegExp(`</${rawTag[1]}[ \\t]*>`, "i") };
  if (HTML_BLOCK_TAG.test(content)) return { end: "blank" };
  if (separatedFromParagraph && COMPLETE_HTML_TAG.test(content)) return { end: "blank" };
  return undefined;
}

function isBlank(line: SourceLine | undefined): boolean {
  return /^[ \t]*$/.test(line?.content ?? "");
}

function findListNestedFenceLines(lines: readonly SourceLine[]): boolean[] {
  const nested = Array.from<boolean>({ length: lines.length }).fill(false);
  const listContentIndents: number[] = [];
  let paragraphContinuation = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const content = lines[lineIndex]?.content ?? "";
    if (/^[ \t]*$/.test(content)) {
      paragraphContinuation = false;
      continue;
    }

    const indent = /^ */.exec(content)?.[0].length ?? 0;
    const listItem = isThematicBreak(content)
      ? null
      : /^( *)(?:[*+-]|\d{1,9}[.)])(?:([ \t]+)|$)/.exec(content);

    if (listItem) {
      const markerIndent = listItem[1]?.length ?? 0;
      while (listContentIndents.length > 0 && markerIndent < (listContentIndents.at(-1) ?? 0)) {
        listContentIndents.pop();
      }

      if (markerIndent <= 3 || markerIndent >= (listContentIndents.at(-1) ?? 0)) {
        const markerEnd = (listItem[0]?.length ?? 0) - (listItem[2]?.length ?? 0);
        const padding = listItem[2]?.replaceAll("\t", "    ").length ?? 1;
        const contentIndent = markerEnd + (padding <= 4 ? padding : 1);
        listContentIndents.push(contentIndent);

        const itemContent = content.slice(contentIndent);
        const itemOpener = openingFence(itemContent);
        paragraphContinuation =
          itemContent.length > 0 && !isParagraphClosingBlockConstruct(itemContent);
        if (itemOpener) {
          const result = markNestedFence(lines, nested, lineIndex, contentIndent, itemOpener);
          if (!result.closed) listContentIndents.pop();
          lineIndex = result.nextLine - 1;
          paragraphContinuation = false;
        }
        continue;
      }
    }

    const lazyContinuation: boolean =
      listContentIndents.length > 0 &&
      indent < (listContentIndents.at(-1) ?? 0) &&
      paragraphContinuation &&
      !isParagraphClosingBlockConstruct(content);
    if (!lazyContinuation) {
      while (listContentIndents.length > 0 && indent < (listContentIndents.at(-1) ?? 0)) {
        listContentIndents.pop();
      }
    }

    const listContentIndent = listContentIndents.at(-1);
    if (listContentIndent === undefined) {
      const topLevelOpener = openingFence(content);
      if (topLevelOpener) {
        const closingLine = findFenceEnd(lines, lineIndex, topLevelOpener, 0);
        lineIndex = closingLine ?? lines.length - 1;
      }
      paragraphContinuation = false;
      continue;
    }

    const opener = openingFence(content.slice(listContentIndent));
    if (opener) {
      const result = markNestedFence(lines, nested, lineIndex, listContentIndent, opener);
      if (!result.closed) listContentIndents.pop();
      lineIndex = result.nextLine - 1;
      paragraphContinuation = false;
      continue;
    }

    paragraphContinuation = lazyContinuation || !isParagraphClosingBlockConstruct(content);
  }

  return nested;
}

function isParagraphClosingBlockConstruct(content: string): boolean {
  return (
    openingFence(content) !== undefined ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(content) ||
    /^ {0,3}>/.test(content) ||
    isThematicBreak(content) ||
    /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/.test(content) ||
    /^ {0,3}(?:=+|-+)[ \t]*$/.test(content)
  );
}

function isThematicBreak(content: string): boolean {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(content);
}

function markNestedFence(
  lines: readonly SourceLine[],
  nested: boolean[],
  openingLine: number,
  contentIndent: number,
  opener: { character: "`" | "~"; length: number },
): { nextLine: number; closed: boolean } {
  const closingLine = findFenceEnd(lines, openingLine, opener, contentIndent);
  let end = closingLine ?? openingLine + 1;
  if (closingLine === undefined) {
    while (end < lines.length) {
      const content = lines[end]?.content ?? "";
      if (!/^[ \t]*$/.test(content) && (/^ */.exec(content)?.[0].length ?? 0) < contentIndent) {
        break;
      }
      end += 1;
    }
  } else {
    end += 1;
  }

  for (let candidate = openingLine; candidate < end; candidate += 1) nested[candidate] = true;
  return { nextLine: end, closed: closingLine !== undefined };
}

function findFenceEnd(
  lines: readonly SourceLine[],
  openingLine: number,
  opener: { character: "`" | "~"; length: number },
  contentIndent: number,
): number | undefined {
  for (let candidate = openingLine + 1; candidate < lines.length; candidate += 1) {
    const content = lines[candidate]?.content ?? "";
    if (!/^[ \t]*$/.test(content) && (/^ */.exec(content)?.[0].length ?? 0) < contentIndent) {
      return undefined;
    }
    if (isClosingFence(content.slice(contentIndent), opener.character, opener.length)) {
      return candidate;
    }
  }
  return undefined;
}

function openingFence(
  content: string,
): { character: "`" | "~"; length: number; info: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
  if (!match) return undefined;
  const marker = match[1] ?? "";
  const info = match[2] ?? "";
  if (marker[0] === "`" && info.includes("`")) return undefined;
  return { character: marker[0] as "`" | "~", length: marker.length, info };
}

function isClosingFence(content: string, character: "`" | "~", minimumLength: number): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(content);
  return Boolean(match && match[1]?.[0] === character && match[1].length >= minimumLength);
}

function hasDefinitionSeparation(lines: readonly SourceLine[], lineIndex: number): boolean {
  if (lineIndex === 0) return true;
  return /^[ \t]*$/.test(lines[lineIndex - 1]?.content ?? "");
}

function deriveLabel(info: string, payload: string): string {
  const language = info.trim().split(/[ \t]+/, 1)[0] ?? "";
  const firstContentLine = payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (language && firstContentLine) return `${language} — ${firstContentLine}`;
  if (firstContentLine) return firstContentLine;
  if (language) return `${language} block`;
  return "Text block";
}

function boundedLabel(label: string): string {
  const singleLine = label
    .replace(ANSI_ESCAPE, "")
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
    .trim();
  return truncateToWidth(singleLine || "Text block", MAX_SELECTOR_WIDTH, "…").replace(
    ANSI_ESCAPE,
    "",
  );
}
