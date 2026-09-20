/**
 * Compact renderers for Pi's seven built-in tools.
 *
 * The renderers live in `lib/tools/builtin.ts` next to the shared primitives, mirroring the
 * browser's `client/tools/builtin.tsx`; see `TUI_RENDERING.md`.
 *
 * Pi has no renderer-registration API: the only way to replace a renderer is to register a
 * tool under the same name, which replaces its `execute` as well. Two consequences shape this
 * file.
 *
 * **Registration is split across load and `session_start`.** Pi rebuilds historical TUI rows
 * before `session_start` on reload and session replacement, and each row snapshots the tool
 * definition it sees. `bash` is therefore registered at load so those rows get its compact
 * renderer. The other six stay deferred: the refresh following extension loading activates
 * every extension tool (`includeAllExtensionTools`), so broader preloading could silently
 * expand the model's capabilities. `session_start` then re-registers all seven with the real
 * session cwd and settings before the user can invoke them. Explicit CLI tool restrictions
 * disable even the provisional bash registration.
 *
 * **The definitions carry the settings Pi would have applied.** Pi builds its own with
 * `read: {autoResizeImages}` and `bash: {commandPrefix, shellPath}`; a re-created definition
 * without them silently drops those settings. Only global settings are read here: an
 * extension cannot see Pi's project-trust decision, and honoring an untrusted project's
 * `shellPath` would be worse than ignoring a trusted one's.
 */

import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinRegistrations } from "./lib/tools/builtin.ts";

const EXPLICIT_TOOL_SELECTION_FLAGS = new Set([
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
]);

function hasExplicitToolSelection(argv: readonly string[]): boolean {
  return argv.some((arg) => EXPLICIT_TOOL_SELECTION_FLAGS.has(arg));
}

export default function builtinToolRenderers(
  pi: ExtensionAPI,
  argv: readonly string[] = process.argv.slice(2),
): void {
  const register = (registrations: ReturnType<typeof builtinRegistrations>): void => {
    for (const { definition, renderer } of registrations) {
      pi.registerTool({
        ...definition,
        // Built-in `edit` draws its own framing; the compact renderers want the standard
        // status-tinted box every other tool call lives in. Slots left undefined by the
        // renderer fall back to the built-in's own, which Pi resolves per slot.
        renderShell: "default",
        renderCall: renderer.renderCall,
        renderResult: renderer.renderResult,
      });
    }
  };

  // This provisional definition exists only so transcript reconstruction can capture the bash
  // renderer. session_start replaces it with one using the actual session cwd and settings
  // before tool execution is possible. Agentflow children do not load global extensions by
  // default; explicitly configured child extensions remain subject to the child's tool allowlist.
  // Avoid changing the meaning of explicit CLI restrictions in the main process.
  if (!hasExplicitToolSelection(argv)) {
    register(
      builtinRegistrations(process.cwd()).filter(({ definition }) => definition.name === "bash"),
    );
  }

  pi.on("session_start", (_event, ctx) => {
    const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: false });
    register(
      builtinRegistrations(ctx.cwd, {
        autoResizeImages: settings.getImageAutoResize(),
        shellCommandPrefix: settings.getShellCommandPrefix(),
        shellPath: settings.getShellPath(),
      }),
    );
  });
}
