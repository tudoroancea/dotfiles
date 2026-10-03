import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { parseCopyRegions } from "../regions.ts";

const theme: MarkdownTheme = {
  heading: String,
  link: String,
  linkUrl: String,
  code: String,
  codeBlock: String,
  codeBlockBorder: String,
  quote: String,
  quoteBorder: String,
  hr: String,
  listBullet: String,
  bold: String,
  italic: String,
  strikethrough: String,
  underline: String,
};

function renderedTuiText(markdown: string): string {
  return new Markdown(markdown, 0, 0, theme).render(100).join("\n").trimEnd();
}

describe("TUI Markdown annotation compatibility", () => {
  it.each(["\n", "\r\n"])(
    "keeps a valid %j annotation invisible in the installed Pi TUI renderer",
    (lineEnding) => {
      const source =
        `[copy-region-1]: # "Run the checks"${lineEnding}` +
        `\`\`\`bash${lineEnding}nub run check${lineEnding}\`\`\``;
      const rendered = renderedTuiText(source);

      expect(rendered).toContain("nub run check");
      expect(rendered).not.toContain("copy-region-1");
      expect(rendered).not.toContain("Run the checks");
      expect(parseCopyRegions(source).regions[0]?.label).toBe("Run the checks");
    },
  );

  it("locks down visible TUI counterexamples that the scanner rejects", () => {
    const attachedToProse =
      'prose\n[copy-region-1]: # "Must remain visible"\n```text\npayload\n```';
    const htmlComment = "<!-- copy: Visible comment -->\n```text\npayload\n```";

    expect(renderedTuiText(attachedToProse)).toContain("Must remain visible");
    expect(renderedTuiText(htmlComment)).toContain("Visible comment");
    expect(parseCopyRegions(attachedToProse).regions[0]?.label).toBe("text — payload");
    expect(parseCopyRegions(htmlComment).regions[0]?.label).toBe("text — payload");
  });

  it("masks a renderer-backed custom-tag block immediately after a heading", () => {
    const source = [
      "# Example heading",
      "<custom-element>",
      "```text",
      "custom-tag fence lookalike",
      "```",
      "</custom-element>",
    ].join("\n");

    expect(renderedTuiText(source)).toContain("custom-tag fence lookalike");
    expect(parseCopyRegions(source)).toEqual({ regions: [], wholeText: source });
  });

  it("matches installed TUI rendering of multiline raw HTML blocks", () => {
    const examples = [
      [
        "<!--",
        "visible multiline comment",
        "```text",
        "comment fence lookalike",
        "```",
        "-->",
      ].join("\n"),
      [
        "<div class=fixture>",
        "visible block content",
        "```text",
        "block fence lookalike",
        "```",
        "</div>",
      ].join("\n"),
    ];

    for (const source of examples) {
      const tui = renderedTuiText(source);

      expect(tui).toContain(source.startsWith("<!--") ? "<!--" : "<div class=fixture>");
      expect(tui).toContain("fence lookalike");
      expect(parseCopyRegions(source)).toEqual({ regions: [], wholeText: source });
    }
  });

  it.each(["\n", "\r\n"])(
    "keeps multiple %j annotations invisible in the installed Pi TUI renderer",
    (lineEnding) => {
      const source =
        `[copy-region-1]: # "Prompt for reviewer"${lineEnding}` +
        `\`\`\`text${lineEnding}Review exactly this.${lineEnding}\`\`\`${lineEnding}${lineEnding}` +
        `[copy-region-2]: # "Run exact command"${lineEnding}` +
        `\`\`\`bash${lineEnding}nub run check${lineEnding}\`\`\``;

      const rendered = renderedTuiText(source);
      expect(rendered).toContain("Review exactly this.");
      expect(rendered).toContain("nub run check");
      expect(rendered).not.toContain("copy-region-1");
      expect(rendered).not.toContain("copy-region-2");
      expect(rendered).not.toContain("Prompt for reviewer");
      expect(rendered).not.toContain("Run exact command");
      const attached =
        `prose${lineEnding}[copy-region-1]: # "Visible attached label"${lineEnding}` +
        `\`\`\`text${lineEnding}x${lineEnding}\`\`\``;
      const comment =
        `<!-- copy: Visible HTML comment -->${lineEnding}` +
        `\`\`\`text${lineEnding}x${lineEnding}\`\`\``;
      expect(renderedTuiText(attached)).toContain("Visible attached label");
      expect(renderedTuiText(comment)).toContain("Visible HTML comment");

      expect(parseCopyRegions(source).regions.map((region) => region.label)).toEqual([
        "Prompt for reviewer",
        "Run exact command",
      ]);
    },
  );
});
