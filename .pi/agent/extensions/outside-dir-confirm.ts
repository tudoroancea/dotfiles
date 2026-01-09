/**
 * Outside Directory Confirmation Extension
 *
 * Prompts for confirmation before modifying files outside of the directory
 * pi was launched from. This includes:
 * - edit/write tool calls to paths outside the initial cwd
 * - bash commands that modify files outside the initial cwd (rm, sed -i, mv, cp, tee, etc.)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";

interface PathInfo {
	path: string;
	isOutside: boolean;
}

/**
 * Check if a path is outside the initial working directory.
 * Handles absolute paths and ~ expansion.
 */
function isOutsideCwd(filePath: string, initialCwd: string): boolean {
	// Expand ~ to home directory
	let expanded = filePath;
	if (filePath === "~") {
		expanded = process.env.HOME || filePath;
	} else if (filePath.startsWith("~/")) {
		expanded = (process.env.HOME || "") + filePath.slice(1);
	}

	// If already absolute, check if it's outside
	if (isAbsolute(expanded)) {
		const resolved = resolve(expanded);
		const cwdResolved = resolve(initialCwd);
		return !resolved.startsWith(cwdResolved + "/") && resolved !== cwdResolved;
	}

	// Relative path - resolve against initial cwd
	const resolved = resolve(initialCwd, expanded);
	const cwdResolved = resolve(initialCwd);
	return !resolved.startsWith(cwdResolved + "/") && resolved !== cwdResolved;
}

/**
 * Extract potential file paths from a bash command.
 * This is a best-effort parser that looks for common patterns.
 */
