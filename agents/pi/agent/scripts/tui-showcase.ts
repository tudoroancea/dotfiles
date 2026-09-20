#!/usr/bin/env node

// Opens the tool-renderer showcase in the terminal.
//
// The browser's mock server serves `toolShowcaseScenario()` — a scripted transcript that calls
// every tool of this setup, settles each one a beat later, and carries the awkward cases
// (errors, aborted and failed runs, a workflow, hostile markdown, an unknown tool). This script
// flattens that same scenario into a Pi session file and opens it, so the two surfaces can be
// put side by side and one fixture keeps them honest: adding a tool to the showcase updates the
// browser mock and this terminal review at once.
//
// What a session file cannot carry, and where to look for it instead:
//
//   - pending and streaming-partial rows. A session holds settled entries only, so the
//     partials are dropped here; `agent/extension-tests/test/tool-goldens.test.ts` is the layer
//     that renders those states.
//   - the live domains (running, metadata, queue). Those are the host's, not the transcript's.
//
// Three things the terminal needs that the browser's host supplies by other means, all handled
// below: `usage` on every assistant message (its footer sums them unconditionally and crashes on
// the first one without), `details.observedAt` on a run snapshot (or an unsettled run measures
// against the real clock), and no `compaction` entry (it hides every entry before it, which in the
// terminal would leave four tool rows visible out of thirty-three).
//
// One warning is expected on startup: Pi cannot restore the fabricated session's model and says
// so. Naming a model from the local settings instead would only move the problem.
//
// Images do survive: the scenario's `image-reference` blocks are resolved to the real bytes it
// ships, so a kitty or iTerm2 terminal renders them inline. That is the one thing only this
// layer shows.
//
// Requires Node 22.18 or newer, which runs erasable TypeScript directly.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_SHOWCASE_IMAGE,
  toolShowcaseScenario,
} from "../../packages/pi-web-ui-client/src/testing/tool-showcase.ts";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A fixed identity, so the generated file is byte-identical between runs. */
const SESSION_ID = "5f0c0a5e-0000-4000-8000-000000000001";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The scenario addresses images by reference, because its browser host serves the bytes over
 * HTTP. A terminal has no such indirection: the block has to carry the data.
 */
function resolveImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveImages);
  if (!isObject(value)) return value;
  if (value.type === "image-reference" && value.id === TOOL_SHOWCASE_IMAGE.id)
    return {
      type: "image",
      data: TOOL_SHOWCASE_IMAGE.base64,
      mimeType: TOOL_SHOWCASE_IMAGE.mimeType,
    };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveImages(item)]));
}

/**
 * What every assistant message needs and the browser's scenario does not carry: the terminal's
 * footer sums `usage` across the whole transcript unconditionally, so one message without it
 * crashes the TUI on its first render (`addUsageToTotals` in `dist/core/usage-totals.js`). The
 * browser has no equivalent — it reads a session cost from `metadata` instead — so the numbers are
 * invented here, small and identical, which is all a renderer review needs them to be.
 */
