import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Focus debugging extension - helps diagnose focus reporting issues
 */

export default function (pi: ExtensionAPI) {
	pi.registerCommand("test-focus-raw", {
		description: "Monitor raw focus events from terminal",
		handler: async () => {
			if (!process.stdin.isTTY) {
				console.log("Not a TTY - focus reporting unavailable");
				return;
			}

			console.log("Monitoring focus events for 10 seconds...");
			console.log("Focus/unfocus your terminal to see events.");
			console.log("Press Ctrl+C to stop early.\n");

			// Enable focus reporting
			process.stdout.write("\x1b[?1004h");

			const events: { time: string; data: string; bytes: number[] }[] = [];
			const startTime = Date.now();

			const handler = (data: Buffer) => {
				const bytes = [...data];
				const str = data.toString();
				const time = ((Date.now() - startTime) / 1000).toFixed(2);

				// Check for focus in/out patterns
				const hasFocusIn = str.includes("\x1b[I");
				const hasFocusOut = str.includes("\x1b[O");

				events.push({ time, data: str, bytes });

				if (hasFocusIn) {
					console.log(`[${time}s] ✓ FOCUS IN (\\x1b[I)`);
				}
				if (hasFocusOut) {
					console.log(`[${time}s] ✗ FOCUS OUT (\\x1b[O)`);
				}

				// Also log other escape sequences for debugging
				if (str.includes("\x1b[") && !hasFocusIn && !hasFocusOut) {
					const escapeMatch = str.match(/\x1b\[[0-9;]*[A-Za-z]/g);
					if (escapeMatch) {
						console.log(`[${time}s] Other escape: ${escapeMatch.join(", ")}`);
					}
				}
			};

			process.stdin.on("data", handler);

			// Stop after 10 seconds
			await new Promise((resolve) => setTimeout(resolve, 10000));

			process.stdin.off("data", handler);
			process.stdout.write("\x1b[?1004l");

			console.log("\n--- Summary ---");
			console.log(`Total data events: ${events.length}`);
			const focusIns = events.filter((e) => e.data.includes("\x1b[I")).length;
			const focusOuts = events.filter((e) => e.data.includes("\x1b[O")).length;
			console.log(`Focus in events: ${focusIns}`);
			console.log(`Focus out events: ${focusOuts}`);
		},
	});
}
