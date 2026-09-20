import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  COPYABLE_REGIONS_SKILL_PATH,
  createCopyRegionsExtension,
  runCopyRegionCommand,
} from "../index.ts";

type CommandContext = Parameters<typeof runCopyRegionCommand>[0];

function assistant(textBlocks: string[]): SessionEntry {
  return {
    type: "message",
    id: "assistant-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: textBlocks.map((text) => ({ type: "text" as const, text })),
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

function context(options: {
  mode?: CommandContext["mode"];
  entries?: SessionEntry[];
  selection?: (items: string[]) => string | undefined;
  events?: string[];
}) {
  const events = options.events ?? [];
  const select = vi.fn(async (_title: string, items: string[]) => {
    events.push("select");
    return options.selection?.(items);
  });
  const notify = vi.fn();
  const ctx = {
    mode: options.mode ?? "tui",
    waitForIdle: vi.fn(async () => {
      events.push("idle");
    }),
    sessionManager: {
      getBranch: () => {
        events.push("branch");
        return options.entries ?? [];
      },
    },
    ui: { select, notify },
  } as unknown as CommandContext;
  return { ctx, select, notify, events };
}

describe("copy-regions extension", () => {
  it("registers only copy-region with a clear description", () => {
    const registerCommand = vi.fn();

    createCopyRegionsExtension(vi.fn())({
      on: vi.fn(),
      registerCommand,
    } as unknown as ExtensionAPI);

    expect(registerCommand).toHaveBeenCalledOnce();
    expect(registerCommand).toHaveBeenCalledWith(
      "copy-region",
      expect.objectContaining({
        description: expect.stringMatching(/fenced region.*whole/i),
        handler: expect.any(Function),
      }),
    );
    expect(registerCommand).not.toHaveBeenCalledWith("copy", expect.anything());
  });

  it("appends compact guidance to the chained system prompt before agent start", async () => {
    const on = vi.fn();
    createCopyRegionsExtension(vi.fn())({
      on,
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI);
    const handler = on.mock.calls.find(
      ([event]) => event === "before_agent_start",
    )?.[1] as (event: {
      systemPrompt: string;
    }) => Promise<{ systemPrompt: string }> | { systemPrompt: string };

    const result = await handler({ systemPrompt: "Prompt from earlier handlers." });

    expect(result.systemPrompt).toMatch(/^Prompt from earlier handlers\.\n\n/);
    expect(result.systemPrompt).toContain('[copy-region-N]: # "Short label"');
  });

  it.each(["startup", "reload"] as const)(
    "discovers the same exact absolute skill path on %s",
    async (reason) => {
      const on = vi.fn();
      createCopyRegionsExtension(vi.fn())({
        on,
        registerCommand: vi.fn(),
      } as unknown as ExtensionAPI);
      const handler = on.mock.calls.find(
        ([event]) => event === "resources_discover",
      )?.[1] as (event: {
        reason: "startup" | "reload";
        cwd: string;
      }) => Promise<{ skillPaths: string[] }> | { skillPaths: string[] };

      const result = await handler({ reason, cwd: "/unrelated-working-directory" });
      const expected = fileURLToPath(
        new URL("../skills/copyable-regions/SKILL.md", import.meta.url),
      );

      expect(result).toEqual({ skillPaths: [expected] });
      expect(result.skillPaths[0]).toBe(COPYABLE_REGIONS_SKILL_PATH);
      expect(isAbsolute(result.skillPaths[0] ?? "")).toBe(true);
      expect(existsSync(result.skillPaths[0] ?? "")).toBe(true);
    },
  );

  it("awaits idle, offers every region plus Whole message, and copies exact selected bytes", async () => {
    const source =
      '[copy-region-1]: # "First"\r\n\r\n```text\r\n  one  \r\n```\r\n' + "~~~bash\nsecond\n~~~\n";
    const harness = context({
      entries: [assistant([source])],
      selection: (items) => items[1],
    });
    const copy = vi.fn(async () => {});

    await runCopyRegionCommand(harness.ctx, copy);

    expect(harness.events.slice(0, 3)).toEqual(["idle", "branch", "select"]);
    expect(harness.select).toHaveBeenCalledWith("Copy region", [
      "1. First",
      "2. bash — second",
      "Whole message",
    ]);
    expect(copy).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledWith("second\n");
    expect(harness.notify).toHaveBeenCalledWith("Copied to clipboard.", "info");
  });

  it("copies the exact whole-message view without recognized annotations", async () => {
    const source = 'before\n\n[copy-region-2]: # "Keep bytes"\n```text\nvalue\n```\nafter  ';
    const harness = context({
      entries: [
        assistant([
          "before\n",
          '\n[copy-region-2]: # "Keep bytes"\n',
          "```text\nvalue\n```\nafter  ",
        ]),
      ],
      selection: (items) => items.at(-1),
    });
    const copy = vi.fn(async () => {});

    await runCopyRegionCommand(harness.ctx, copy);

    expect(copy).toHaveBeenCalledWith(source.replace('[copy-region-2]: # "Keep bytes"\n', ""));
  });

  it("does not copy when selection is cancelled", async () => {
    const harness = context({ entries: [assistant(["```text\nvalue\n```"])] });
    const copy = vi.fn(async () => {});

    await runCopyRegionCommand(harness.ctx, copy);

    expect(copy).not.toHaveBeenCalled();
  });

  it("reports clipboard failures", async () => {
    const harness = context({
      entries: [assistant(["text"])],
      selection: (items) => items.at(-1),
    });
    const copy = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });

    await runCopyRegionCommand(harness.ctx, copy);

    expect(harness.notify).toHaveBeenCalledWith("Could not copy to clipboard.", "error");
  });

  it.each([
    { entries: [], message: "No assistant message to copy." },
    { entries: [assistant([" \r\n\t"])], message: "Newest assistant message has no text to copy." },
  ])("reports missing assistant text without selecting", async ({ entries, message }) => {
    const harness = context({ entries });
    const copy = vi.fn(async () => {});

    await runCopyRegionCommand(harness.ctx, copy);

    expect(harness.notify).toHaveBeenCalledWith(message, "warning");
    expect(harness.select).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it.each(["rpc", "json", "print"] as const)(
    "does not wait, select, or copy in %s mode",
    async (mode) => {
      const harness = context({ mode, entries: [assistant(["text"])] });
      const copy = vi.fn(async () => {});

      await runCopyRegionCommand(harness.ctx, copy);

      expect(harness.ctx.waitForIdle).not.toHaveBeenCalled();
      expect(harness.select).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(harness.notify).toHaveBeenCalledWith(
        "Copy region is available only in TUI mode.",
        "warning",
      );
    },
  );
});
