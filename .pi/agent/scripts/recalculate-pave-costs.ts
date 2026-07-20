#!/usr/bin/env node

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import modelsConfig from "../models.json" with { type: "json" };

type JsonObject = Record<string, unknown>;

type Rates = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

type CostTier = Rates & {
	inputTokensAbove: number;
};

type ModelPricing = Rates & {
	tiers: CostTier[];
};

type FileUpdate = {
	path: string;
	content: string;
	turnsSeen: number;
	turnsUpdated: number;
};

class InvalidSessionError extends Error {}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const modelsPath = resolve(scriptDirectory, "..", "models.json");

function usage(): string {
	return `Usage: recalculate-pave-costs.ts [--dry-run] <session.jsonl|directory>

Recalculate persisted costs for pave assistant turns using the current pave pricing
in ${modelsPath}. Directory inputs discover *.jsonl files up to depth 3.`;
}

function parseArguments(): { dryRun: boolean; inputPath: string } {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(usage());
		process.exit(0);
	}

	const dryRun = args.includes("--dry-run");
	const positional = args.filter((argument) => argument !== "--dry-run");
	if (positional.length !== 1 || positional[0].startsWith("-")) {
		throw new Error(usage());
	}

	const inputPath = positional[0] === "~"
		? homedir()
		: positional[0].startsWith("~/")
			? join(homedir(), positional[0].slice(2))
			: positional[0];
	return { dryRun, inputPath: resolve(inputPath) };
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(object: JsonObject, field: string, context: string): number {
	const value = object[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${context}.${field} is not a finite number`);
	}
	return value;
}

function ratesFrom(object: JsonObject, context: string): Rates {
	return {
		input: requireNumber(object, "input", context),
		output: requireNumber(object, "output", context),
		cacheRead: requireNumber(object, "cacheRead", context),
		cacheWrite: requireNumber(object, "cacheWrite", context),
	};
}

function loadPavePricing(): Map<string, ModelPricing> {
	const config: unknown = modelsConfig;
	if (!isObject(config) || !isObject(config.providers) || !isObject(config.providers.pave)) {
		throw new Error(`${modelsPath} has no providers.pave object`);
	}

	const models = config.providers.pave.models;
	if (!Array.isArray(models)) {
		throw new Error(`${modelsPath} has no providers.pave.models array`);
	}

	const pricing = new Map<string, ModelPricing>();
	for (const model of models) {
		if (!isObject(model) || typeof model.id !== "string" || !isObject(model.cost)) {
			throw new Error(`${modelsPath} contains an invalid pave model`);
		}
		const tiersValue = model.cost.tiers ?? [];
		if (!Array.isArray(tiersValue)) {
			throw new Error(`${modelsPath}: pave/${model.id}.cost.tiers is not an array`);
		}
		const tiers = tiersValue.map((tier, index): CostTier => {
			if (!isObject(tier)) {
				throw new Error(`${modelsPath}: pave/${model.id}.cost.tiers[${index}] is invalid`);
			}
			return {
				...ratesFrom(tier, `pave/${model.id}.cost.tiers[${index}]`),
				inputTokensAbove: requireNumber(tier, "inputTokensAbove", `pave/${model.id}.cost.tiers[${index}]`),
			};
		});
		pricing.set(model.id, {
			...ratesFrom(model.cost, `pave/${model.id}.cost`),
			tiers,
		});
	}
	return pricing;
}

async function sessionFiles(inputPath: string): Promise<string[]> {
	const inputStat = statSync(inputPath);
	if (inputStat.isFile()) {
		if (extname(inputPath) !== ".jsonl") {
			throw new Error(`session file must end in .jsonl: ${inputPath}`);
		}
		return [inputPath];
	}
	if (!inputStat.isDirectory()) {
		throw new Error(`path is not a regular file or directory: ${inputPath}`);
	}

	const files: string[] = [];
	async function visit(directory: string, entryDepth: number): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isFile() && extname(entry.name) === ".jsonl") {
				files.push(path);
			} else if (entry.isDirectory() && entryDepth < 3) {
				await visit(path, entryDepth + 1);
			}
		}
	}

	await visit(inputPath, 1);
	return files.sort();
}

function parseJsonObject(line: string, path: string, lineNumber: number): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new InvalidSessionError(`${path}:${lineNumber}: invalid JSON: ${message}`);
	}
	if (!isObject(parsed)) {
		throw new InvalidSessionError(`${path}:${lineNumber}: expected a JSON object`);
	}
	return parsed;
}

function validateSessionHeader(header: JsonObject, path: string, lineNumber: number): void {
	if (
		header.type !== "session" ||
		typeof header.id !== "string" || header.id.length === 0 ||
		typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp)) ||
		typeof header.cwd !== "string" || header.cwd.length === 0
	) {
		throw new InvalidSessionError(
			`${path}:${lineNumber}: expected a Pi session header with type=session, id, timestamp, and cwd`,
		);
	}
}

function assistantMessage(entry: JsonObject): JsonObject | undefined {
	if (isObject(entry.message) && entry.message.role === "assistant") {
		return entry.message;
	}
	return entry.role === "assistant" ? entry : undefined;
}

function accountingValue(entry: JsonObject, message: JsonObject, field: string): unknown {
	return field in entry ? entry[field] : message[field];
}

function tokenCount(usage: JsonObject, field: string, context: string): number {
	const value = usage[field] ?? 0;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new InvalidSessionError(`${context}: usage.${field} is not a finite number`);
	}
	return value;
}

function calculateCost(usage: JsonObject, pricing: ModelPricing, context: string): JsonObject {
	const input = tokenCount(usage, "input", context);
	const output = tokenCount(usage, "output", context);
	const cacheRead = tokenCount(usage, "cacheRead", context);
	const cacheWrite = tokenCount(usage, "cacheWrite", context);
	const requestInput = input + cacheRead + cacheWrite;

	let rates: Rates = pricing;
	let matchedThreshold = -1;
	for (const tier of pricing.tiers) {
		if (requestInput > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	const cost = {
		input: rates.input / 1_000_000 * input,
		output: rates.output / 1_000_000 * output,
		cacheRead: rates.cacheRead / 1_000_000 * cacheRead,
		cacheWrite: rates.cacheWrite / 1_000_000 * cacheWrite,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return cost;
}

function costsEqual(left: unknown, right: JsonObject): boolean {
	if (!isObject(left)) return false;
	const fields = ["input", "output", "cacheRead", "cacheWrite", "total"];
	return fields.every((field) => left[field] === right[field]);
}

function prepareUpdate(path: string, pricing: Map<string, ModelPricing>): FileUpdate {
	const original = readFileSync(path, "utf8");
	const hasFinalNewline = original.endsWith("\n");
	const lines = original.split(/\r?\n/);
	if (hasFinalNewline) lines.pop();

	const headerIndex = lines.findIndex((line) => line.trim().length > 0);
	if (headerIndex === -1) {
		throw new InvalidSessionError(`${path}: empty file; expected a Pi session header`);
	}
	validateSessionHeader(parseJsonObject(lines[headerIndex], path, headerIndex + 1), path, headerIndex + 1);

	let turnsSeen = 0;
	let turnsUpdated = 0;
	const outputLines = lines.map((line, index) => {
		if (!line.trim()) return line;

		const parsed = parseJsonObject(line, path, index + 1);
		if (parsed.type !== "message") return line;

		const message = assistantMessage(parsed);
		if (!message || accountingValue(parsed, message, "provider") !== "pave") return line;

		const model = accountingValue(parsed, message, "model");
		if (typeof model !== "string" || !pricing.has(model)) return line;

		const usage = accountingValue(parsed, message, "usage");
		if (!isObject(usage)) {
			throw new InvalidSessionError(`${path}:${index + 1}: pave/${model} assistant message has no usage object`);
		}

		turnsSeen += 1;
		const cost = calculateCost(usage, pricing.get(model)!, `${path}:${index + 1}`);
		if (costsEqual(usage.cost, cost)) return line;

		usage.cost = cost;
		turnsUpdated += 1;
		return JSON.stringify(parsed);
	});

	let content = outputLines.join("\n");
	if (hasFinalNewline) content += "\n";
	return { path, content, turnsSeen, turnsUpdated };
}

function writeAtomic(update: FileUpdate): void {
	const temporaryPath = join(dirname(update.path), `.${basename(update.path)}.${process.pid}.${randomUUID()}.tmp`);
	const mode = statSync(update.path).mode;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", mode);
		writeFileSync(descriptor, update.content, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, update.path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			unlinkSync(temporaryPath);
		} catch (error) {
			if (!isObject(error) || error.code !== "ENOENT") throw error;
		}
	}
}

async function main(): Promise<void> {
	const { dryRun, inputPath } = parseArguments();
	const pricing = loadPavePricing();
	const files = await sessionFiles(inputPath);
	if (files.length === 0) {
		throw new Error(`no *.jsonl files found up to depth 3 in: ${inputPath}`);
	}

	const updates: FileUpdate[] = [];
	let skippedFiles = 0;
	for (const path of files) {
		try {
			updates.push(prepareUpdate(path, pricing));
		} catch (error) {
			if (!(error instanceof InvalidSessionError)) throw error;
			skippedFiles += 1;
		}
	}
	if (!dryRun) {
		for (const update of updates) {
			if (update.turnsUpdated > 0) writeAtomic(update);
		}
	}

	const changedFiles = updates.filter((update) => update.turnsUpdated > 0).length;
	const turnsSeen = updates.reduce((total, update) => total + update.turnsSeen, 0);
	const turnsUpdated = updates.reduce((total, update) => total + update.turnsUpdated, 0);
	const action = dryRun ? "Would update" : "Updated";
	console.log(
		`${action} ${turnsUpdated} of ${turnsSeen} recognized pave turns ` +
		`across ${changedFiles} of ${updates.length} valid session files; ` +
		`skipped ${skippedFiles} invalid JSONL files.`,
	);
	if (dryRun && changedFiles > 0) {
		console.log("Files that would be modified:");
		for (const update of updates) {
			if (update.turnsUpdated > 0) console.log(update.path);
		}
	}
}

main().catch((error: unknown) => {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
