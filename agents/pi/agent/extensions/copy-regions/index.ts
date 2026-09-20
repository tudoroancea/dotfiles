import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCopyRegionsGuidance } from "./guidance.ts";
import {
  extractLatestAssistantText,
  formatRegionSelectorLabels,
  parseCopyRegions,
} from "./regions.ts";

type ClipboardCopy = (text: string) => Promise<void>;

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
export const COPYABLE_REGIONS_SKILL_PATH = join(
  extensionDirectory,
  "skills",
  "copyable-regions",
  "SKILL.md",
);

type CopyRegionCommandContext = Pick<
  ExtensionCommandContext,
  "mode" | "sessionManager" | "waitForIdle"
> & {
  ui: Pick<ExtensionCommandContext["ui"], "notify" | "select">;
};

export async function runCopyRegionCommand(
  ctx: CopyRegionCommandContext,
  copy: ClipboardCopy,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Copy region is available only in TUI mode.", "warning");
    return;
  }

  await ctx.waitForIdle();
  const latest = extractLatestAssistantText(ctx.sessionManager);
  if (latest.status === "no-assistant") {
    ctx.ui.notify("No assistant message to copy.", "warning");
    return;
  }
  if (latest.status === "no-meaningful-text") {
    ctx.ui.notify("Newest assistant message has no text to copy.", "warning");
    return;
  }

  const parsed = parseCopyRegions(latest.text);
  const options = [...formatRegionSelectorLabels(parsed.regions), "Whole message"];
  const selected = await ctx.ui.select("Copy region", options);
  if (selected === undefined) return;

  const selectedIndex = options.indexOf(selected);
  const payload =
    selectedIndex === parsed.regions.length
      ? parsed.wholeText
      : parsed.regions[selectedIndex]?.payload;
  if (payload === undefined) return;

  try {
    await copy(payload);
    ctx.ui.notify("Copied to clipboard.", "info");
  } catch {
    ctx.ui.notify("Could not copy to clipboard.", "error");
  }
}

export function createCopyRegionsExtension(copy: ClipboardCopy = copyToClipboard) {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: appendCopyRegionsGuidance(event.systemPrompt),
    }));
    pi.on("resources_discover", () => ({
      skillPaths: [COPYABLE_REGIONS_SKILL_PATH],
    }));

    pi.registerCommand("copy-region", {
      description: "Copy a fenced region or the whole latest assistant message",
      handler: async (_args, ctx) => runCopyRegionCommand(ctx, copy),
    });
  };
}

export default createCopyRegionsExtension();
