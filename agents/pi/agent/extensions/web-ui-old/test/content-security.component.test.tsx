// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { ContentBlocks } from "../src/web/components/ContentBlocks.js";
import { resolveImage } from "../src/web/lib/images.js";
import { renderMarkdown } from "../src/web/lib/markdown.js";
import { sanitizeText } from "../src/web/lib/text.js";

afterEach(cleanup);

describe("hostile content rendering", () => {
  it("escapes embedded HTML and removes unsafe Markdown URLs", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("bounds Markdown and fenced-code work before highlighting", () => {
    const html = renderMarkdown(`\`\`\`ts\n${"const value = 1;\n".repeat(4_000)}\`\`\``);
    expect(html).toContain("[truncated]");
    expect(html.length).toBeLessThan(500_000);
  });

  it("strips ANSI/control sequences before display", () => {
    expect(sanitizeText("before\u001b[31mred\u001b[0m\u0000after")).toBe("beforeredafter");
  });

  it("renders only allow-listed complete image data", () => {
    expect(resolveImage({ type: "image", mimeType: "image/png", data: "eA==" })).toEqual({
      kind: "image",
      mimeType: "image/png",
      src: "data:image/png;base64,eA==",
    });
    expect(
      resolveImage({ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }),
    ).toMatchObject({ kind: "omitted" });
    expect(resolveImage({ type: "image", omitted: true, count: 3 })).toEqual({
      kind: "omitted",
      label: "3 images omitted",
    });
  });

  it("keeps the only HTML sink sanitized in rendered content blocks", () => {
    render(
      <ContentBlocks
        content={[
          { type: "text", text: '<img src=x onerror="alert(1)"> **safe**' },
          { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
        ]}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("strong")?.textContent).toBe("safe");
    expect(screen.getByText(/Image omitted/)).toBeTruthy();
  });
});
