// Safe Markdown pipeline: marked with embedded HTML disabled, then DOMPurify
// with an allow-listed tag/attribute set and URL scheme allow-listing. No
// unsanitized HTML ever reaches the DOM, and inline styles/handlers are
// stripped regardless of the CSP already forbidding them.
import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { highlightCode } from "./highlight.js";
import { escapeHtml, sanitizeText, truncateText } from "./text.js";

const marked = new Marked({ gfm: true, breaks: true });

marked.use({
  renderer: {
    // Disable raw/embedded HTML by rendering it as escaped text.
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.raw);
    },
    code(token: Tokens.Code): string {
      const language = token.lang?.split(/\s+/)[0];
      const code = truncateText(token.text, 40_000, 1_000).text;
      return `<pre class="code-block"><code>${highlightCode(code, language)}</code></pre>`;
    },
    codespan(token: Tokens.Codespan): string {
      return `<code class="code-inline">${escapeHtml(token.text)}</code>`;
    },
  },
});

const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
];
const ALLOWED_ATTR = ["href", "class", "title", "align"];
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|#)/i;

let hookInstalled = false;
function ensureLinkHook(purifier: typeof DOMPurify): void {
  if (hookInstalled) return;
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
  hookInstalled = true;
}

/** Render untrusted Markdown to a sanitized HTML string. */
export function renderMarkdown(source: string): string {
  ensureLinkHook(DOMPurify);
  const bounded = truncateText(sanitizeText(source), 80_000, 2_000).text;
  const rawHtml = marked.parse(bounded, { async: false });
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["style", "script", "iframe", "form", "img"],
    ALLOWED_URI_REGEXP,
  });
}
