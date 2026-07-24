import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class DoubleEscapeEditor extends CustomEditor {
  private lastEscape = 0;
  private readonly timeout = 500; // milliseconds

  constructor(
    tui: any,
    theme: any,
    kb: any,
    private ctx: any,
  ) {
    super(tui, theme, kb);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      // Let a single Escape dismiss autocomplete without counting it as an
      // interrupt request. CustomEditor will delegate to the base editor while
      // autocomplete is visible instead of invoking the app interrupt handler.
      if (this.isShowingAutocomplete()) {
        this.lastEscape = 0;
        this.ctx.ui.setStatus("escape-hint", undefined);
        super.handleInput(data);
        return;
      }

      const now = Date.now();

      if (now - this.lastEscape < this.timeout) {
        this.lastEscape = 0;
        this.ctx.ui.setStatus("escape-hint", undefined);
        // Pi wires this to its current interrupt handler, so this also handles
        // bash, retries, and compaction rather than only aborting an agent turn.
        this.onEscape?.();
        return;
      }

      this.lastEscape = now;
      this.ctx.ui.setStatus(
        "escape-hint",
        this.ctx.ui.theme.fg("warning", " Press Escape again to interrupt "),
      );

      setTimeout(() => {
        if (this.lastEscape === now) {
          this.lastEscape = 0;
          this.ctx.ui.setStatus("escape-hint", undefined);
        }
      }, this.timeout);

      // Intentionally swallow the first Escape. Passing it to CustomEditor
      // would invoke pi's normal single-Escape interrupt handler.
      return;
    }

    // Reset timer on any other keypress
    if (this.lastEscape !== 0) {
      this.lastEscape = 0;
      this.ctx.ui.setStatus("escape-hint", undefined);
    }
    super.handleInput(data);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Replace the default editor with our timed logic version
    ctx.ui.setEditorComponent((tui, theme, kb) => new DoubleEscapeEditor(tui, theme, kb, ctx));
  });
}
