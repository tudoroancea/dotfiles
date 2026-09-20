import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appendCopyRegionsGuidance, COPY_REGIONS_SYSTEM_PROMPT_ADDITION } from "../guidance.ts";
import { COPYABLE_REGIONS_SKILL_PATH } from "../index.ts";
import { parseCopyRegions } from "../regions.ts";

describe("copy-region guidance", () => {
  it("appends the compact contract without replacing the existing prompt", () => {
    const original = "Earlier system instructions.";
    const result = appendCopyRegionsGuidance(original);

    expect(result).toBe(`${original}\n\n${COPY_REGIONS_SYSTEM_PROMPT_ADDITION}`);
    expect(result).toContain('[copy-region-N]: # "Short label"');
    expect(result).toMatch(/top-level fenced block/i);
    expect(result).toMatch(/at most three leading spaces/i);
    expect(result).toMatch(/start of the message or preceded by a blank line/i);
    expect(result).toMatch(/only blank lines may appear between the marker.*never prose/i);
  });

  it("has valid Agent Skills frontmatter and exact copyable-text scope", () => {
    const skill = readFileSync(COPYABLE_REGIONS_SKILL_PATH, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];

    expect(frontmatter).toBeDefined();
    expect(frontmatter).toMatch(/^name: copyable-regions$/m);
    expect(frontmatter).toMatch(
      /^description: .*prompts, commands, configuration, or other exact text.*copy independently\.$/m,
    );
  });

  it("uses positive examples accepted by the parser with exact labels and payloads", () => {
    const skill = readFileSync(COPYABLE_REGIONS_SKILL_PATH, "utf8");
    const examples = [...skill.matchAll(/````markdown\n([\s\S]*?)````/g)].map((match) => match[1]);

    expect(examples).toHaveLength(2);
    expect(examples.map((example) => parseCopyRegions(example).regions)).toEqual([
      [
        expect.objectContaining({
          label: "Run the checks",
          payload: "nub run check\n",
        }),
      ],
      [
        expect.objectContaining({
          label: "Prompt for the reviewer",
          payload:
            "Review the authentication changes for correctness and missing tests.\nReturn only actionable findings with file and line references.\n",
        }),
      ],
    ]);
  });
});
