import { AnsiOutput } from "../components/AnsiOutput.js";
import { ContentBlocks } from "../components/ContentBlocks.js";
import { Diff } from "../components/Diff.js";
import { ExporterOutput } from "../components/ExporterOutput.js";
import { asRecord, num, str, type ToolView } from "../lib/tool-model.js";
import { resolveLanguage } from "../lib/highlight.js";
import { lineCount, pluralize, shortenPath } from "../lib/text.js";
import type { InlineToolRenderContext, ToolAdapter } from "./types.js";

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function outputSummary(view: ToolView, noun = "output line", text = view.text): string {
  const count = lineCount(text);
  const summary = count === 0 ? `no ${noun}s` : pluralize(count, noun);
  return view.isError ? `failed · ${summary}` : summary;
}

function exporterString(value: unknown): string | null {
  if (typeof value === "string") return str(value) ?? "";
  return value === null || value === undefined ? "" : null;
}

function pathArg(view: ToolView): string | null {
  return exporterString(view.args.file_path ?? view.args.path);
}

function filePath(view: ToolView, missingFallback = ""): string {
  const path = pathArg(view);
  if (path === null) return "[invalid arg]";
  return shortenPath(path || missingFallback);
}

const PATH_LANGUAGE: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  html: "xml",
  css: "css",
  scss: "scss",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  md: "markdown",
  dockerfile: "dockerfile",
};

function pathLanguage(view: ToolView): string | undefined {
  const path = pathArg(view);
  if (!path) return undefined;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const language = PATH_LANGUAGE[name.split(".").at(-1)?.toLowerCase() ?? ""];
  return resolveLanguage(language);
}

function path(view: ToolView, missingFallback = "") {
  const invalid = pathArg(view) === null;
  return (
    <span class={`tool__path${invalid ? " tool__error" : ""}`}>
      {filePath(view, missingFallback)}
    </span>
  );
}

function output(
  text: string,
  context: InlineToolRenderContext,
  previewLines: number,
  label: string,
  language?: string,
) {
  return text ? (
    <ExporterOutput
      text={text}
      previewLines={previewLines}
      expanded={context.expanded}
      onExpandedChange={context.onExpandedChange}
      label={label}
      {...(language ? { language } : {})}
    />
  ) : undefined;
}

export const bashAdapter: ToolAdapter = {
  glyph: "$",
  label: "bash",
  title: (view) => {
    const command = exporterString(view.args.command);
    return (
      <span class={`tool__command${command === null ? " tool__error" : ""}`}>
        {command === null ? "[invalid arg]" : command || "…"}
      </span>
    );
  },
  summary: (view) =>
    view.isPartial && !view.text
      ? "working…"
      : outputSummary(view, "output line", view.text.trim()),
  inline: (view, context) => output(view.text.trim(), context, 5, "bash output"),
};

export const editAdapter: ToolAdapter = {
  glyph: "edit",
  label: "edit",
  title: (view) => <span class="tool__command">{path(view)}</span>,
  summary: (view) => firstLine(view.text) || (view.isError ? "failed" : "applied"),
  inline: (view) => {
    const diff = str(view.details.diff);
    const fallback = view.text.trim();
    if (diff) return <Diff patch={diff.replace(/\t/g, "   ")} />;
    return fallback ? <AnsiOutput text={fallback} label="edit output" /> : undefined;
  },
  inlineBodyClass: (view) => (str(view.details.diff) ? "tool__body--flush" : undefined),
};

export const writeAdapter: ToolAdapter = {
  glyph: "write",
  label: "write",
  title: (view) => {
    const content = exporterString(view.args.content);
    const count = lineCount(content ?? "");
    return (
      <span class="tool__command">
        {path(view)}
        {content !== null && count > 10 ? (
          <span class="tool__hint"> ({pluralize(count, "line")})</span>
        ) : null}
      </span>
    );
  },
  summary: (view) => (view.isError ? firstLine(view.text) || "failed" : "written"),
  inline: (view, context) => {
    const content = exporterString(view.args.content);
    const result = view.text.trim();
    if (!content && !result && content !== null) return undefined;
    return (
      <>
        {content === null ? (
          <div class="tool__error">[invalid content arg - expected string]</div>
        ) : content ? (
          output(content, context, 10, "write content", pathLanguage(view))
        ) : null}
        {result ? <AnsiOutput text={result} label="write output" /> : null}
      </>
    );
  },
};

export const readAdapter: ToolAdapter = {
  glyph: "read",
  label: "read",
  title: (view) => {
    const offset = num(view.args.offset);
    const limit = num(view.args.limit);
    const start = offset ?? 1;
    const end = limit === undefined ? undefined : start + limit - 1;
    const range =
      offset !== undefined || limit !== undefined
        ? `:${start}${end === undefined ? "" : `-${end}`}`
        : "";
    return (
      <span class="tool__command">
        {path(view)}
        {range ? <span class="tool__hint tool__range">{range}</span> : null}
      </span>
    );
  },
  summary: (view) => outputSummary(view, "line"),
  inlineBodyClass: (view) =>
    view.content.some((block) => asRecord(block).type === "image")
      ? "tool__body--flush"
      : undefined,
  inline: (view, context) => {
    const images = view.content.filter((block) => asRecord(block).type === "image");
    if (!view.text && images.length === 0) return undefined;
    return (
      <>
        {images.length > 0 ? <ContentBlocks content={images} /> : null}
        {output(view.text, context, 10, "read output", pathLanguage(view))}
      </>
    );
  },
};

function locationTitle(view: ToolView): string {
  const path = str(view.args.path) ?? "";
  const pattern = str(view.args.pattern);
  const parts = [pattern, shortenPath(path)].filter(Boolean);
  return parts.join(" in ") || "…";
}

export const grepAdapter: ToolAdapter = {
  glyph: "grep",
  label: "grep",
  title: (view) => <span class="tool__command">{locationTitle(view)}</span>,
  summary: (view) => outputSummary(view, "match"),
  detail: (view) => (view.text ? <AnsiOutput text={view.text} label="grep output" /> : undefined),
};

export const findAdapter: ToolAdapter = {
  glyph: "find",
  label: "find",
  title: (view) => <span class="tool__command">{locationTitle(view)}</span>,
  summary: (view) => outputSummary(view, "result"),
  detail: (view) => (view.text ? <AnsiOutput text={view.text} label="find output" /> : undefined),
};

export const lsAdapter: ToolAdapter = {
  glyph: "ls",
  label: "ls",
  title: (view) => {
    const limit = num(view.args.limit);
    return (
      <span class="tool__command">
        {path(view, ".")}
        {limit !== undefined ? <span class="tool__hint"> (limit {limit})</span> : null}
      </span>
    );
  },
  summary: (view) => outputSummary(view, "entry", view.text.trim()),
  inline: (view, context) => output(view.text.trim(), context, 20, "ls output"),
};
