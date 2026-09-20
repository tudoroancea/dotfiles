import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { h, render } from "preact";
import { FFF_TOOLS } from "../src/client/tools/fff.tsx";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
    url: "http://127.0.0.1/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  });
  return dom;
}

function tool(name) {
  const found = FFF_TOOLS.find((candidate) => candidate.names.includes(name));
  assert.ok(found, `missing renderer for ${name}`);
  return found;
}

function result(text, details = undefined, isError = false) {
  return { text, details, isError, images: [], isPartial: false };
}

function draw(name, args, value, expanded = false) {
  const root = document.querySelector("#app");
  const rendered = tool(name).render(args, value, { expanded, dkey: `test:${name}` });
  render(h("div", null, h("div", { class: "header" }, rendered.header), rendered.body), root);
  return root;
}

test("fffind uses totalMatched and reports continuation state without treating totalFiles as matches", () => {
  const dom = installDom();
  try {
    let root = draw(
      "fffind",
      { pattern: "profile", cursor: "next" },
      result("src/profile.ts\nsrc/profile.test.ts", {
        totalMatched: 37,
        totalFiles: 90_000,
        pageIndex: 1,
        hasMore: true,
      }),
    );
    assert.equal(
      root.querySelector(".compact-result").textContent,
      "37 paths · page 2 · more available",
    );

    root = draw("fffind", { pattern: "profile" }, result("src/profile.ts", { totalFiles: 90_000 }));
    assert.equal(root.querySelector(".compact-result").textContent, "1 path");
  } finally {
    dom.window.close();
  }
});

test("ffgrep counts printed matches and files and safely separates only the fuzzy fallback", () => {
  const dom = installDom();
  try {
    let root = draw(
      "ffgrep",
      { pattern: "session" },
      result(
        "[2 exact matches. Showing fuzzy matches too]\nsrc/a.ts\n  2: session\n\nsrc/b.ts\n  8: session\n\n[More results available]",
        { totalMatched: 99, totalFiles: 50_000 },
      ),
    );
    assert.equal(root.querySelector(".compact-result").textContent, "2 matching lines in 2 files");
    assert.deepEqual(
      [...root.querySelectorAll(".result-notice")].map((node) => node.textContent),
      ["[2 exact matches. Showing fuzzy matches too]", "[More results available]"],
    );

    root = draw(
      "ffgrep",
      { pattern: "id" },
      result("[id]\n  4: id", { totalMatched: 1, totalFiles: 12_000 }),
    );
    assert.equal(root.querySelector(".compact-result").textContent, "1 matching line");
    assert.equal(root.querySelectorAll(".result-notice").length, 0);
  } finally {
    dom.window.close();
  }
});

test("multiline bracketed result groups are not mistaken for trailing notices", () => {
  const dom = installDom();
  try {
    const body = "src/a.ts\n  1: x\n\n[generated\nresult]";
    const root = draw("ffgrep", { pattern: "x" }, result(body), true);
    assert.match(root.querySelector(".tool-output").textContent, /\[generatedresult\]/);
    assert.equal(root.querySelector(".result-notice"), null);
  } finally {
    dom.window.close();
  }
});

test("wildcard-only guards render their refusal instead of an empty-match summary", () => {
  const dom = installDom();
  try {
    const root = draw(
      "ffgrep",
      { pattern: ".*" },
      result("Wildcard-only patterns are refused; provide a literal search term.", {
        totalMatched: 0,
        totalFiles: 1_000,
      }),
    );
    assert.equal(
      root.querySelector(".compact-result").textContent,
      "Wildcard-only patterns are refused; provide a literal search term.",
    );
    assert.doesNotMatch(root.textContent, /no matches/);
  } finally {
    dom.window.close();
  }
});

test("fff-multi-grep renders its actual patterns and constraints and tolerates malformed details", () => {
  const dom = installDom();
  try {
    let root = draw(
      "fff-multi-grep",
      {
        patterns: ["alpha", 7, "beta"],
        constraints: "*.ts",
        context: 2,
        limit: 20,
        cursor: "next",
      },
      result("src/a.ts\n  1: alpha\n  3: beta", {
        totalMatched: 500,
        totalFiles: 70_000,
      }),
    );
    assert.match(root.querySelector(".header").textContent, /fff-multi-grep alpha, beta/);
    assert.match(root.querySelector(".header").textContent, /matching \*\.ts/);
    assert.match(root.querySelector(".header").textContent, /±2 context · limit 20 · next page/);
    assert.equal(root.querySelector(".compact-result").textContent, "2 matching lines");

    assert.doesNotThrow(() => {
      root = draw(
        "fff-multi-grep",
        { patterns: { nope: true }, constraints: 42 },
        result("No matches found", { totalMatched: Number.NaN, totalFiles: 123_456 }),
      );
    });
    assert.match(root.querySelector(".header").textContent, /invalid constraints arg/);
    assert.equal(root.querySelector(".compact-result").textContent, "no matches");
  } finally {
    dom.window.close();
  }
});

test("expanded FFF output preserves blank separators and remains bounded", () => {
  const dom = installDom();
  try {
    let root = draw(
      "ffgrep",
      { pattern: "x" },
      result("src/a.ts\n  1: x\n\nsrc/b.ts\n  2: x"),
      true,
    );
    assert.deepEqual(
      [...root.querySelector(".tool-output").children].map((node) => node.textContent),
      ["src/a.ts", "  1: x", "", "src/b.ts", "  2: x"],
    );

    const lines = Array.from({ length: 402 }, (_, index) => `line ${index + 1}`);
    root = draw("fffind", { pattern: "line" }, result(lines.join("\n")), true);
    assert.equal(root.querySelectorAll(".tool-output > div:not(.expand-hint)").length, 400);
    assert.equal(root.querySelector(".expand-hint").textContent, "... (2 more lines)");
  } finally {
    dom.window.close();
  }
});
