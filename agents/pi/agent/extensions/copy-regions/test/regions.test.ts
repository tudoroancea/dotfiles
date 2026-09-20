import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  extractLatestAssistantText,
  formatRegionSelectorLabels,
  parseCopyRegions,
} from "../regions.ts";

function managerWithBranch(entries: unknown[]): Pick<SessionManager, "getBranch"> {
  return { getBranch: () => entries as SessionEntry[] };
}

function message(role: string, content: unknown[]): unknown {
  return {
    type: "message",
    id: crypto.randomUUID(),
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content },
  };
}

describe("extractLatestAssistantText", () => {
  it("selects the newest assistant on the active branch rather than append order", () => {
    const activeOld = message("assistant", [{ type: "text", text: "active old" }]);
    const activeNewest = message("assistant", [{ type: "text", text: "active newest" }]);
    const abandonedLater = message("assistant", [{ type: "text", text: "abandoned" }]);
    const manager = managerWithBranch([
      activeOld,
      message("user", [{ type: "text", text: "continue" }]),
      activeNewest,
    ]);
    const appendOrder = [activeOld, activeNewest, abandonedLater];

    expect(extractLatestAssistantText(manager)).toEqual({ status: "ok", text: "active newest" });
    expect(appendOrder.at(-1)).toBe(abandonedLater);
  });

  it("concatenates only text blocks exactly and preserves surrounding whitespace", () => {
    const manager = managerWithBranch([
      message("assistant", [
        { type: "text", text: "  first\n" },
        { type: "thinking", thinking: "secret" },
        { type: "toolCall", id: "call", name: "read", arguments: {} },
        { type: "text", text: "second  " },
      ]),
    ]);

    expect(extractLatestAssistantText(manager)).toEqual({
      status: "ok",
      text: "  first\nsecond  ",
    });
  });

  it("distinguishes no assistant from a newest assistant without meaningful text", () => {
    expect(extractLatestAssistantText(managerWithBranch([message("user", [])]))).toEqual({
      status: "no-assistant",
    });
    expect(
      extractLatestAssistantText(
        managerWithBranch([
          message("assistant", [{ type: "text", text: "older" }]),
          message("assistant", [
            { type: "thinking", thinking: "only thought" },
            { type: "text", text: " \r\n\t" },
          ]),
        ]),
      ),
    ).toEqual({ status: "no-meaningful-text", text: " \r\n\t" });
    expect(
      extractLatestAssistantText(
        managerWithBranch([
          message("assistant", [{ type: "text", text: "older" }]),
          message("assistant", [{ type: "toolCall", id: "call", name: "read", arguments: {} }]),
        ]),
      ),
    ).toEqual({ status: "no-meaningful-text", text: "" });
  });
});

