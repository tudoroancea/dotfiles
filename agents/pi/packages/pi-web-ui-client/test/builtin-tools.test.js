import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { h, render } from "preact";
import { MAX_HIGHLIGHT_CODE_LENGTH } from "../src/client/highlight.ts";
import { BUILTIN_TOOLS } from "../src/client/tools/builtin.tsx";

function tool(name) {
  const found = BUILTIN_TOOLS.find((candidate) => candidate.names.includes(name));
  assert.ok(found, `missing ${name} renderer`);
  return found;
}

function result(text, overrides = {}) {
  return {
    text,
    images: [],
    details: undefined,
    isError: false,
    isPartial: false,
    ...overrides,
  };
}

function renderTool(name, args, view, expanded = true) {
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>");
  const root = dom.window.document.querySelector("#root");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    Node: dom.window.Node,
  });
  const rendering = tool(name).render(args, view, { expanded, dkey: "test" });
  render(h("div", null, rendering.header, rendering.body), root);
  return { dom, root };
}

test("expanded read highlights known bounded source directly and preserves notices", () => {
  const source = 'const value: string = "<safe>";\nreturn value;';
  const notice = "Truncated: showing 2 of 20 lines";
  const { dom, root } = renderTool(
    "read",
    { path: "/tmp/view.tsx" },
    result(`${source}\n\n[${notice}]`, { details: { truncation: { truncated: true } } }),
  );
  try {
    assert.ok(root.querySelector("code.language-typescript.hljs"));
    assert.ok(root.querySelector(".hljs-keyword"));
    assert.equal(root.querySelector("code").textContent, source);
    assert.equal(root.querySelector("code safe"), null);
    assert.match(root.querySelector(".result-notice").textContent, new RegExp(notice));
  } finally {
    dom.window.close();
  }
});

test("read uses complete plain text for unknown, oversized, error, and image results", () => {
  const oversized = `${"x".repeat(MAX_HIGHLIGHT_CODE_LENGTH)}<`;
  const cases = [
    [{ path: "/tmp/source.txt" }, result("<b>plain</b>")],
    [{ path: "/tmp/source.ts" }, result(oversized)],
    [{ path: "/tmp/source.ts" }, result("<b>failed</b>", { isError: true })],
    [
      { path: "/tmp/source.ts" },
      result("Read image file [image/png]", {
        images: [{ type: "image-omission", reason: "invalid-data" }],
      }),
    ],
  ];
  for (const [args, view] of cases) {
    const { dom, root } = renderTool("read", args, view);
    try {
      assert.equal(root.querySelector("code.hljs"), null);
      assert.equal(root.textContent.includes(view.text), true);
      assert.equal(root.querySelector("b"), null);
    } finally {
      dom.window.close();
    }
  }
});

test("bash excludes an appended result notice from its collapsed line count", () => {
  const { dom, root } = renderTool(
    "bash",
    { command: "printf output" },
    result("first\nsecond\n\n[Truncated: more output]", {
      details: { truncation: { truncated: true } },
    }),
    false,
  );
  try {
    assert.match(root.textContent, /2 output lines/);
    assert.match(root.textContent, /Truncated: more output/);
  } finally {
    dom.window.close();
  }
});

test("blank-line-separated bracketed output remains source content without truncation details", () => {
  const source = "const before = true;\n\n[section]";
  const { dom, root } = renderTool("read", { path: "/tmp/values.ts" }, result(source));
  try {
    assert.equal(root.querySelector("code").textContent, source);
    assert.equal(root.querySelector(".result-notice"), null);
  } finally {
    dom.window.close();
  }
});

test("collapsed read prefers image count and excludes an appended notice from line count", () => {
  const image = renderTool(
    "read",
    { path: "/tmp/image.png" },
    result("Read image file [image/png]", {
      images: [{ type: "image-omission", reason: "invalid-data" }],
    }),
    false,
  );
  try {
    assert.match(image.root.textContent, /1 image/);
    assert.doesNotMatch(image.root.textContent, /1 line/);
  } finally {
    image.dom.window.close();
  }

  const noticed = renderTool(
    "read",
    { path: "/tmp/source.ts" },
    result("first\nsecond\n\n[Truncated: more content]", {
      details: { truncation: { truncated: true } },
    }),
    false,
  );
  try {
    assert.match(noticed.root.textContent, /2 lines/);
    assert.match(noticed.root.textContent, /Truncated: more content/);
  } finally {
    noticed.dom.window.close();
  }
});

test("write highlights only successful known bounded content", () => {
  const content = "const answer: number = 42;";
  const highlighted = renderTool("write", { path: "/tmp/value.ts", content }, result("ok"));
  try {
    assert.ok(highlighted.root.querySelector("code.language-typescript.hljs"));
    assert.equal(highlighted.root.querySelector("code").textContent, content);
  } finally {
    highlighted.dom.window.close();
  }

  for (const [path, source, view] of [
    ["/tmp/value.txt", "<plain>", result("ok")],
    ["/tmp/value.ts", `${"x".repeat(MAX_HIGHLIGHT_CODE_LENGTH)}<`, result("ok")],
    ["/tmp/value.ts", "<failed>", result("write failed", { isError: true })],
  ]) {
    const plain = renderTool("write", { path, content: source }, view);
    try {
      assert.equal(plain.root.querySelector("code.hljs"), null);
      assert.equal(plain.root.textContent.includes(source), true);
      assert.equal(plain.root.querySelector("plain, failed"), null);
    } finally {
      plain.dom.window.close();
    }
  }
});

test("write and edit decode legacy file_path and show missing path placeholders", () => {
  for (const name of ["write", "edit"]) {
    const args =
      name === "write"
        ? { file_path: "/legacy/file.ts", content: "const x = 1;" }
        : { file_path: "/legacy/file.ts", edits: [] };
    const legacy = renderTool(name, args, undefined, false);
    try {
      assert.match(legacy.root.textContent, /legacy\/file\.ts/);
    } finally {
      legacy.dom.window.close();
    }

    const missing = renderTool(
      name,
      name === "write" ? { content: "value" } : { edits: [] },
      undefined,
      false,
    );
    try {
      assert.match(missing.root.textContent, /\[path unavailable\]/);
    } finally {
      missing.dom.window.close();
    }
  }
});
