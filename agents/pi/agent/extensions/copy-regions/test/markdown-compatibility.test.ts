import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

let activeDom: JSDOM | undefined;

beforeAll(() => installDom());

afterAll(() => {
  activeDom?.window.close();
  activeDom = undefined;
});

function renderedTuiText(markdown: string): string {
  return new Markdown(markdown, 0, 0, theme).render(100).join("\n").trimEnd();
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
    url: "http://127.0.0.1/session/",
    pretendToBeVisual: true,
  });
  activeDom = dom;
  const { window } = dom;
  Object.defineProperty(window, "innerHeight", { value: 100_000, configurable: true });
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
    history: window.history,
    location: window.location,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    KeyboardEvent: window.KeyboardEvent,
    PointerEvent: window.PointerEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

describe("Markdown annotation compatibility", () => {
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

  it("masks a renderer-backed custom-tag block immediately after a heading", async () => {
    const { renderMarkdown } = await import("@dotfiles/pi-web-ui-client/client");
    const source = [
      "# Example heading",
      "<custom-element>",
      "```text",
      "custom-tag fence lookalike",
      "```",
      "</custom-element>",
    ].join("\n");

    expect(renderedTuiText(source)).toContain("custom-tag fence lookalike");
    expect(renderMarkdown(source)).toContain("custom-tag fence lookalike");
    expect(parseCopyRegions(source)).toEqual({ regions: [], wholeText: source });
  });

  it("matches installed TUI and shared Web UI rendering of multiline raw HTML blocks", async () => {
    const { renderMarkdown } = await import("@dotfiles/pi-web-ui-client/client");
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
      const web = renderMarkdown(source);

      expect(tui).toContain(source.startsWith("<!--") ? "<!--" : "<div class=fixture>");
      expect(tui).toContain("fence lookalike");
      expect(web).toContain(source.startsWith("<!--") ? "visible multiline comment" : "&lt;div");
      expect(web).toContain("fence lookalike");
      expect(parseCopyRegions(source)).toEqual({ regions: [], wholeText: source });
    }
  });

  it.each(["\n", "\r\n"])(
    "uses the active shared renderMarkdown and assistant transcript DOM path with %j",
    async (lineEnding) => {
      const [{ h, render }, { renderMarkdown, Transcript }] = await Promise.all([
        import("preact"),
        import("@dotfiles/pi-web-ui-client/client"),
      ]);
      const source =
        `[copy-region-1]: # "Prompt for reviewer"${lineEnding}` +
        `\`\`\`text${lineEnding}Review exactly this.${lineEnding}\`\`\`${lineEnding}${lineEnding}` +
        `[copy-region-2]: # "Run exact command"${lineEnding}` +
        `\`\`\`bash${lineEnding}nub run check${lineEnding}\`\`\``;

      const html = renderMarkdown(source);
      expect(html).toContain("Review exactly this.");
      expect(html).toContain("nub run check");
      expect(html).not.toContain("copy-region-1");
      expect(html).not.toContain("copy-region-2");
      expect(html).not.toContain("Prompt for reviewer");
      expect(html).not.toContain("Run exact command");
      const attached =
        `prose${lineEnding}[copy-region-1]: # "Visible attached label"${lineEnding}` +
        `\`\`\`text${lineEnding}x${lineEnding}\`\`\``;
      const comment =
        `<!-- copy: Visible HTML comment -->${lineEnding}` +
        `\`\`\`text${lineEnding}x${lineEnding}\`\`\``;
      expect(renderMarkdown(attached)).toContain("Visible attached label");
      expect(renderMarkdown(comment)).toContain("Visible HTML comment");

      const root = document.querySelector("#app");
      expect(root).not.toBeNull();
      render(
        h(Transcript, {
          persisted: [
            {
              id: "assistant-fixture",
              payload: {
                id: "assistant-fixture",
                type: "message",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: source }],
                },
              },
            },
          ],
          live: [],
        }),
        root!,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const assistantMarkdown = root?.querySelector(
        ".assistant-message .assistant-text .markdown-content",
      );
      expect(assistantMarkdown).not.toBeNull();
      expect(assistantMarkdown?.textContent).toContain("Review exactly this.");
      expect(assistantMarkdown?.textContent).toContain("nub run check");
      expect(assistantMarkdown?.textContent).not.toContain("copy-region-1");
      expect(assistantMarkdown?.textContent).not.toContain("copy-region-2");
      expect(assistantMarkdown?.textContent).not.toContain("Prompt for reviewer");
      expect(assistantMarkdown?.textContent).not.toContain("Run exact command");
    },
  );
});