const SHOWCASE_USAGE = {
  input: 1_200,
  output: 180,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_380,
  cost: { input: 0.0012, output: 0.0018, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

/**
 * The moment a run was observed, which agentflow's control tools stamp into `details` when they
 * serialize a snapshot (`tools/status-tool.ts`) and its renderers read back to measure elapsed
 * time. The scenario omits it, so an unsettled run measures against the real clock instead and a
 * six-month-old fixture reports `5148h12m`. The entry's own timestamp is the honest answer: that is
 * when the tool looked. The scenario's run clock runs slightly ahead of its entry clock, so a
 * still-running run reads `0s` rather than a made-up duration; the settled rows are the ones that
 * exercise the formatter.
 */
function stampObservedAt(payload: JsonObject): JsonObject {
  const message = payload.message;
  if (!isObject(message) || message.role !== "toolResult") return payload;
  const details = message.details;
  if (!isObject(details) || "observedAt" in details) return payload;
  const carriesRuns = ["snapshot", "snapshots", "results"].some((key) => key in details);
  if (!carriesRuns) return payload;
  const observedAt = Date.parse(String(payload.timestamp));
  if (!Number.isFinite(observedAt)) return payload;
  return { ...payload, message: { ...message, details: { ...details, observedAt } } };
}

/**
 * What the terminal reads off an assistant message and the browser never needed: the usage above,
 * plus the provider and model Pi restores the session's model from — it warns about a pair it
 * cannot resolve, including an absent one. These match the scenario's own `model_change` entry.
 */
function completeAssistantMessage(payload: JsonObject): JsonObject {
  const message = payload.message;
  if (!isObject(message) || message.role !== "assistant") return payload;
  return {
    ...payload,
    message: {
      provider: "anthropic",
      model: "claude-opus-4-6",
      usage: SHOWCASE_USAGE,
      ...message,
    },
  };
}

/**
 * The scenario in transcript order: the older history page first, then the snapshot, then every
 * durable append in the order the script publishes them. `live-tail` operations are the
 * streaming partials and the pending tool calls that a later append replaces, so they are not
 * part of a session file.
 */
function entries(): JsonObject[] {
  const scenario = toolShowcaseScenario({
    commandEpoch: "showcase-epoch",
    historyGeneration: "showcase-history",
  });
  // A `compaction` entry hides every entry before it — that is what compaction means — and the
  // scenario appends one four fifths of the way through, which in the terminal leaves four tool
  // rows visible out of thirty-three. The browser's transcript shows the whole thing, so this only
  // has to be dropped here. Everything else the scenario carries survives.
  const hidesHistory = (payload: JsonObject): boolean => payload.type === "compaction";
  const collected = [
    ...scenario.historyPage,
    ...scenario.snapshot.entries,
    ...scenario.steps.flatMap((step) =>
      step.operations.flatMap((operation) =>
        operation.kind === "append" ? (operation.entries ?? []) : [],
      ),
    ),
  ];
  // One linear chain: the scenario numbers its entries per source (history, snapshot, appends),
  // and Pi walks a session by `parentId`, so a stale parent would orphan everything after it.
  let parentId: string | null = null;
  return collected
    .filter((entry) => !hidesHistory(entry.payload as JsonObject))
    .map((entry) => {
      const payload = stampObservedAt(
        completeAssistantMessage(resolveImages(entry.payload) as JsonObject),
      );
      const chained = { ...payload, id: entry.id, parentId };
      parentId = entry.id;
      return chained;
    });
}

function sessionFile(): string {
  const header = {
    type: "session",
    version: 3,
    id: SESSION_ID,
    timestamp: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString(),
    // This repository, not the scenario's `/Users/tester/project`: Pi asks what to do about a
    // session whose cwd does not exist, and the answer would be the same every time. The paths
    // inside the transcript are the scenario's either way — they are what is under review.
    cwd: REPOSITORY,
  };
  return `${[header, ...entries()].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const explicitOut = process.argv.indexOf("--out");
const path =
  explicitOut === -1
    ? join(mkdtempSync(join(tmpdir(), "pi-tui-showcase-")), "showcase.jsonl")
    : resolve(process.argv[explicitOut + 1] ?? "showcase.jsonl");
writeFileSync(path, sessionFile());

if (explicitOut !== -1) {
  console.log(path);
  process.exit(0);
}

// A disposable copy under a temporary directory, opened read-only in practice: anything typed
// into it is appended to the copy and thrown away with it.
console.log(`Showcase session: ${path}\nPress ctrl+o to expand every tool row.\n`);
// `--agentflow-raw`: `agentflow_agent` is registered only behind that flag, and without it the
// showcase draws Pi's generic JSON view for the one tool it is meant to be reviewing.
const pi = spawnSync("pi", ["--session", path, "--agentflow-raw"], {
  cwd: REPOSITORY,
  stdio: "inherit",
  env: { ...process.env, PI_CODING_AGENT_DIR: join(REPOSITORY, "agent") },
});
process.exit(pi.status ?? 1);
