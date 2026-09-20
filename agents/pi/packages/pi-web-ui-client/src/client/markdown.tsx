// Markdown rendering and URL sanitization.
//
// This matches Pi's HTML exporter: Markdown is rendered but raw HTML/tags are
// treated as literal text and only browser-safe URL schemes emit links/images.
// DOMPurify runs as a defense-in-depth final pass over the already-escaped output
// so a future Marked regression cannot inject active markup, without changing the
// visible result for the safe HTML the exporter already produces.

import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import { useMemo } from "preact/hooks";
import { createHighlightBudget, highlightCode, type HighlightBudget } from "./highlight.ts";

let activeHighlightBudget: HighlightBudget | undefined;

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeMarkdownUrl(value: unknown): string | null {
  const href = String(value || "")
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, "");
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
  return scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1]) ? null : href;
}

marked.use({
  breaks: true,
  gfm: true,
  tokenizer: {
    html() {
      return undefined;
    },
    tag() {
      return undefined;
    },
  },
  renderer: {
    code(token: Tokens.Code) {
      const result = highlightCode(
        token.text.replace(/\n$/, ""),
        token.lang,
        activeHighlightBudget,
      );
      const classes = [result.label && `language-${result.label}`, result.highlighted && "hljs"]
        .filter(Boolean)
        .join(" ");
      const classAttribute = classes ? ` class="${classes}"` : "";
      return `<pre><code${classAttribute}>${result.html}\n</code></pre>\n`;
    },
    link(token) {
      const href = sanitizeMarkdownUrl(token.href);
      if (href === null) return this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
    },
    image(token) {
      const href = sanitizeMarkdownUrl(token.href);
      if (href === null) return escapeHtml(token.text || "");
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text || "")}"${title}>`;
    },
  },
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ["target"],
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["style"],
};

export function renderMarkdown(text: unknown): string {
  // Match the exporter: `null`/`undefined` render as empty, but any other
  // non-string payload is a malformed entry that must surface through the
  // transcript entry error boundary rather than being silently coerced.
  const source = text ?? "";
  if (typeof source !== "string") throw new TypeError("Markdown source must be a string");
  // `marked.parse` is synchronous here (no async extensions), so the result is a
  // string; the declared `string | Promise<string>` union is narrowed accordingly.
  const previousBudget = activeHighlightBudget;
  activeHighlightBudget = createHighlightBudget();
  try {
    const rendered = marked.parse(source, { async: false });
    if (typeof rendered !== "string") throw new TypeError("Markdown rendering became asynchronous");
    return DOMPurify.sanitize(rendered, PURIFY_CONFIG);
  } finally {
    activeHighlightBudget = previousBudget;
  }
}

export function Markdown({ text }: { text: unknown }) {
  const markup = useMemo(() => renderMarkdown(text), [text]);
  return <div class="markdown-content" dangerouslySetInnerHTML={{ __html: markup }} />;
}
