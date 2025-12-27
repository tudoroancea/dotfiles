import { $ } from "bun";
import path from "path";

interface Credentials {
	claudeAiOauth: {
		accessToken: string;
		refreshToken: string;
		expiresAt: number;
		scopes: string[];
		subscriptionType: string;
	};
}

interface StatusLineInput {
	model: {
		display_name: string;
	};
	workspace: {
		current_dir: string;
	};
	context_window: {
		context_window_size: number;
		current_usage: {
			input_tokens: number;
			cache_creation_input_tokens: number;
			cache_read_input_tokens: number;
		} | null;
	};
}

interface GitStatus {
	branch: string;
	totalFiles: number;
	added: number;
	removed: number;
}

interface UsageLimits {
	five_hour: {
		utilization: number;
		resets_at: string | null;
	} | null;
	seven_day: {
		utilization: number;
		resets_at: string | null;
	} | null;
}

interface Colors {
	RED: string;
	GREEN: string;
	BLUE: string;
	YELLOW: string;
	CYAN: string;
	GRAY: string;
	NC: string;
}

const colors: Colors = {
	RED: "\x1b[0;31m",
	GREEN: "\x1b[0;32m",
	BLUE: "\x1b[0;34m",
	YELLOW: "\x1b[0;33m",
	CYAN: "\x1b[0;36m",
	GRAY: "\x1b[0;90m",
	NC: "\x1b[0m",
};

function getColorForUtilization(utilization: number): string {
	if (utilization > 80) return colors.RED;
	if (utilization > 50) return colors.YELLOW;
	return colors.GREEN;
}

function buildContextBar(
	currentUsage: number,
	totalSize: number,
): { bar: string; percent: number } {
	const percent = Math.round((currentUsage * 100) / totalSize);
	const barWidth = 15;
	const filled = Math.round((percent * barWidth) / 100);
	const empty = barWidth - filled;

	const bar = "█".repeat(filled) + "░".repeat(empty);

	return { bar, percent };
}

async function getGitStatus(dir: string): Promise<GitStatus | null> {
	try {
		const isGit = await $`git -C ${dir} rev-parse --is-inside-work-tree`
			.quiet()
			.text();

		if (!isGit.trim()) return null;

		const branch = await $`git -C ${dir} branch --show-current`.quiet().text();
		const statusOutput = await $`git -C ${dir} status --porcelain`
			.quiet()
			.text();

		if (!statusOutput.trim()) {
			return {
				branch: branch.trim() || "detached",
				totalFiles: 0,
				added: 0,
				removed: 0,
			};
		}

		const totalFiles = statusOutput.trim().split("\n").length;

		const stagedStats = await $`git -C ${dir} diff --numstat --cached`
			.quiet()
			.text()
			.catch(() => "");
		const unstagedStats = await $`git -C ${dir} diff --numstat`
			.quiet()
			.text()
			.catch(() => "");

		let stagedAdded = 0,
			stagedRemoved = 0,
			unstagedAdded = 0,
			unstagedRemoved = 0;

		stagedStats
			.trim()
			.split("\n")
			.forEach((line) => {
				const [added, removed] = line.split("\t").map(Number);
				if (!isNaN(added)) stagedAdded += added;
				if (!isNaN(removed)) stagedRemoved += removed;
			});

		unstagedStats
			.trim()
			.split("\n")
			.forEach((line) => {
				const [added, removed] = line.split("\t").map(Number);
				if (!isNaN(added)) unstagedAdded += added;
				if (!isNaN(removed)) unstagedRemoved += removed;
			});

		// Count lines in untracked files
		const untrackedLines =
			await $`git -C ${dir} status --porcelain | grep "^??" | awk '{print $2}' | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'`
				.quiet()
				.text()
				.catch(() => "0");

		const added =
			stagedAdded + unstagedAdded + parseInt(untrackedLines.trim() || "0");
		const removed = stagedRemoved + unstagedRemoved;

		return {
			branch: branch.trim() || "detached",
			totalFiles,
			added,
			removed,
		};
	} catch {
		return null;
	}
}

async function getCredentials(): Promise<string | null> {
	try {
		const result =
			await $`security find-generic-password -s "Claude Code-credentials" -w`
				.quiet()
				.text();
		const creds: Credentials = JSON.parse(result.trim());
		return creds.claudeAiOauth.accessToken;
	} catch {
		return null;
	}
}

