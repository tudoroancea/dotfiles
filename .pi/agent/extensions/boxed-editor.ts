import { isAbsolute, relative, sep } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { getSessionCost } from "./agentflow/src/session-cost.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type ThinkingColor =
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax";

const THINKING_COLORS: Record<ThinkingLevel, ThinkingColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function shortenPath(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;

  const fromHome = relative(home, cwd);
  if (fromHome === "") return "~";
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    return cwd;
  }
  return `~${sep}${fromHome}`;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[mGKHJ]/g, "")
    .replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function composeActivityFooter(
  statuses: ReadonlyMap<string, string>,
  width: number,
  ellipsis = "…",
): string[] {
  const activity = [...statuses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, status]) => sanitizeStatus(status))
    .filter(Boolean)
    .join("  ");
  if (!activity || width <= 0) return [];

  return [truncateToWidth(`  ${activity}`, width, ellipsis)];
}

class BoxedEditor extends CustomEditor {
  private stats = "";
  private model = "";
  private thinkingLevel: ThinkingLevel = "off";
  private cwd = "";

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly appTheme: Theme,
  ) {
    super(tui, editorTheme, keybindings);
  }

  setIndicators(indicators: {
    stats: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    cwd: string;
  }): void {
    this.stats = indicators.stats;
    this.model = indicators.model;
    this.thinkingLevel = indicators.thinkingLevel;
    this.cwd = indicators.cwd;
    this.tui.requestRender();
  }

  private border(
    width: number,
    corners: [string, string],
    left: string,
    right: string,
    originalLine: string,
  ): string {
    const scrollIndicator = stripAnsi(originalLine).match(/[↑↓]\s+\d+\s+more/)?.[0] ?? "";
    const rightText = [right, scrollIndicator].filter(Boolean).join(" · ");
    const innerWidth = width - 2;
    const fill = innerWidth - 2 - visibleWidth(left) - visibleWidth(rightText);

    if (fill < 0) {
      return this.appTheme.fg("dim", corners[0] + "─".repeat(Math.max(0, innerWidth)) + corners[1]);
    }

    return (
      this.appTheme.fg("dim", `${corners[0]}─`) +
      left +
      this.appTheme.fg("dim", "─".repeat(fill)) +
      rightText +
      this.appTheme.fg("dim", `─${corners[1]}`)
    );
  }

  private findBottomBorder(lines: string[]): number {
    for (let index = lines.length - 1; index >= 1; index--) {
      if (stripAnsi(lines[index] ?? "").startsWith("─")) return index;
    }
    return lines.length - 1;
  }

  override render(width: number): string[] {
    if (width < 6) return super.render(width);

    const lines = super.render(width - 2);
    if (lines.length < 2) return lines;

    const bottomBorder = this.findBottomBorder(lines);
    const thinking = this.appTheme.fg(THINKING_COLORS[this.thinkingLevel], this.thinkingLevel);
    const topRight = [this.model, thinking].filter(Boolean).join(" · ");
    const result = [this.border(width, ["╭", "╮"], this.stats, topRight, lines[0] ?? "")];

    for (let index = 1; index < bottomBorder; index++) {
      result.push(this.appTheme.fg("dim", "│") + lines[index] + this.appTheme.fg("dim", "│"));
    }

    result.push(this.border(width, ["╰", "╯"], "", this.cwd, lines[bottomBorder] ?? ""));

    for (let index = bottomBorder + 1; index < lines.length; index++) {
      result.push(` ${lines[index]} `);
    }

    return result;
  }
}

function updateIndicators(
  editor: BoxedEditor | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!editor) return;

  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  const contextPercent = usage?.percent == null ? (usage ? "?" : "0") : Math.round(usage.percent);
  const context = contextWindow ? `${contextPercent}% of ${formatTokens(contextWindow)}` : "";
  const cost = `$${getSessionCost(ctx.sessionManager.getBranch()).toFixed(2)}`;
  const model = ctx.model ? `(${ctx.model.provider}) ${ctx.model.id}` : "no model";

  editor.setIndicators({
    stats: [context, cost].filter(Boolean).join(" · "),
    model,
    thinkingLevel: pi.getThinkingLevel(),
    cwd: shortenPath(ctx.cwd),
  });
}

export default function boxedEditorExtension(pi: ExtensionAPI): void {
  let editor: BoxedEditor | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      editor = new BoxedEditor(tui, editorTheme, keybindings, ctx.ui.theme);
      return editor;
    });
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render: (width) =>
        composeActivityFooter(footerData.getExtensionStatuses(), width, theme.fg("dim", "…")),
    }));
    updateIndicators(editor, pi, ctx);
  });

  pi.on("model_select", (_event, ctx) => updateIndicators(editor, pi, ctx));
  pi.on("thinking_level_select", (_event, ctx) => updateIndicators(editor, pi, ctx));
  pi.on("turn_end", (_event, ctx) => updateIndicators(editor, pi, ctx));
  pi.on("agent_end", (_event, ctx) => updateIndicators(editor, pi, ctx));
  pi.on("session_tree", (_event, ctx) => updateIndicators(editor, pi, ctx));
  pi.on("session_compact", (_event, ctx) => updateIndicators(editor, pi, ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setFooter(undefined);
    editor = undefined;
  });
}
