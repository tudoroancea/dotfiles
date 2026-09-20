import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  highlightCode,
  MAX_HIGHLIGHT_BLOCKS,
  MAX_HIGHLIGHT_CODE_LENGTH,
  normalizeLanguageLabel,
  resolveLanguage,
  resolveLanguageFromPath,
} from "../src/client/highlight.ts";

test("selective registry highlights representative fenced languages", () => {
  const fixtures = [
    ["typescript", "const value: number = 1;", "hljs-keyword"],
    ["json", '{"safe": true}', "hljs-attr"],
    ["bash", "echo $HOME", "hljs-built_in"],
    ["diff", "+added", "hljs-addition"],
  ];
  for (const [language, source, expectedClass] of fixtures) {
    const result = highlightCode(source, language);
    assert.equal(result.highlighted, true, language);
    assert.match(result.html, new RegExp(expectedClass), language);
  }
});

test("explicit safe aliases resolve without auto-detection", () => {
  const aliases = {
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
  for (const [alias, language] of Object.entries(aliases)) {
    assert.equal(resolveLanguage(normalizeLanguageLabel(alias)), language);
  }
  assert.equal(resolveLanguage("plaintext"), undefined);
});

test("file paths resolve conservatively through the explicit registry", () => {
  const known = {
    "/workspace/src/view.tsx": "typescript",
    "C:\\workspace\\script.py": "python",
    "/workspace/Dockerfile": "dockerfile",
    "/workspace/config.yml": "yaml",
    "/workspace/header.hpp": "cpp",
  };
  for (const [path, language] of Object.entries(known)) {
    assert.equal(resolveLanguageFromPath(path), language, path);
  }
  for (const path of ["/workspace/Makefile", "/workspace/data.txt", "/workspace/file", ""]) {
    assert.equal(resolveLanguageFromPath(path), undefined, path);
  }
});

test("unknown and hostile labels use escaped plain text", () => {
  const source = '<img src=x onerror="alert(1)">&';
  for (const label of ["brainfuck", 'ts"><img', `ts${"x".repeat(32)}`]) {
    const result = highlightCode(source, label);
    assert.equal(result.highlighted, false);
    assert.equal(result.html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  }
  assert.equal(normalizeLanguageLabel("TS linenos=true"), "ts");
});

test("highlight cutoff is exact and over-cutoff content remains complete", () => {
  const boundary = " ".repeat(MAX_HIGHLIGHT_CODE_LENGTH);
  const over = `${boundary}<`;
  assert.equal(highlightCode(boundary, "ts").highlighted, true);
  const skipped = highlightCode(over, "ts");
  assert.equal(skipped.highlighted, false);
  assert.equal(skipped.html, `${boundary}&lt;`);
});

test("Marked fences retain safe language classes and pass highlighted HTML through DOMPurify", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    Node: dom.window.Node,
  });
  try {
    const { renderMarkdown } = await import("../src/client/markdown.tsx");
    const known = renderMarkdown("```TS linenos=true\nconst value: number = 1;\n```");
    assert.match(known, /<code class="language-ts hljs">/);
    assert.match(known, /<span class="hljs-keyword">const<\/span>/);

    const trailingBlank = renderMarkdown("```ts\nconst spaced = true;\n\n```");
    assert.equal(
      new JSDOM(trailingBlank).window.document.querySelector("code")?.textContent,
      "const spaced = true;\n",
    );

    const unknown = renderMarkdown("```unknown\n<img onerror=alert(1)>\n```");
    assert.match(unknown, /<code class="language-unknown">/);
    assert.match(unknown, /&lt;img onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(unknown, /<img/);

    const hostile = renderMarkdown('```ts"><img/onerror=alert(1)\n<b>unsafe</b>\n```');
    assert.match(hostile, /<pre><code>&lt;b&gt;unsafe&lt;\/b&gt;/);
    assert.doesNotMatch(hostile, /language-|<b>|onerror=/);

    const aliases = renderMarkdown(
      "```c++\nint main() { return 0; }\n```\n\n```c#\npublic class Demo {}\n```",
    );
    assert.equal((aliases.match(/class="language-c\+\+ hljs"/g) ?? []).length, 1);
    assert.equal((aliases.match(/class="language-c# hljs"/g) ?? []).length, 1);

    const manyFences = Array.from(
      { length: MAX_HIGHLIGHT_BLOCKS + 2 },
      (_, index) => `\`\`\`ts\nconst value${index} = ${index};\n\`\`\``,
    ).join("\n\n");
    const aggregate = renderMarkdown(manyFences);
    assert.equal((aggregate.match(/class="language-ts hljs"/g) ?? []).length, MAX_HIGHLIGHT_BLOCKS);
    assert.equal((aggregate.match(/class="language-ts"/g) ?? []).length, 2);
    assert.match(new JSDOM(aggregate).window.document.body.textContent, /const value17 = 17;/);

    const largeSource = `${" ".repeat(MAX_HIGHLIGHT_CODE_LENGTH)}<`;
    const large = renderMarkdown(`\`\`\`ts\n${largeSource}\n\`\`\``);
    assert.match(large, /<code class="language-ts">/);
    assert.doesNotMatch(large, /hljs/);
    assert.equal(
      new JSDOM(large).window.document.querySelector("code")?.textContent,
      `${largeSource}\n`,
    );
  } finally {
    dom.window.close();
  }
});
