/**
 * Custom Header Extension
 *
 * Demonstrates ctx.ui.setHeader() for replacing the built-in header
 * (logo + keybinding hints) with a custom component showing the pi mascot
 * alongside agent version and model info.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import * as os from "node:os";

// --- PI MASCOT ---
// Based on pi_mascot.ts - the pi agent character
function getPiMascot(theme: Theme): string[] {
	// --- COLORS ---
	// 3b1b Blue: R=80, G=180, B=230
	const piBlue = (text: string) => theme.fg("accent", text);
	const white = (text: string) => text; // Use plain white (or theme.fg("text", text))
	const black = (text: string) => theme.fg("dim", text); // Use dim for contrast

	// --- GLYPHS ---
	const BLOCK = "█";
	const PUPIL = "▌"; // Vertical half-block for the pupil

	// --- CONSTRUCTION ---

	// 1. The Eye Unit: [White Full Block][Black Vertical Sliver]
	// This creates the "looking sideways" effect
	const eye = `${white(BLOCK)}${black(PUPIL)}`;

	// 2. Line 1: The Eyes
	// 5 spaces indent aligns them with the start of the legs
	const lineEyes = `      ${eye}  ${eye}`;

	// 3. Line 2: The Wide Top Bar (The "Overhang")
	// 14 blocks wide for that serif-style roof
	const lineBar = `  ${piBlue(BLOCK.repeat(14))}`;

	// 4. Lines 3-6: The Legs
	// Indented 5 spaces relative to the very left edge
	// Leg width: 2 blocks | Gap: 4 blocks
	const lineLeg = `     ${piBlue(BLOCK.repeat(2))}    ${piBlue(BLOCK.repeat(2))}`;

	// --- ASSEMBLY ---
	return [lineEyes, lineBar, lineLeg, lineLeg, lineLeg, lineLeg];
}

function abbreviatePath(fullPath: string): string {
	const home = os.homedir();
	if (fullPath.startsWith(home)) {
		return "~" + fullPath.slice(home.length);
	}
	return fullPath;
}

// Strip ANSI codes to calculate visual width
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export default function (pi: ExtensionAPI) {
	// Set custom header immediately on load (if UI is available)
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setHeader((_tui, theme) => {
				return {
					render(_width: number): string[] {
						const mascotLines = getPiMascot(theme);

						// Get model info
						const model = ctx.model;
						const modelDisplay = model
							? `${model.displayName || model.id}`
							: "No model";

						// Get abbreviated path
						const displayPath = abbreviatePath(ctx.cwd);

						// Build info text
						const muted = (text: string) => theme.fg("muted", text);
						const accent = (text: string) => theme.fg("accent", text);

						// Info lines to display on the right (pi agent, not Claude Code)
						const infoLines = [
							accent("pi v0.52.9"), // pi agent version
							muted(modelDisplay),
							muted(displayPath),
							theme.italic(muted("keep working on hard things")),
						];

						// Create the combined layout
						const combined: string[] = [];
						combined.push(""); // Empty line at top

						// Combine mascot and info lines
						for (let i = 0; i < Math.max(mascotLines.length, infoLines.length); i++) {
							const mascotLine = mascotLines[i] || "";
							const infoLine = infoLines[i] || "";

							// Calculate visual width (strip ANSI codes)
							const visualWidth = stripAnsi(mascotLine).length;
							const padding = " ".repeat(Math.max(0, 18 - visualWidth)) + "  ";

							combined.push(mascotLine + padding + infoLine);
						}

						combined.push(""); // Empty line at bottom

						return combined;
					},
					invalidate() {},
				};
			});
		}
	});

	// Command to restore built-in header
	pi.registerCommand("builtin-header", {
		description: "Restore built-in header with keybinding hints",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
