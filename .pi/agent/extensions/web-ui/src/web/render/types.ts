import type { ComponentChildren } from "preact";
import type { ToolView } from "../lib/tool-model.js";

/**
 * A browser-side tool renderer. Adapters describe the label bar, the collapsed
 * summary, and the optional expandable detail for one tool. They never receive
 * or execute TUI renderer code — only the normalized, already-bounded view.
 */
export interface ToolAdapter {
  /** Rail/label glyph, echoing the local compact renderers where one exists. */
  readonly glyph: string;
  /** Short human label for the tool, used in the label bar. */
  readonly label: string;
  /** Title-line content shown after the glyph (command, path, task, …). */
  title(view: ToolView): ComponentChildren;
  /** Collapsed one-line status/summary. */
  summary(view: ToolView): ComponentChildren;
  /** Expanded detail; omit when the tool has nothing more to show. */
  detail?(view: ToolView): ComponentChildren;
}
