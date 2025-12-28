import { $ } from "bun";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Event, EventPermissionUpdated, EventPermissionReplied, EventSessionError } from "@opencode-ai/sdk";

/**
 * OpenCode Notification Plugin
 *
 * Celebrates successes with Raycast confetti when OpenCode is not focused
 * Sends system notifications on failures or permission requests
 */

interface NotificationState {
	lastNotificationTime: number;
	debounceMs: number;
}

const state: NotificationState = {
	lastNotificationTime: 0,
	debounceMs: 2000, // Prevent notification spam
};

/**
 * Check if the terminal/OpenCode is currently focused
 */
async function isTerminalFocused(): Promise<boolean> {
	try {
		const result: string =
			await $`osascript -e 'tell application "System Events"' -e 'set frontApp to name of first application process whose frontmost is true' -e 'end tell'`.text();
		const frontApp: string = result.trim();
		return frontApp.toLowerCase().includes("Ghostty");
	} catch (error: unknown) {
		console.error("Failed to check focused app:", error);
		return false;
	}
}

/**
 * Trigger Raycast confetti in background (without focusing Raycast)
 */
async function triggerConfetti(): Promise<void> {
	try {
		// -g flag prevents Raycast from being focused
		await $`open -g raycast://confetti`;
	} catch (error: unknown) {
		console.error("Failed to trigger confetti:", error);
	}
}

/**
 * Send a macOS system notification
 */
async function sendNotification(
	title: string,
	message: string,
	sound: boolean = true,
): Promise<void> {
	try {
		const soundArg: string = sound ? ' sound name "Glass"' : "";
		await $`osascript -e 'display notification "${message}" with title "${title}"'`;
	} catch (error: unknown) {
		console.error("Failed to send notification:", error);
	}
}

/**
 * Check if enough time has passed since last notification (debouncing)
 */
function shouldNotify(): boolean {
	const now: number = Date.now();
	if (now - state.lastNotificationTime < state.debounceMs) {
		return false;
	}
	state.lastNotificationTime = now;
	return true;
}

export const OpenCodeNotificationPlugin: Plugin = async ({
	project,
	client,
	directory,
	worktree,
}: PluginInput) => {
	return {
		/**
		 * Listen to all OpenCode events
		 */
		event: async ({ event }: { event: Event }) => {
			// Session completed successfully (primary agent only)
			if (event.type === "session.idle") {
				if (!shouldNotify()) return;

				const isFocused = await isTerminalFocused();

				if (!isFocused) {
					// Terminal not focused - celebrate with confetti!
					await triggerConfetti();
				} else {
					// Terminal is focused - user can already see the result
					// Optionally send a subtle notification anyway
					// await sendNotification("OpenCode", "Session completed", false);
				}
			}

			// Session encountered an error
			if (event.type === "session.error") {
				if (!shouldNotify()) return;

				const errorMsg: string = (event as EventSessionError).properties.error?.data?.message || "An error occurred";
				await sendNotification(
					"⚠️ OpenCode Error",
					errorMsg.slice(0, 100), // Truncate long messages
					true,
				);
			}

			// Permission request or reply
			if (
				event.type === "permission.updated" ||
				event.type === "permission.replied"
			) {
				if (!shouldNotify()) return;

				// Check if this is a new permission request (not already granted)
				let permissionType: string;
				if (event.type === "permission.updated") {
					permissionType = (event as EventPermissionUpdated).properties.type || "action";
				} else {
					permissionType = "reply";
				}

				await sendNotification(
					"🔐 OpenCode Permission",
					`Permission requested: ${permissionType}`,
					true,
				);
			}
		},
	};
};
