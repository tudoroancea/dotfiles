import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { CompletionItem } from "@dotfiles/pi-web-ui-client/wire";

// The one production completion path used by the standalone server: canonical `@`
// completions through Pi's autocomplete provider, with a filesystem walk fallback
// when no provider is available. Playwright fixtures call these same functions
// rather than mirroring discovery logic.

export async function fallbackFileCompletions(
  cwd: string,
  query: string,
  signal: AbortSignal,
): Promise<CompletionItem[]> {
  const quoted = query.startsWith('@"');
  const rawQuery = query.replace(/^@"?/, "").replace(/"$/, "").toLowerCase();
  const queue = [""];
  const entries: Array<{ path: string; directory: boolean; score: number }> = [];
  const ignored = new Set([".git", "node_modules"]);
  while (queue.length && entries.length < 5000 && !signal.aborted) {
    const relativeDir = queue.shift()!;
    let children;
    try {
      children = await readdir(join(cwd, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (ignored.has(child.name)) continue;
      const path = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      const directory = child.isDirectory();
      if (directory) queue.push(path);
      const lower = path.toLowerCase();
      let queryIndex = 0;
      for (const character of lower) {
        if (character === rawQuery[queryIndex]) queryIndex += 1;
      }
      if (!rawQuery || queryIndex === rawQuery.length) {
        entries.push({
          path,
          directory,
          score: rawQuery ? (lower.includes(rawQuery) ? 2 : 1) : 1,
        });
      }
      if (entries.length >= 5000) break;
    }
  }
  return entries
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 20)
    .map((entry) => {
      const path = `${entry.path}${entry.directory ? "/" : ""}`;
      const needsQuotes = quoted || path.includes(" ");
      return {
        value: needsQuotes ? `@"${path}"` : `@${path}`,
        label: `${entry.path.split("/").at(-1)}${entry.directory ? "/" : ""}`,
        description: entry.path,
      };
    });
}

export async function mentionCompletions(
  provider: AutocompleteProvider,
  query: string,
  signal: AbortSignal,
): Promise<CompletionItem[]> {
  if (signal.aborted) return [];
  try {
    const token = query.startsWith("@") ? query : `@${query}`;
    const result = await provider.getSuggestions([token], 0, token.length, { signal });
    if (!result || signal.aborted) return [];
    return result.items.slice(0, 20).map((item) => ({
      value: String(item.value).slice(0, 1024),
      label: String(item.label).slice(0, 512),
      ...(item.description ? { description: String(item.description).slice(0, 1024) } : {}),
    }));
  } catch {
    return [];
  }
}
