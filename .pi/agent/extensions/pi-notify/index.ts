/**
 * Pi Notify Extension
 *
 * Provides desktop notifications when the agent completes tasks or requires attention,
 * plus confetti celebration via Raycast on successful completion.
 *
 * Features:
 * - Confetti on successful agent completion (via Raycast)
 * - Critical notification when agent needs attention (question tool, errors)
 * - Standard notification on agent completion
 * - Focus-aware: no notifications when terminal is focused
 * - Click-to-redirect: activates Ghostty when notification clicked
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { triggerConfetti } from "./src/confetti.js";
import {
	cleanupFocusTracking,
	isFocused,
	setupFocusTracking,
} from "./src/focus.js";
import { sendNotification } from "./src/notify.js";

export default function (pi: ExtensionAPI) {
	// Helper to check if notifications should be sent
	function shouldNotify(): boolean {
		const noNotify = pi.getFlag("--no-notify") as boolean;
		return !noNotify && !isFocused();
	}

	// Helper to get custom sound
	function getSound(): string | undefined {
		return pi.getFlag("--notify-sound") as string | undefined;
	}

	// Setup focus tracking on session start
	pi.on("session_start", async () => {
		setupFocusTracking();
	});

	// Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		cleanupFocusTracking();
	});

	// Detect question tool usage - notify immediately
	pi.on("tool_call", async (event) => {
		if (event.toolName === "question") {
			if (shouldNotify()) {
				// Don't await - would block the question tool from showing its UI
				sendNotification({
					title: "🔴 Pi has a question",
					message: "Please answer at your earliest convenience",
					critical: true,
					sound: getSound(),
				});
			}
		}
	});

	// Detect tool errors - notify immediately
	pi.on("tool_result", async (event) => {
		if (event.isError) {
			if (shouldNotify()) {
				// Don't await - don't block the agent loop
				sendNotification({
					title: "⚠️ Tool error",
					message: `Error in ${event.toolName}`,
					critical: true,
					sound: getSound(),
				});
			}
		}
	});

	// Handle agent end - confetti on success
	pi.on("agent_end", async () => {
		const noConfetti = pi.getFlag("--no-confetti") as boolean;

		// Confetti on successful completion (if not focused and not disabled)
		if (!noConfetti && !isFocused()) {
			await triggerConfetti();
		}
	});

	// Register flags for configuration
	pi.registerFlag("--no-confetti", {
		description: "Disable confetti on successful completion",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("--no-notify", {
		description: "Disable all notifications",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("--notify-sound", {
		description: "Custom notification sound (e.g., Ping, Pop, Glass, Basso)",
		type: "string",
		default: undefined,
	});

	// Register test command
	pi.registerCommand("notify-test", {
		description: "Send a test notification",
		handler: async (_args, ctx) => {
			await sendNotification({
				title: "🔔 Test Notification",
				message: "This is a test notification from Pi",
				critical: false,
				sound: getSound(),
			});
			if (ctx.hasUI) {
				ctx.ui.notify("Test notification sent", "info");
			}
		},
	});

	// Register confetti test command
	pi.registerCommand("confetti", {
		description: "Trigger confetti celebration",
		handler: async (_args, ctx) => {
			await triggerConfetti();
			if (ctx.hasUI) {
				ctx.ui.notify("🎉 Confetti!", "info");
			}
		},
	});
}
