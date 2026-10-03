import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileMarkdownImports } from "../src/claude/markdown-imports.ts";

const agentDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const promptPath = resolve(agentDir, "extensions/agentflow/src/claude/prompts/system.md");

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("controlled Claude system prompt asset", () => {
  it("compiles shared general and Claude-specific instructions exactly once", async () => {
    const result = await compileMarkdownImports({
      rootPath: promptPath,
      allowedRoots: [agentDir, resolve(agentDir, "../../shared")],
    });

    expect(occurrences(result.text, "## Operating profiles")).toBe(1);
    expect(occurrences(result.text, "## Editing files")).toBe(1);
    expect(occurrences(result.text, "## Scope and agency")).toBe(1);
    expect(occurrences(result.text, "Never start or simulate subagents.")).toBe(1);
    expect(occurrences(result.text, "Available tools are Read, Glob, Grep")).toBe(1);
    expect(occurrences(result.text, "${activeSkillsIndex}")).toBe(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]?.path).toBe(resolve(agentDir, "../../shared/AGENTS.md"));
    expect(result.text).not.toContain("# Pi-specific instructions");
    expect(result.text).not.toContain("## Claude child routing");
  });

  it("retains the audited standalone resource boundaries without Claude preset assumptions", async () => {
    const { text } = await compileMarkdownImports({
      rootPath: promptPath,
      allowedRoots: [agentDir, resolve(agentDir, "../../shared")],
    });

    expect(text).toContain(
      "remain read-only unless it explicitly requests edits or implementation",
    );
    expect(text).toContain("Do not search for or load `CLAUDE.md`");
    expect(text).toContain("Do not invoke Agent, AskUserQuestion");
    expect(text).toContain("WebFetch and WebSearch cross a network boundary");
    expect(text).toContain("Return the result to the parent agent");
    expect(text).not.toContain("You are Claude Code, Anthropic's official CLI");
    expect(text).not.toContain("task/todo");
  });
});