describe("parseCopyRegions", () => {
  it("returns annotated and unannotated fences in source order", () => {
    const source = [
      "Intro",
      "",
      '[copy-region-7]: # "Run checks"',
      "```bash title=checks",
      "nub run check",
      "```",
      "Between",
      "~~~text",
      "review this",
      "~~~",
      "",
    ].join("\n");

    const parsed = parseCopyRegions(source);
    expect(parsed.regions.map(({ label, payload }) => ({ label, payload }))).toEqual([
      { label: "Run checks", payload: "nub run check\n" },
      { label: "text — review this", payload: "review this\n" },
    ]);
    for (const region of parsed.regions) {
      expect(source.slice(region.payloadStart, region.payloadEnd)).toBe(region.payload);
    }
    expect(parsed.wholeText).toBe(source.replace('[copy-region-7]: # "Run checks"\n', ""));
  });

  it("preserves exact LF and CRLF payload bytes, whitespace, and final newlines", () => {
    const lf = "```text\n\n  indented  \nlast\n```";
    const crlf = "~~~text\r\n\r\n\tindented  \r\nlast\r\n~~~\r\n";
    expect(parseCopyRegions(lf).regions[0]?.payload).toBe("\n  indented  \nlast\n");
    expect(parseCopyRegions(crlf).regions[0]?.payload).toBe("\r\n\tindented  \r\nlast\r\n");
  });

  it("supports longer openers and enforces character, length, and trailing-content closure rules", () => {
    const source = [
      "````js",
      "``` embedded",
      "const x = 1;",
      "~~~",
      "```",
      "```` trailing",
      "`````",
      "~~~",
      "tilde",
      "```",
      "~~",
      "~~~~  \t",
    ].join("\n");
    const regions = parseCopyRegions(source).regions;

    expect(regions).toHaveLength(2);
    expect(regions[0]?.payload).toBe("``` embedded\nconst x = 1;\n~~~\n```\n```` trailing\n");
    expect(regions[1]?.payload).toBe("tilde\n```\n~~\n");
  });

  it("recognizes genuinely top-level fences with zero through three opener spaces", () => {
    const source = [0, 1, 2, 3]
      .map((indent) => {
        const spaces = " ".repeat(indent);
        return `${spaces}\`\`\`text\ntop ${indent}\n${spaces}\`\`\``;
      })
      .join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top 0\n",
      "top 1\n",
      "top 2\n",
      "top 3\n",
    ]);
  });

  it("ignores fenced blocks nested in Markdown list containers", () => {
    const source = [
      "- first item",
      "  ```bash",
      "  echo bullet",
      "  ```",
      "",
      "1. numbered item",
      "   ~~~text",
      "   numbered payload",
      "   ~~~",
      "",
      "- ```js",
      "  inline marker payload",
      "  ```",
      "",
      "top-level prose ends the list",
      "   ```text",
      "top-level payload",
      "   ```",
    ].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top-level payload\n",
    ]);
  });

  it("keeps the outer list active when a fence dedents from a nested sub-list", () => {
    const source = [
      "- outer item",
      "  - inner item",
      "    inner paragraph",
      "  ```text",
      "  still nested in outer item",
      "  ```",
      "",
      "```text",
      "top level",
      "```",
    ].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top level\n",
    ]);
  });

  it("keeps a list active across a lazy paragraph continuation", () => {
    const source = [
      "- list paragraph",
      "lazy continuation without list indentation",
      "  ```text",
      "  still nested in the list",
      "  ```",
      "",
      "```text",
      "top level",
      "```",
    ].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top level\n",
    ]);
  });

  it("ignores a nested fence after an empty list item", () => {
    const source = [
      "-",
      "  ```text",
      "  nested payload",
      "  ```",
      "",
      "```text",
      "top level",
      "```",
    ].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top level\n",
    ]);
  });

  it("does not treat a thematic break as list state", () => {
    const source = ["- - -", "  ```text", "top-level payload", "  ```"].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top-level payload\n",
    ]);
  });

  it("preserves annotation-looking lines inside list-nested fenced payloads", () => {
    const source = [
      "- example",
      "  ```text",
      "",
      '  [copy-region-9]: # "Payload metadata lookalike"',
      "  payload",
      "  ```",
      "",
      "```text",
      "top level",
      "```",
    ].join("\n");

    const parsed = parseCopyRegions(source);

    expect(parsed.regions.map((region) => region.payload)).toEqual(["top level\n"]);
    expect(parsed.wholeText).toBe(source);
  });

  it("handles multi-digit list indentation and evaluates closers relative to list content", () => {
    const source = [
      "12. numbered item",
      "    ````text",
      "    payload",
      "    ```",
      "    still payload",
      "    ````",
      "",
      "```text",
      "top level",
      "```",
    ].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top level\n",
    ]);
  });

  it("stops an unterminated nested fence at its list boundary", () => {
    const source = [
      "- example",
      "  ```text",
      "  nested payload",
      "container has ended",
      "```text",
      "top level",
      "```",
    ].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "top level\n",
    ]);
  });

  it("does not let list-looking payload inside a top-level fence change container state", () => {
    const source = [
      "```text",
      "- payload that looks like a list item",
      "  ``` nested-looking payload",
      "```",
      "```text",
      "second top level",
      "```",
    ].join("\n");

    expect(parseCopyRegions(source).regions.map((region) => region.payload)).toEqual([
      "- payload that looks like a list item\n  ``` nested-looking payload\n",
      "second top level\n",
    ]);
  });

  it("masks multiline raw HTML blocks without changing source offsets or whole text", () => {
    const comment = [
      "<!--",
      "",
      '[copy-region-11]: # "Comment lookalike"',
      "```text",
      "comment fence lookalike",
      "```",
      "-->",
    ].join("\n");
    const block = [
      "<div class=example>",
      '[copy-region-12]: # "Block lookalike"',
      "~~~text",
      "block fence lookalike",
      "~~~",
      "</div>",
      "",
    ].join("\n");
    const source = `${comment}\n${block}\n\`\`\`text\nreal payload\n\`\`\``;
    const parsed = parseCopyRegions(source);

    expect(parsed.regions.map((region) => region.payload)).toEqual(["real payload\n"]);
    expect(parsed.wholeText).toBe(source);
    expect(source.slice(parsed.regions[0]?.payloadStart, parsed.regions[0]?.payloadEnd)).toBe(
      "real payload\n",
    );
  });

  it("masks a type-7 complete-tag HTML block after a heading but not after paragraph text", () => {
    const afterHeading = [
      "# Heading",
      "<custom-element>",
      "```text",
      "HTML fence lookalike",
      "```",
      "</custom-element>",
      "",
      "```text",
      "real region",
      "```",
    ].join("\n");
    expect(parseCopyRegions(afterHeading).regions.map((region) => region.payload)).toEqual([
      "real region\n",
    ]);

    const afterParagraph = [
      "ordinary paragraph",
      "<custom-element>",
      "```text",
      "real region",
      "```",
    ].join("\n");
    expect(parseCopyRegions(afterParagraph).regions.map((region) => region.payload)).toEqual([
      "real region\n",
    ]);
  });

  it("masks CommonMark raw-tag blocks through their closing tags", () => {
    const source = [
      "<pre data-kind=fixture>",
      "",
      '[copy-region-20]: # "Raw tag lookalike"',
      "```text",
      "not a region",
      "```",
      "</pre>",
      "```text",
      "real region",
      "```",
    ].join("\n");

    const parsed = parseCopyRegions(source);
    expect(parsed.regions.map((region) => region.payload)).toEqual(["real region\n"]);
    expect(parsed.wholeText).toBe(source);
  });

  it("rejects over-indented and invalid backtick openers", () => {
    const source = [
      "    ```text",
      "not top level",
      "    ```",
      "```bad`info",
      "not a fence",
      "```",
    ].join("\n");

    expect(parseCopyRegions(source).regions).toEqual([]);
  });

  it("ignores an unterminated fence", () => {
    expect(parseCopyRegions("before\n```bash\necho never closes\n").regions).toEqual([]);
  });

  it("associates separated annotations across optional blank lines but never prose", () => {
    const source = [
      "paragraph",
      '[copy-region-1]: # "Visible because attached to prose"',
      "```bash",
      "one",
      "```",
      "",
      '[copy-region-2]: # "Detached"',
      "prose",
      "```text",
      "two",
      "```",
      "",
      '[copy-region-3]: # "Attached across blanks"',
      "",
      "",
      "~~~text",
      "three",
      "~~~",
    ].join("\n");
    const parsed = parseCopyRegions(source);

    expect(parsed.regions.map((region) => region.label)).toEqual([
      "bash — one",
      "text — two",
      "Attached across blanks",
    ]);
    expect(parsed.wholeText).toContain('[copy-region-1]: # "Visible because attached to prose"');
    expect(parsed.wholeText).not.toContain('[copy-region-2]: # "Detached"');
    expect(parsed.wholeText).not.toContain('[copy-region-3]: # "Attached across blanks"');
    expect(parsed.wholeText).toContain("prose\n```text");
  });

  it("does not recognize malformed, empty-label, duplicate-ID, or fenced annotations", () => {
    const source = [
      '[copy-region-x]: # "Malformed"',
      "```text",
      '[copy-region-8]: # "Inside payload"',
      "```",
      "",
      '[copy-region-4]: # "First duplicate"',
      "```bash",
      "first",
      "```",
      "",
      '[copy-region-4]: # "Second duplicate"',
      "~~~bash",
      "second",
      "~~~",
      "",
      '[copy-region-5]: # "   "',
      "```text",
      "third",
      "```",
    ].join("\n");
    const parsed = parseCopyRegions(source);

    expect(parsed.regions.map((region) => region.label)).toEqual([
      'text — [copy-region-8]: # "Inside payload"',
      "bash — first",
      "bash — second",
      "text — third",
    ]);
    expect(parsed.wholeText).toBe(source);
  });

  it("removes only recognized annotation lines including their own line endings", () => {
    const source =
      '[copy-region-1]: # "LF"\n```text\na\n```\n\r\n' +
      '[copy-region-2]: # "CRLF"\r\n~~~text\r\nb\r\n~~~\r\n' +
      '[ordinary]: # "Keep"';
    const parsed = parseCopyRegions(source);

    expect(parsed.wholeText).toBe(
      "```text\na\n```\n\r\n~~~text\r\nb\r\n~~~\r\n" + '[ordinary]: # "Keep"',
    );
    expect(parsed.regions.map((region) => region.payload)).toEqual(["a\n", "b\r\n"]);
  });

  it("derives safe bounded labels for content and empty blocks", () => {
    const long = `\u001b[31m${"界".repeat(80)}\u001b[0m\nsecond`;
    const source = `\`\`\`bash\n${long}\n\`\`\`\n~~~python\n~~~\n\`\`\`\n\`\`\``;
    const parsed = parseCopyRegions(source);

    expect(parsed.regions[0]?.label).not.toContain("\u001b");
    expect(parsed.regions[0]?.label).not.toContain("\n");
    expect(visibleWidth(parsed.regions[0]?.label ?? "")).toBeLessThanOrEqual(72);
    expect(parsed.regions[1]?.label).toBe("python block");
    expect(parsed.regions[2]?.label).toBe("Text block");
  });

  it("numbers duplicate display labels while keeping every payload distinct", () => {
    const parsed = parseCopyRegions("```bash\necho same\n```\n```bash\necho same\n```\n");
    const labels = formatRegionSelectorLabels(parsed.regions);

    expect(labels).toEqual(["1. bash — echo same", "2. bash — echo same"]);
    expect(parsed.regions.map((region) => region.payload)).toEqual(["echo same\n", "echo same\n"]);
    expect(labels.every((label) => visibleWidth(label) <= 72)).toBe(true);
    expect(truncateToWidth(labels[0] ?? "", 72)).toBe(labels[0]);
  });
});
