import { isAbsolute, relative, sep } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

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

interface CostRecord {
  costId: string;
  cost: number;
}

function isCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addDetailsCost(
  details: unknown,
  unkeyed: { total: number },
  keyed: Map<string, number>,
): void {
  if (!details || typeof details !== "object") return;

  const value = details as {
    cost?: unknown;
    costId?: unknown;
    costs?: unknown;
  };
  if (isCost(value.cost)) {
    if (typeof value.costId === "string") {
      keyed.set(value.costId, Math.max(keyed.get(value.costId) ?? 0, value.cost));
    } else {
      unkeyed.total += value.cost;
    }
  }

  if (!Array.isArray(value.costs)) return;
  for (const candidate of value.costs) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Partial<CostRecord>;
    if (typeof record.costId !== "string" || !isCost(record.cost)) continue;
    keyed.set(record.costId, Math.max(keyed.get(record.costId) ?? 0, record.cost));
  }
}

export function getSessionCost(entries: readonly unknown[]): number {
  const unkeyed = { total: 0 };
  const keyed = new Map<string, number>();

  for (const candidate of entries) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
      details?: unknown;
      message?: {
        role?: unknown;
        usage?: { cost?: { total?: unknown } };
        details?: unknown;
      };
    };

    if (entry.type === "custom" && entry.customType === "agentflow-cost") {
      addDetailsCost(entry.data, unkeyed, keyed);
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "agentflow-result") {
      addDetailsCost(entry.details, unkeyed, keyed);
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;

    if (entry.message.role === "assistant") {
      const cost = entry.message.usage?.cost?.total;
      if (isCost(cost)) unkeyed.total += cost;
      continue;
    }
    if (entry.message.role === "toolResult" || entry.message.role === "custom") {
      addDetailsCost(entry.message.details, unkeyed, keyed);
    }
  }

  return unkeyed.total + [...keyed.values()].reduce((sum, cost) => sum + cost, 0);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[mGKHJ]/g, "")
    .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\]8;;[^\x07]*\x07/g, "");
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
    ctx.ui.setFooter(() => ({
      invalidate() {},
      render: () => [],
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
