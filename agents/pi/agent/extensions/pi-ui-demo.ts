import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function withBlockedUI<T>(pi: ExtensionAPI, label: string, show: () => Promise<T>): Promise<T> {
  pi.events.emit("herdr:blocked", { active: true, label });
  try {
    return await show();
  } finally {
    pi.events.emit("herdr:blocked", { active: false });
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ui_demo",
    label: "UI Demo",
    description: "Show a short sequence demonstrating Pi's select, input, confirm, editor, and notification UIs.",
    promptSnippet: "Run a short interactive demonstration of Pi's built-in UI dialogs",
    parameters: Type.Object({}),
    executionMode: "sequential",

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "UI demo requires interactive or RPC mode." }] };
      }

      const color = await withBlockedUI(pi, "Choosing a color", () =>
        ctx.ui.select("Choose a color", ["Blue", "Green", "Orange"]),
      );
      const name = await withBlockedUI(pi, "Entering a name", () =>
        ctx.ui.input("What should I call you?", "Ada"),
      );
      const confirmed = await withBlockedUI(pi, "Confirming choices", () =>
        ctx.ui.confirm("Continue?", `Use ${name || "Anonymous"} and ${color || "no color"}?`),
      );
      const note = await withBlockedUI(pi, "Editing a note", () =>
        ctx.ui.editor("Add a short note", "Custom multi-line editors work too."),
      );

      const result = { color: color ?? null, name: name ?? null, confirmed, note: note ?? null };
      ctx.ui.notify(confirmed ? "UI demo complete!" : "UI demo complete (not confirmed).", confirmed ? "info" : "warning");

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