function extractPathsFromCommand(command: string): string[] {
	const paths: string[] = [];

	// Match common file manipulation commands
	// Pattern: command followed by flags and then a path
	const commandPatterns = [
		// rm [-rf] <path>
		/\brm\s+(?:-[a-zA-Z]+)*\s+([^\s;|>"']+)/g,
		// rmdir <path>
		/\brmdir\s+([^\s;|>"']+)/g,
		// mv <from> <to>
		/\bmv\s+(?:-[a-zA-Z]+)*\s+([^\s;|>"']+)\s+([^\s;|>"']+)/g,
		// cp <from> <to>
		/\bcp\s+(?:-[a-zA-Z]+)*\s+([^\s;|>"']+)\s+([^\s;|>"']+)/g,
		// ln [-s] <target> <link>
		/\bln\s+(?:-[a-zA-Z]+)*\s+([^\s;|>"']+)\s+([^\s;|>"']+)/g,
		// touch <path>
		/\btouch\s+([^\s;|>"']+)/g,
		// mkdir [-p] <path>
		/\bmkdir\s+(?:-[a-zA-Z]+)*\s+([^\s;|>"']+)/g,
		// chmod <perms> <path>
		/\bchmod\s+[a-zA-Z0-9]+\s+([^\s;|>"']+)/g,
		// chown <owner>[:group] <path>
		/\bchown\s+[^\s;|>"']+\s+([^\s;|>"']+)/g,
		// sed -i [<script>] <path> - script is optional, path always comes after
		/\bsed\s+-i\s*('[^']*'|"[^"]*"|[^'" ]+)?\s+([^\s;|>"']+)/g,
		// awk [<script>] <file> - script is optional, file always comes after
		/\bawk\s+(?:[^\s;|>"']+\s+)?([^\s;|>"']+)/g,
		// tee <path>
		/\btee\s+([^\s;|>"']+)/g,
		// cat > <path> (and variations)
		/\bcat\s+>(?:\s+)?([^\s;|>"']+)/g,
		// echo > <path>
		/\becho\s+[^>]*>\s*([^\s;|>"']+)/g,
		// printf > <path>
		/\bprintf\s+[^>]*>\s*([^\s;|>"']+)/g,
		// > <path> (redirection at start or after semicolon)
		/(?:^|;)\s*>\s*([^\s;|>"']+)/g,
		// >> <path> (append redirection)
		/(?:^|;)\s*>>\s*([^\s;|>"']+)/g,
	];

	for (const pattern of commandPatterns) {
		let match;
		while ((match = pattern.exec(command)) !== null) {
			const path = match[1];
			if (path && !paths.includes(path)) {
				paths.push(path);
			}
			// For patterns with two path groups (mv, cp, ln), add second path too
			if (match.length > 2 && match[2]) {
				const path2 = match[2];
				if (path2 && !paths.includes(path2)) {
					paths.push(path2);
				}
			}
		}
	}

	return paths;
}

export default function (pi: ExtensionAPI) {
	// Store the initial working directory when pi was launched
	const initialCwd = process.cwd();

	// Known special device files that are safe to ignore
	const ignoredPaths = ["/dev/null", "/dev/zero", "/dev/full"];

	// Helper to check paths and prompt if any are outside
	async function checkPaths(paths: string[], toolName: string, ctx: any, command?: string): Promise<{ block: boolean; reason: string } | undefined> {
		const outsidePaths: PathInfo[] = [];

		for (const path of paths) {
			// Skip known special device files
			if (ignoredPaths.includes(path)) continue;
			if (isOutsideCwd(path, initialCwd)) {
				outsidePaths.push({ path, isOutside: true });
			}
		}

		// Also check if the command itself contains dangerous patterns that modify files
		let hasDangerousCommand = false;
		if (toolName === "bash" && command) {
			const dangerousPatterns = [
				/\brm\s+/i,
				/\bmv\s+.*\s+[^\s;|>"']+$/, // mv with dest path
				/\bcp\s+.*\s+[^\s;|>"']+$/, // cp with dest path
				/\bsed\s+-i/i,
				/\btee\s+/i,
				/\btouch\s+/i,
				/\bchmod\s+[a-zA-Z0-9]+\s+/i,
				/\bchown\s+[^\s;|>"']+\s+/i,
				/>\s*[^\s;|>"']+/, // output redirection
				/>>\s*[^\s;|>"']+/, // append redirection
			];

			hasDangerousCommand = dangerousPatterns.some((p) => p.test(command));
		}

		// If no paths are outside and no dangerous command, allow
		if (outsidePaths.length === 0 && !hasDangerousCommand) {
			return undefined;
		}

		// If no UI, block by default for safety
		if (!ctx.hasUI) {
			const reason = outsidePaths.length > 0
				? `Blocked: would modify file outside launch directory: ${outsidePaths.map(p => p.path).join(", ")}`
				: "Blocked: dangerous command would modify files outside launch directory";
			return { block: true, reason };
		}

		// Build the confirmation message
		let title = `⚠️ ${toolName} operation outside launch directory`;
		let message = "";

		if (outsidePaths.length > 0) {
			message += "The following paths are outside the launch directory:\n\n";
			for (const p of outsidePaths) {
				message += `  • ${p.path}\n`;
			}
			message += `\nLaunch directory: ${initialCwd}\n\n`;
		}

		if (hasDangerousCommand && outsidePaths.length === 0) {
			message += "This command could modify files outside the launch directory.\n\n";
		}

		message += "Allow this operation?";

		const confirmed = await ctx.ui.confirm(title, message);

		if (!confirmed) {
			ctx.ui.notify("Operation cancelled", "info");
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	}

	pi.on("tool_call", async (event, ctx) => {
		const { toolName, input, toolCallId } = event;

		// Check edit tool
		if (toolName === "edit") {
			const path = input.path as string;
			const result = await checkPaths([path], toolName, ctx);
			if (result) return result;
		}

		// Check write tool
		if (toolName === "write") {
			const path = input.path as string;
			const result = await checkPaths([path], toolName, ctx);
			if (result) return result;
		}

		// Check bash tool for file-modifying commands
		if (toolName === "bash") {
			const command = input.command as string;

			// Check if this is a pure cd command to a path within or equal to the launch directory
			// This avoids prompting for confirmation when navigating to directories that are "inside" the launch dir
			const cdMatch = /^\s*cd\s+([^\s;|>"']+)/.exec(command);
			if (cdMatch) {
				const cdPath = cdMatch[1];
				// Expand ~ if present
				let expandedPath = cdPath;
				if (cdPath === "~") {
					expandedPath = process.env.HOME || cdPath;
				} else if (cdPath.startsWith("~/")) {
					expandedPath = (process.env.HOME || "") + cdPath.slice(1);
				}

				// Check if the cd target resolves to within or equal to the launch directory
				if (isAbsolute(expandedPath)) {
					const resolved = resolve(expandedPath);
					const cwdResolved = resolve(initialCwd);
					const isOutside = !resolved.startsWith(cwdResolved + "/") && resolved !== cwdResolved;

					// If cd is to a path outside the launch directory, still check it
					// But if it's within or equal, skip further checks
					if (!isOutside) {
						return undefined;
					}
				}
			}

			const paths = extractPathsFromCommand(command);
			const result = await checkPaths(paths, toolName, ctx, command);
			if (result) return result;
		}

		return undefined;
	});
}
