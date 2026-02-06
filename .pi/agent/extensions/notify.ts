import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "node:child_process";

/**
 * Pi Notify Extension (Consolidated)
 *
 * Provides:
 * - Desktop notifications via OSC 777 (Ghostty/iTerm/WezTerm)
 * - Focus tracking (only notifies when you aren't looking at the terminal)
 * - Confetti celebration via Raycast
 */

// --- Focus Tracking State ---
let isFocused = true;
let cleanupFocus: (() => void) | null = null;

function setupFocusTracking() {
	if (cleanupFocus || !process.stdin.isTTY) return;
	process.stdout.write("\x1b[?1004h"); // Enable focus reporting
	const handleData = (data: Buffer) => {
		const str = data.toString();
		if (str.includes("\x1b[I")) isFocused = true;
		if (str.includes("\x1b[O")) isFocused = false;
	};
	process.stdin.on("data", handleData);
	cleanupFocus = () => {
		process.stdout.write("\x1b[?1004l"); // Disable focus reporting
		process.stdin.off("data", handleData);
	};
}

// --- Notification Logic ---
function sendNotification(title: string, message: string) {
	if (isFocused) return;
	const cleanMessage = message.replace(/\s+/g, " ").trim();
	process.stdout.write(`\x1b]777;notify;${title};${cleanMessage}\x07`);
}

// --- Confetti Logic ---
async function triggerConfetti() {
	if (isFocused) return;
	exec("open -g raycast://extensions/raycast/raycast/confetti");
}

// --- Extension Entry Point ---
export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => setupFocusTracking());
	pi.on("session_shutdown", () => cleanupFocus?.());

	pi.on("tool_call", async (event) => {
		if (event.toolName === "question" || event.toolName === "questionnaire") {
			sendNotification("🔴 Pi has a question", "Check the terminal to provide input.");
		}
	});

	pi.on("agent_end", async (event) => {
		const noConfetti = pi.getFlag("--no-confetti") as boolean;
		const lastAssistant = [...event.messages].reverse().find(m => m.role === "assistant");
		
		const summary = typeof lastAssistant?.content === "string" 
			? lastAssistant.content 
			: Array.isArray(lastAssistant?.content)
				? lastAssistant.content.filter(p => p.type === "text").map(p => p.text).join(" ")
				: "";

		const success = lastAssistant?.stopReason === "stop" || lastAssistant?.stopReason === "toolUse";

		sendNotification(success ? "✅ Pi finished" : "⚠️ Pi stopped", summary || "Task completed.");
		
		if (!noConfetti && success) {
			await triggerConfetti();
		}
	});

	pi.registerFlag("--no-confetti", { description: "Disable confetti", type: "boolean", default: false });
	
	pi.registerCommand("notify-test", {
		description: "Test notification",
		handler: async () => {
			const originalFocus = isFocused;
			isFocused = false; // Force it for the test
			sendNotification("🔔 Test", "Native notification working!");
			isFocused = originalFocus;
		}
	});
}
