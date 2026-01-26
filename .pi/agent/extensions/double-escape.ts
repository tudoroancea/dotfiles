import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

class DoubleEscapeEditor extends CustomEditor {
  private lastEscape = 0;
  private readonly timeout = 500; // milliseconds

  constructor(tui: any, theme: any, kb: any, private ctx: any) {
    super(tui, theme, kb);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      const now = Date.now();
      
      if (now - this.lastEscape < this.timeout) {
        // Double tap detected!
        this.lastEscape = 0;
        this.ctx.ui.setStatus("escape-hint", undefined);
        this.ctx.abort(); // Triggers the agent interrupt
        return;
      }
      
      this.lastEscape = now;
      
      // Show hint in status bar
      this.ctx.ui.setStatus("escape-hint", this.ctx.ui.theme.fg("warning", " Press Escape again to interrupt "));
      
      // Clear hint after timeout
      setTimeout(() => {
        if (this.lastEscape === now) {
          this.ctx.ui.setStatus("escape-hint", undefined);
        }
      }, this.timeout);

      // Pass the first escape to the base editor so it can still 
      // handle things like cancelling autocomplete.
      super.handleInput(data);
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
    ctx.ui.setEditorComponent((tui, theme, kb) => 
      new DoubleEscapeEditor(tui, theme, kb, ctx)
    );
  });
}
