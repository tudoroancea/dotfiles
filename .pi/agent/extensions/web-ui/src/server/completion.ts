import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { CompletionItem } from "../shared/wire.js";

const MAX_ITEMS = 20;

/**
 * ExtensionAPI.sendUserMessage deliberately bypasses Pi command/template/skill
 * expansion. Do not advertise slash entries until Pi exposes a public raw-input
 * dispatch API that preserves getCommands() invocation semantics.
 */
export function slashCompletions(
  _commands: readonly SlashCommandInfo[],
  _query: string,
): CompletionItem[] {
  return [];
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
