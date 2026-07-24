import type { CompletionItem } from "../shared/wire.js";

export interface CompletionTarget {
  kind: "slash" | "mention";
  query: string;
  start: number;
  end: number;
}

export function detectCompletion(value: string, cursor: number): CompletionTarget | undefined {
  const before = value.slice(0, cursor);
  const slash = before.match(/^\/(\S*)$/);
  if (slash) return { kind: "slash", query: slash[1] ?? "", start: 0, end: cursor };
  const mention = before.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  if (!mention) return undefined;
  const token = mention[1]!;
  return {
    kind: "mention",
    query: token,
    start: cursor - token.length,
    end: cursor,
  };
}

export function applyCompletion(
  value: string,
  target: CompletionTarget,
  item: CompletionItem,
): { value: string; cursor: number } {
  let end = target.end;
  if (item.value.endsWith('"') && value[end] === '"') end += 1;
  const next = value.slice(0, target.start) + item.value + value.slice(end);
  return { value: next, cursor: target.start + item.value.length };
}
