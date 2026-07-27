import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { mentionCompletions, slashCompletions } from "../src/server/completion.js";
import { applyCompletion, detectCompletion } from "../src/web/completion.js";

describe("completion services", () => {
  it("does not advertise slash commands without a public raw-input dispatch API", () => {
    const commands = [
      { name: "copy-remote-url", description: "Copy", source: "extension" },
      { name: "fix", description: "Fix", source: "prompt" },
      { name: "skill:test", source: "skill" },
      { name: "settings", source: "builtin" },
      { name: "x".repeat(600), source: "extension" },
    ] as unknown as SlashCommandInfo[];
    expect(slashCompletions(commands, "")).toEqual([]);
  });

  it("reuses and caps the current mention provider", async () => {
    const provider = {
      getSuggestions: async () => ({
        prefix: "@foo",
        items: Array.from({ length: 30 }, (_, index) => ({
          value: index === 0 ? '@"foo bar.ts"' : `@foo-${index}`,
          label: `foo-${index}`,
        })),
      }),
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    } as AutocompleteProvider;
    const items = await mentionCompletions(provider, "foo", new AbortController().signal);
    expect(items).toHaveLength(20);
    expect(items[0]?.value).toBe('@"foo bar.ts"');
    expect(await mentionCompletions(undefined, "foo", new AbortController().signal)).toEqual([]);
  });

  it("detects and replaces slash and quoted mention tokens", () => {
    const slash = detectCompletion("/cop", 4)!;
    expect(applyCompletion("/cop", slash, { value: "/copy-remote-url", label: "copy" })).toEqual({
      value: "/copy-remote-url",
      cursor: 16,
    });
    const quoted = detectCompletion('read @"foo b', 12)!;
    expect(quoted.query).toBe('@"foo b');
    const mention = detectCompletion("read @foo", 9)!;
    expect(
      applyCompletion("read @foo next", mention, { value: '@"foo bar.ts"', label: "foo" }),
    ).toEqual({ value: 'read @"foo bar.ts" next', cursor: 18 });
    expect(
      applyCompletion('read @"foo b" next', quoted, {
        value: '@"foo bar.ts"',
        label: "foo",
      }),
    ).toEqual({ value: 'read @"foo bar.ts" next', cursor: 18 });
  });
});
