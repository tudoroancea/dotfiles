import { exec } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Pi Notify Extension (Consolidated)
 *
 * Provides:
 * - Desktop notifications via OSC 777 (Ghostty) & OSC 9 (iTerm2)
 * - Focus tracking (only notifies when you aren't looking at the terminal)
 * - Confetti celebration via Raycast
 */

// --- Focus Tracking State ---
let isFocused = true;
let lastActivityTime = Date.now();
let focusEventsReceived = false;
let focusReportingSupported = false;
let cleanupFocus: (() => void) | null = null;

const ACTIVITY_TIMEOUT_MS = 45000; // 45 seconds - assume unfocused if no activity
const DEBOUNCE_MS = 100; // Debounce rapid focus changes

function shouldNotify(): boolean {
	// If we receive focus events, trust them
	if (focusEventsReceived && focusReportingSupported) {
		return !isFocused;
	}

	// Fallback heuristic: If no activity for 45+ seconds, assume unfocused
	const inactiveTime = Date.now() - lastActivityTime;
	return inactiveTime > ACTIVITY_TIMEOUT_MS;
}

function setupFocusTracking() {
	if (cleanupFocus || !process.stdin.isTTY) return;

	process.stdout.write("\x1b[?1004h"); // Enable focus reporting
	focusReportingSupported = true;

	let pendingFocusChange: NodeJS.Timeout | null = null;

	const handleData = (data: Buffer) => {
		const str = data.toString();

		// Track activity for fallback heuristic
		lastActivityTime = Date.now();

		// Check for focus events
		if (str.includes("\x1b[I")) {
			focusEventsReceived = true;
			// Debounce rapid changes
			if (pendingFocusChange) clearTimeout(pendingFocusChange);
			pendingFocusChange = setTimeout(() => {
				isFocused = true;
				pendingFocusChange = null;
			}, DEBOUNCE_MS);
		}
		if (str.includes("\x1b[O")) {
			focusEventsReceived = true;
			// Debounce rapid changes
			if (pendingFocusChange) clearTimeout(pendingFocusChange);
			pendingFocusChange = setTimeout(() => {
				isFocused = false;
				pendingFocusChange = null;
			}, DEBOUNCE_MS);
		}
	};

	process.stdin.on("data", handleData);

	cleanupFocus = () => {
		process.stdout.write("\x1b[?1004l"); // Disable focus reporting
		process.stdin.off("data", handleData);
		cleanupFocus = null; // Fix: Allow re-setup on reload
	};
}

// --- Notification Logic ---
function sendNotification(title: string, message: string) {
	if (!shouldNotify()) return;

	// Sanitize: remove semicolons as they are delimiters for OSC 777
	const cleanTitle = title.replace(/;/g, " ").replace(/\s+/g, " ").trim();
	const cleanMessage = message.replace(/;/g, " ").replace(/\s+/g, " ").trim();

	// Send multiple protocols for better compatibility
	// OSC 777: Ghostty / WezTerm
	process.stdout.write(`\x1b]777;notify;${cleanTitle};${cleanMessage}\x07`);
	// OSC 9: iTerm2
	process.stdout.write(`\x1b]9;${cleanMessage}\x07`);
}

// --- Confetti Logic ---
async function triggerConfetti() {
	if (!shouldNotify()) return;
	// Only run on macOS
	if (process.platform === "darwin") {
		exec("open -g raycast://extensions/raycast/raycast/confetti");
	}
}

// --- Extension Entry Point ---
export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => setupFocusTracking());
	pi.on("session_shutdown", () => cleanupFocus?.());

	pi.on("tool_call", async (event) => {
		if (event.toolName === "question" || event.toolName === "questionnaire") {
			sendNotification(
				"❓ Pi has a question",
				"Check the terminal to provide input.",
			);
		}
	});

	pi.on("agent_end", async (event) => {
		const noConfetti = pi.getFlag("--no-confetti") as boolean;
		const lastAssistant = [...event.messages]
			.reverse()
			.find((m) => m.role === "assistant");

		const summary =
			typeof lastAssistant?.content === "string"
				? lastAssistant.content
				: Array.isArray(lastAssistant?.content)
					? lastAssistant.content
							.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join(" ")
					: "";

		const success =
			lastAssistant?.stopReason === "stop" ||
			lastAssistant?.stopReason === "toolUse";

		sendNotification(
			success ? "✅ Pi finished" : "⚠️ Pi stopped",
			summary || "Task completed.",
		);

		if (!noConfetti && success) {
			await triggerConfetti();
		}
	});

	pi.registerFlag("--no-confetti", {
		description: "Disable confetti",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("notify-test", {
		description: "Test notification",
		args: {
			wait: {
				description: "Seconds to wait before sending notification",
				type: "number",
				isOptional: true,
			},
		},
		handler: async (args, ctx) => {
			// Temporarily override focus state for testing
			const savedIsFocused = isFocused;
			const savedEventsReceived = focusEventsReceived;
			isFocused = false;
			focusEventsReceived = true; // Pretend we got focus events

			const waitSeconds = (args.wait as number) || 0;

			if (waitSeconds > 0) {
				ctx.ui.notify(
					`Waiting ${waitSeconds} seconds before sending notification...`,
					"info",
				);
				await new Promise((resolve) =>
					setTimeout(resolve, waitSeconds * 1000),
				);
			}

			sendNotification("🔔 Test", "Native notification working!");

			// Provide immediate feedback in the TUI so you know the command ran
			ctx.ui.notify("Sent test notification. Check your desktop!", "info");

			// Small delay before restoring state to ensure the write is processed
			await new Promise((resolve) => setTimeout(resolve, 100));
			isFocused = savedIsFocused;
			focusEventsReceived = savedEventsReceived;
		},
	});
}
