// Selective highlight.js core setup. Only a small explicit language set that
// matches the files this repository actually produces is registered; anything
// else falls back to escaped plain text.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { escapeHtml } from "./text.js";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  md: "markdown",
  py: "python",
  patch: "diff",
};

export function resolveLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const key = language.trim().toLowerCase();
  const resolved = ALIASES[key] ?? key;
  return hljs.getLanguage(resolved) ? resolved : undefined;
}

/**
 * Highlight code and return safe inner HTML for a `<code>` element. Unknown
 * languages and any highlighter failure fall back to escaped plain text.
 */
export function highlightCode(code: string, language?: string): string {
  const resolved = resolveLanguage(language);
  if (!resolved) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
