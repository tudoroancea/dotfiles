import type { ComponentChildren } from "preact";
import type { ToolView } from "../lib/tool-model.js";

/**
 * A browser-side tool renderer. Adapters describe the label bar, the collapsed
 * summary, and the optional expandable detail for one tool. They never receive
 * or execute TUI renderer code — only the normalized, already-bounded view.
 */
export interface InlineToolRenderContext {
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
}

export interface ToolAdapter {
  /** Rail/label glyph, echoing the local compact renderers where one exists. */
  readonly glyph: string;
  /** Short human label for the tool, used in the label bar. */
  readonly label: string;
  /** Title-line content shown after the glyph (command, path, task, …). */
  title(view: ToolView): ComponentChildren;
  /** Collapsed one-line status/summary. */
  summary(view: ToolView): ComponentChildren;
  /** Expanded detail for rich/custom disclosures. */
  detail?(view: ToolView): ComponentChildren;
  /** Exporter-style inline body. Its expansion toggles output preview only. */
  inline?(view: ToolView, context: InlineToolRenderContext): ComponentChildren;
  /** Optional body modifier selected from normalized view data (for exporter spacing exceptions). */
  inlineBodyClass?(view: ToolView): string | undefined;
}
