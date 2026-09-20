import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextLabel,
  costLabel,
  cwdLabel,
  formatTokens,
  shortenPath,
  truncate,
} from "../src/client/format.ts";
import { escapeHtml, sanitizeMarkdownUrl } from "../src/client/markdown.tsx";

test("shortenPath collapses home directories", () => {
  assert.equal(shortenPath("/Users/alice/project/file.ts"), "~/project/file.ts");
  assert.equal(shortenPath("/home/bob/x"), "~/x");
  assert.equal(shortenPath("/etc/hosts"), "/etc/hosts");
});

test("cost and context labels format like the terminal UI", () => {
  assert.equal(costLabel(0.0123), "$0.02");
  assert.equal(costLabel(Number.NaN), "$—");
  assert.equal(
    contextLabel({ tokens: 32_000, contextWindow: 128_000, percent: 25 }),
    "25% of 128.0k",
  );
  assert.equal(contextLabel(undefined), "context —");
  assert.equal(formatTokens(12_345), "12.3k");
  assert.equal(truncate("abcdef", 4), "abc…");
});

test("cwdLabel shortens the home prefix", () => {
  assert.equal(cwdLabel({ cwd: "/Users/tester/project", home: "/Users/tester" }), "~/project");
});

test("sanitizeMarkdownUrl neutralizes dangerous schemes", () => {
  assert.equal(sanitizeMarkdownUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeMarkdownUrl("data:text/html;base64,PHNjcmlwdD4="), null);
  assert.equal(sanitizeMarkdownUrl("https://example.com"), "https://example.com");
  assert.equal(sanitizeMarkdownUrl("mailto:x@example.com"), "mailto:x@example.com");
  assert.equal(sanitizeMarkdownUrl("/relative/path"), "/relative/path");
});

test("escapeHtml escapes markup delimiters", () => {
  assert.equal(escapeHtml("<script>&\"'"), "&lt;script&gt;&amp;&quot;&#39;");
});
