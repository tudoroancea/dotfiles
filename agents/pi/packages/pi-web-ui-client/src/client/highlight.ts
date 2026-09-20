// Selective Highlight.js core registry. Keep this list explicit so the browser
// bundle never pulls in language auto-detection or the complete language set.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  ruby,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
} as const;

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

const ALIASES: Readonly<Record<string, keyof typeof LANGUAGES>> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  h: "c",
  hpp: "cpp",
  "c++": "cpp",
  cs: "csharp",
  "c#": "csharp",
  patch: "diff",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  svg: "xml",
  yml: "yaml",
};

const PATH_EXTENSIONS: Readonly<Record<string, keyof typeof LANGUAGES>> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  patch: "diff",
  go: "go",
  java: "java",
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sql: "sql",
  cts: "typescript",
  mts: "typescript",
  ts: "typescript",
  tsx: "typescript",
  htm: "xml",
  html: "xml",
  svg: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const PATH_FILENAMES: Readonly<Record<string, keyof typeof LANGUAGES>> = {
  dockerfile: "dockerfile",
};

/** Resolve only file names and extensions covered by the explicit browser registry. */
export function resolveLanguageFromPath(
  path: string | null | undefined,
): keyof typeof LANGUAGES | undefined {
  if (!path) return undefined;
  const filename = path.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!filename) return undefined;
  const named = PATH_FILENAMES[filename];
  if (named) return named;
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return undefined;
  return PATH_EXTENSIONS[filename.slice(dot + 1)];
}

// Highlighting is synchronous. Above this boundary the complete code remains in
// the entry, but expensive grammar processing is skipped.
export const MAX_HIGHLIGHT_CODE_LENGTH = 32 * 1024;
export const MAX_HIGHLIGHT_TOTAL_LENGTH = 64 * 1024;
export const MAX_HIGHLIGHT_BLOCKS = 16;
const MAX_LANGUAGE_LABEL_LENGTH = 32;
const SAFE_LANGUAGE_LABEL = /^[a-z0-9][a-z0-9_+#.-]*$/;

export function normalizeLanguageLabel(info: string | undefined): string | undefined {
  const token = info?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!token || token.length > MAX_LANGUAGE_LABEL_LENGTH || !SAFE_LANGUAGE_LABEL.test(token)) {
    return undefined;
  }
  return token;
}

export function resolveLanguage(label: string | undefined): keyof typeof LANGUAGES | undefined {
  if (!label) return undefined;
  const resolved = ALIASES[label] ?? label;
  return Object.hasOwn(LANGUAGES, resolved) ? (resolved as keyof typeof LANGUAGES) : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface HighlightedCode {
  html: string;
  highlighted: boolean;
  label?: string;
}

export interface HighlightBudget {
  remainingLength: number;
  remainingBlocks: number;
}

export function createHighlightBudget(): HighlightBudget {
  return {
    remainingLength: MAX_HIGHLIGHT_TOTAL_LENGTH,
    remainingBlocks: MAX_HIGHLIGHT_BLOCKS,
  };
}

/** Return safe code-element HTML, falling back to escaped complete text. */
export function highlightCode(
  code: string,
  info?: string,
  budget?: HighlightBudget,
): HighlightedCode {
  const label = normalizeLanguageLabel(info);
  const language = resolveLanguage(label);
  if (
    !language ||
    code.length > MAX_HIGHLIGHT_CODE_LENGTH ||
    (budget && (budget.remainingBlocks < 1 || code.length > budget.remainingLength))
  ) {
    return { html: escapeHtml(code), highlighted: false, label };
  }
  if (budget) {
    budget.remainingBlocks -= 1;
    budget.remainingLength -= code.length;
  }
  try {
    return {
      html: hljs.highlight(code, { language, ignoreIllegals: true }).value,
      highlighted: true,
      label,
    };
  } catch {
    return { html: escapeHtml(code), highlighted: false, label };
  }
}
