import { CodeBlock } from "../components/CodeBlock.js";
import { ContentBlocks } from "../components/ContentBlocks.js";
import { Diff } from "../components/Diff.js";
import { asArray, asRecord, num, str, type ToolView } from "../lib/tool-model.js";
import { compactCommand, diffStats, lineCount, pluralize, shortenPath } from "../lib/text.js";
import type { ToolAdapter } from "./types.js";

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  css: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  py: "python",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
};

function languageForPath(path: string | undefined): string | undefined {
  const extension = path?.split(".").pop()?.toLowerCase();
  return extension ? EXTENSION_LANGUAGE[extension] : undefined;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function outputSummary(view: ToolView, noun = "output line"): string {
  const count = lineCount(view.text);
  const summary = count === 0 ? `no ${noun}s` : pluralize(count, noun);
  return view.isError ? `failed · ${summary}` : summary;
}

export const bashAdapter: ToolAdapter = {
  glyph: "$",
  label: "bash",
  title: (view) => (
    <span class="tool__command">
      {compactCommand(view.args.command)}
      {num(view.args.timeout) !== undefined ? (
        <span class="tool__hint"> ({num(view.args.timeout)}s timeout)</span>
      ) : null}
    </span>
  ),
  summary: (view) => (view.isPartial && !view.text ? "working…" : outputSummary(view)),
  detail: (view) =>
    view.text ? <CodeBlock code={view.text} variant="output" language="bash" /> : undefined,
};

export const editAdapter: ToolAdapter = {
  glyph: "✎",
  label: "edit",
  title: (view) => {
    const count = asArray(view.args.edits).length;
    return (
      <span class="tool__command">
        {shortenPath(str(view.args.path) ?? "…")}
        {count > 0 ? <span class="tool__hint"> · {pluralize(count, "replacement")}</span> : null}
      </span>
    );
  },
  summary: (view) => {
    const diff = str(view.details.diff);
    if (view.isError || !diff) return firstLine(view.text) || "applied";
    const { additions, removals } = diffStats(diff);
    return (
      <span class="diffstat">
        <span class="diffstat--add">+{additions}</span>
        <span class="diffstat--sep"> / </span>
        <span class="diffstat--del">-{removals}</span>
      </span>
    );
  },
  detail: (view) => {
    const diff = str(view.details.diff);
    if (diff) return <Diff patch={diff} />;
    return view.text ? <CodeBlock code={view.text} variant="output" /> : undefined;
  },
};

export const writeAdapter: ToolAdapter = {
  glyph: "✚",
  label: "write",
  title: (view) => {
    const content = str(view.args.content) ?? "";
    const count = lineCount(content);
    return (
      <span class="tool__command">
        {shortenPath(str(view.args.path) ?? "…")}
        {content ? <span class="tool__hint"> · {pluralize(count, "line")}</span> : null}
      </span>
    );
  },
  summary: (view) => (view.isError ? firstLine(view.text) || "failed" : "written"),
  detail: (view) => {
    if (view.isError && view.text) return <CodeBlock code={view.text} variant="output" />;
    const content = str(view.args.content);
    return content ? (
      <CodeBlock
        code={content}
        {...(languageForPath(str(view.args.path))
          ? { language: languageForPath(str(view.args.path))! }
          : {})}
      />
    ) : undefined;
  },
};

function locationTitle(view: ToolView): string {
  const path = str(view.args.path) ?? "";
  const pattern = str(view.args.pattern);
  const parts = [pattern, shortenPath(path)].filter(Boolean);
  return parts.join(" in ") || "…";
}

export const readAdapter: ToolAdapter = {
  glyph: "◇",
  label: "read",
  title: (view) => {
    const offset = num(view.args.offset);
    const limit = num(view.args.limit);
    const range =
      offset !== undefined || limit !== undefined ? ` (${offset ?? 1}…${limit ?? ""})` : "";
    return (
      <span class="tool__command">
        {shortenPath(str(view.args.path) ?? "…")}
        {range ? <span class="tool__hint">{range}</span> : null}
      </span>
    );
  },
  summary: (view) => outputSummary(view, "line"),
  detail: (view) => {
    const images = view.content.filter((block) => asRecord(block).type === "image");
    if (!view.text && images.length === 0) return undefined;
    return (
      <>
        {view.text ? (
          <CodeBlock
            code={view.text}
            {...(languageForPath(str(view.args.path))
              ? { language: languageForPath(str(view.args.path))! }
              : {})}
          />
        ) : null}
        {images.length > 0 ? <ContentBlocks content={images} /> : null}
      </>
    );
  },
};

export const grepAdapter: ToolAdapter = {
  glyph: "⌕",
  label: "grep",
  title: (view) => <span class="tool__command">{locationTitle(view)}</span>,
  summary: (view) => outputSummary(view, "match"),
  detail: (view) => (view.text ? <CodeBlock code={view.text} variant="output" /> : undefined),
};

export const findAdapter: ToolAdapter = {
  glyph: "⌕",
  label: "find",
  title: (view) => <span class="tool__command">{locationTitle(view)}</span>,
  summary: (view) => outputSummary(view, "result"),
  detail: (view) => (view.text ? <CodeBlock code={view.text} variant="output" /> : undefined),
};

export const lsAdapter: ToolAdapter = {
  glyph: "☰",
  label: "ls",
  title: (view) => <span class="tool__command">{shortenPath(str(view.args.path) ?? ".")}</span>,
  summary: (view) => {
    const count = view.text ? view.text.split("\n").filter(Boolean).length : 0;
    if (view.isError) return `failed · ${firstLine(view.text)}`;
    return count === 1 ? "1 entry" : `${count} entries`;
  },
  detail: (view) => (view.text ? <CodeBlock code={view.text} variant="output" /> : undefined),
};