async function fetchUsageLimits(token: string): Promise<UsageLimits | null> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Accept: "application/json, text/plain, */*",
				"Content-Type": "application/json",
				"User-Agent": "claude-code/2.0.31",
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"Accept-Encoding": "gzip, compress, deflate, br",
			},
		});

		if (!response.ok) {
			return null;
		}

		const data = await response.json();

		return {
			five_hour: data.five_hour || null,
			seven_day: data.seven_day || null,
		};
	} catch {
		return null;
	}
}

async function getUsageLimits(): Promise<UsageLimits> {
	try {
		const token = await getCredentials();
		if (!token) {
			return { five_hour: null, seven_day: null };
		}
		const limits = await fetchUsageLimits(token);
		return limits || { five_hour: null, seven_day: null };
	} catch {
		return { five_hour: null, seven_day: null };
	}
}

function formatGitInfo(status: GitStatus): string {
	let info = ` ${colors.YELLOW}(${status.branch}${colors.NC}`;

	if (status.totalFiles > 0) {
		info += ` ${colors.YELLOW}|${colors.NC} ${colors.GRAY}${status.totalFiles} files${colors.NC}`;

		if (status.added > 0) {
			info += ` ${colors.GREEN}+${status.added}${colors.NC}`;
		}
		if (status.removed > 0) {
			info += ` ${colors.RED}-${status.removed}${colors.NC}`;
		}
	}

	info += ` ${colors.YELLOW})${colors.NC}`;
	return info;
}

function formatUsageBar(utilization: number): { bar: string; percent: number } {
	const percent = Math.round(utilization);
	const barWidth = 15;
	const filled = Math.round((percent * barWidth) / 100);
	const empty = barWidth - filled;

	const color = getColorForUtilization(percent);
	const bar =
		color +
		"█".repeat(filled) +
		colors.NC +
		colors.GRAY +
		"░".repeat(empty) +
		colors.NC;

	return { bar, percent };
}

async function readStdin(): Promise<StatusLineInput> {
	const input = await Bun.stdin.text();
	return JSON.parse(input);
}

async function generateStatusLine() {
	try {
		const input = await readStdin();

		// Extract basic info
		const modelName = input.model.display_name;
		const currentDir = input.workspace.current_dir;
		const dirName = path.basename(currentDir);

		// Calculate context usage
		const contextSize = input.context_window.context_window_size || 200000;
		let contextInfo = "";
		if (input.context_window.current_usage) {
			const currentUsage =
				input.context_window.current_usage.input_tokens +
				input.context_window.current_usage.cache_creation_input_tokens +
				input.context_window.current_usage.cache_read_input_tokens;
			const { bar, percent } = buildContextBar(currentUsage, contextSize);
			contextInfo = `${bar} ${percent}%`;
		} else {
			contextInfo = `${colors.GRAY}${"░".repeat(15)}${colors.NC} 0%`;
		}

		// Get usage limits (5-hour only)
		const limits = await getUsageLimits();
		let usageInfo = "";
		if (
			limits.five_hour?.utilization !== null &&
			limits.five_hour?.utilization !== undefined
		) {
			const { bar, percent } = formatUsageBar(limits.five_hour.utilization);
			usageInfo = `${bar} ${percent}%`;
		} else {
			usageInfo = `${colors.GRAY}${"░".repeat(15)}${colors.NC} 0%`;
		}

		// Get git info
		const gitStatus = await getGitStatus(currentDir);
		let gitInfo = "";
		if (gitStatus) {
			gitInfo = formatGitInfo(gitStatus);
		}

		// Build final status line
		// Order: repo | model | context bar | 5h usage bar | git status
		const statusLine =
			`${colors.BLUE}${dirName}${colors.NC} ${colors.GRAY}|${colors.NC} ` +
			`${colors.CYAN}${modelName}${colors.NC} ${colors.GRAY}|${colors.NC} ` +
			(gitInfo ? `${gitInfo} ${colors.GRAY}|${colors.NC} ` : "") +
			`${contextInfo} ${colors.GRAY}|${colors.NC} ` +
			`${usageInfo}`;

		console.log(statusLine);
	} catch (error) {
		console.error("Error generating status line:", error);
		process.exit(1);
	}
}

generateStatusLine();
