import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { CompletionItem } from "../shared/wire.js";

const MAX_ITEMS = 20;

export function slashCompletions(
  commands: readonly SlashCommandInfo[],
  query: string,
): CompletionItem[] {
  const needle = query.replace(/^\//, "").toLowerCase();
  return commands
    .filter((command) => ["extension", "prompt", "skill"].includes(command.source))
    .filter((command) => command.name.toLowerCase().includes(needle))
    .filter((command) => `/${command.name}`.length <= 512)
    .slice(0, MAX_ITEMS)
    .map((command) => ({
      value: `/${command.name}`,
      label: `/${command.name}`,
      ...(command.description ? { description: command.description.slice(0, 1024) } : {}),
      source: command.source,
    }));
}

export async function mentionCompletions(
  provider: AutocompleteProvider | undefined,
  query: string,
  signal: AbortSignal,
): Promise<CompletionItem[]> {
  if (!provider || signal.aborted) return [];
  try {
    const token = query.startsWith("@") ? query : `@${query}`;
    const result = await provider.getSuggestions([token], 0, token.length, { signal });
    if (!result || signal.aborted) return [];
    return result.items.slice(0, MAX_ITEMS).map((item: AutocompleteItem) => ({
      value: item.value.slice(0, 1024),
      label: item.label.slice(0, 512),
      ...(item.description ? { description: item.description.slice(0, 1024) } : {}),
      source: "mention",
    }));
  } catch {
    return [];
  }
}
