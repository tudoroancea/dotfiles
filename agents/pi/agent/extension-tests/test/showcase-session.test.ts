// The showcase session file `agent/scripts/tui-showcase.ts` generates, checked against what the
// terminal does with it.
//
// `pi --session` is not scriptable — it wants a TTY — so the two things that crashed it are
// asserted here instead: the footer sums `usage` over every assistant message unconditionally
// (`dist/core/usage-totals.js`), and the extension message renderers are not wrapped in the
// try/catch that protects a tool renderer, so a payload they cannot decode takes the TUI down.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
// By file path, not by package subpath: `exports` does not expose this module, and the point is
// to sum with Pi's own function rather than a copy of it that cannot drift.
import {
  addUsageToTotals,
  createUsageTotals,
  getUsageCostBreakdown,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/usage-totals.js";
import { beforeAll, describe, expect, it } from "vitest";
import { renderResultMessage } from "../../extensions/agentflow/src/ui/tool-renderers.ts";
import {
  renderCompletionMessage,
  renderMonitorEventMessage,
} from "../../extensions/background-processes/src/ui/tool-renderers.ts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

/** Colours are ANSI wrappers; an identity theme keeps what a renderer drew readable. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;
type Entry = Record<string, any>;

let header: Entry;
let entries: Entry[];

beforeAll(() => {
  const out = join(process.env.TMPDIR ?? "/tmp", `showcase-${process.pid}.jsonl`);
  execFileSync("node", [join(REPOSITORY, "agent/scripts/tui-showcase.ts"), "--out", out], {
    encoding: "utf8",
  });
  const lines = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  header = lines[0]!;
  entries = lines.slice(1);
});

describe("showcase session", () => {
  it("is a session file Pi can open", () => {
    expect(header).toMatchObject({ type: "session", version: 3 });
    expect(header.cwd).toBeTypeOf("string");
    // One linear chain: Pi walks a session by `parentId` from its leaf, so a break would silently
    // drop everything before it.
    let parent: string | null = null;
    for (const entry of entries) {
      expect(entry.parentId, entry.id).toBe(parent);
      parent = entry.id;
    }
    expect(entries.length).toBeGreaterThan(80);
  });

  it("survives the footer's unconditional usage sum", () => {
    const totals = createUsageTotals();
    for (const entry of entries) {
      const message = entry.message;
      if (entry.type === "message" && message?.role === "assistant")
        addUsageToTotals(totals, message.usage);
      else if (entry.type === "message" && message?.role === "toolResult" && message.usage)
        addUsageToTotals(totals, message.usage);
      else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)
        addUsageToTotals(totals, entry.usage);
    }
    expect(totals.cost).toBeGreaterThan(0);
    expect(getUsageCostBreakdown(entries as never).length).toBeGreaterThan(0);
  });

  it("carries a payload each delivered-message renderer can draw", () => {
    const custom = (customType: string): Entry[] =>
      entries.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
    const text = (entry: Entry): string =>
      typeof entry.content === "string"
        ? entry.content
        : (entry.content ?? [])
            .filter((part: Entry) => part.type === "text")
            .map((part: Entry) => part.text)
            .join("\n");

    for (const expanded of [false, true]) {
      const options = { expanded, outputPad: 1 };
      for (const entry of custom("agentflow-result")) {
        expect(entry.details?.snapshot, entry.id).toBeDefined();
        expect(
          renderResultMessage(entry.details, options, theme).render(100).length,
        ).toBeGreaterThan(0);
      }
      for (const entry of custom("background-process-completion"))
        expect(
          renderCompletionMessage(entry.details, options, theme).render(100).length,
        ).toBeGreaterThan(0);
      for (const entry of custom("background-monitor-event"))
        expect(
          // The last argument is the live job the expanded view borrows facts from, which a session
          // file has no equivalent of: the runtime is gone by the time it is read back.
          renderMonitorEventMessage(entry.details, text(entry), options, theme, undefined).render(
            100,
          ).length,
        ).toBeGreaterThan(0);
    }
  });

  it("covers every tool this repo renders", () => {
    const rendered = new Set(
      entries
        .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
        .map((entry) => entry.message.toolName),
    );
    for (const name of [
      "bash",
      "read",
      "write",
      "edit",
      "ls",
      "grep",
      "find",
      "ffgrep",
      "fffind",
      "questionnaire",
      "agentflow_finder",
      "agentflow_workflow",
      "background_run",
      "background_event_stream",
    ])
      expect(rendered, name).toContain(name);
  });
});
