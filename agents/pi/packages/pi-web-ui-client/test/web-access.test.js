import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { h, render } from "preact";
import { Check } from "typebox/value";
import {
  decodeWebAccessRendererView,
  safeWebAccessUrl,
  WEB_ACCESS_LIMITS,
  WebAccessRendererViewSchema,
} from "../src/wire/index.ts";
const bootstrapDom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: bootstrapDom.window,
  document: bootstrapDom.window.document,
  Element: bootstrapDom.window.Element,
  Node: bootstrapDom.window.Node,
});
const { WEB_ACCESS_TOOLS } = await import("../src/client/tools/web-access.tsx");

const raw = (details, extras = {}) => ({
  content: [{ type: "text", text: "raw bounded output" }],
  details,
  ...extras,
});
const decodedResult = (details, extras = {}) => ({
  text: "raw bounded output",
  images: [],
  details,
  isError: false,
  isPartial: false,
  ...extras,
});

function renderTool(name, details, { expanded = true, resultExtras = {}, args = {} } = {}) {
  const tool = WEB_ACCESS_TOOLS.find((candidate) => candidate.names.includes(name));
  assert.ok(tool);
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    Node: dom.window.Node,
  });
  const root = dom.window.document.querySelector("#root");
  const rendering = tool.render(args, decodedResult(details, resultExtras), {
    expanded,
    dkey: "web-test",
  });
  render(h("div", null, rendering.header, rendering.body), root);
  return { dom, root, rendering };
}

test("pinned progress phases decode with clamped progress and curator loopback suppressed", () => {
  for (const [phase, progress] of [
    ["searching", -4],
    ["curating", 0.5],
    ["generating-summary", 0.9],
    ["waiting-for-approval", 7],
    ["curator-fallback", 1],
  ]) {
    const view = decodeWebAccessRendererView(
      "web_search",
      raw(
        {
          phase,
          progress,
          currentQuery: "query",
          curatorUrl: "http://127.0.0.1:4567/token",
          timeoutSeconds: 20,
          shortcut: "ctrl+shift+s",
          browserOpenError: "open failed",
        },
        { isPartial: true },
      ),
    );
    assert.equal(Check(WebAccessRendererViewSchema, view), true);
    assert.equal(view.status, "running");
    assert.ok(view.progress >= 0 && view.progress <= 1);
    assert.equal(view.curatorUrl, undefined);
    if (phase === "curator-fallback") assert.match(view.curatorGuidance, /session browser/);
  }
});

test("settled curated duplicate queries retain provider, answer, sources and errors by position", () => {
  const view = decodeWebAccessRendererView(
    "web_search",
    raw({
      queryCount: 2,
      successfulQueries: 1,
      totalResults: 1,
      curated: true,
      curatedFrom: 3,
      curatedQueries: [
        {
          query: "same",
          provider: "exa",
          answer: "answer one",
          sources: [{ title: "Safe", url: "https://example.com/a" }],
          error: null,
        },
        { query: "same", provider: "brave", answer: null, sources: [], error: "provider failed" },
      ],
    }),
  );
  assert.equal(view.queries.length, 2);
  assert.deepEqual(
    view.queries.map((q) => q.provider),
    ["exa", "brave"],
  );
  assert.equal(view.queries[0].sources[0].host, "example.com");
  assert.equal(view.queries[1].error, "provider failed");
});

test("curated summary metadata and source-check artifact are assembled and bounded", () => {
  const summary = decodeWebAccessRendererView(
    "web_search",
    raw({
      summary: {
        text: "# Approved",
        workflow: "auto-summary",
        model: "provider/model",
        durationMs: 42,
        tokenEstimate: 10,
        fallbackUsed: true,
        fallbackReason: "empty",
        phase: "deterministic-fallback",
        edited: true,
      },
    }),
  );
  assert.equal(summary.summary.edited, true);
  assert.equal(summary.summary.fallbackReason, "empty");
  const artifact = decodeWebAccessRendererView(
    "source_check",
    raw({
      artifact: {
        query: "claim",
        claims: [
          {
            claim: "claim",
            status: "supported",
            confidence: 2,
            rationale: "because",
            supporting_passages: ["p1", "p2"],
            contradicting_passages: ["p3"],
          },
        ],
        sources: [
          { rank: 1, quality: "official_docs", title: "Docs", url: "https://docs.example.com" },
        ],
        errors: [{ query: "q", error: "timeout" }],
      },
    }),
  );
  assert.equal(artifact.artifact.confidence, 1);
  assert.deepEqual(artifact.artifact.supportingPassages, ["p1", "p2"]);
  assert.deepEqual(artifact.artifact.contradictingPassages, ["p3"]);
  assert.equal(artifact.artifact.sources[0].quality, "official_docs");
  assert.equal(artifact.artifact.errors[0].error, "timeout");
});

test("generic result flags survive missing or incomplete vendor details", () => {
  const failed = decodeWebAccessRendererView("web_search", raw({}, { isError: true }));
  assert.equal(failed.status, "failed");
  const partial = decodeWebAccessRendererView("fetch_content", {
    content: [{ type: "text", text: "working" }],
    isPartial: true,
  });
  assert.equal(partial.status, "running");
  const rendered = renderTool(
    "web_search",
    {},
    {
      resultExtras: { isError: true },
      args: { query: "alpha" },
    },
  );
  try {
    assert.equal(rendered.rendering.status, "error");
    assert.match(rendered.root.textContent, /raw bounded output/);
  } finally {
    rendered.dom.window.close();
  }
});

test("semantic details errors override generic result success and preserve cancellation diagnostics", () => {
  const view = decodeWebAccessRendererView(
    "web_search",
    raw({
      error: "Search curation cancelled (stale).",
      cancelled: true,
      cancelReason: "stale",
      browserConnected: false,
      lastHeartbeatAgeMs: 2200,
      queryCount: 2,
      cancelledQueries: [
        { query: "done", provider: "exa", error: null, resultCount: 3 },
        { query: "bad", provider: "brave", error: "quota", resultCount: 0 },
      ],
      extraLines: ["curator: http://127.0.0.1:1/private"],
    }),
  );
  assert.equal(view.status, "cancelled");
  assert.equal(view.diagnostics.browserConnected, false);
  assert.equal(view.diagnostics.queries[1].error, "quota");
});

test("malformed, hostile and adversarial collections are total and strictly bounded", () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("hostile");
      },
    },
  );
  assert.doesNotThrow(() => decodeWebAccessRendererView("web_search", hostile));
  assert.equal(decodeWebAccessRendererView("web_search", hostile).malformed, true);
  const many = Array.from({ length: WEB_ACCESS_LIMITS.maxQueries + 50 }, (_, index) => ({
    query: `q${index}`,
    provider: "exa",
    answer: "x".repeat(WEB_ACCESS_LIMITS.maxTextChars + 10),
    sources: Array.from({ length: 50 }, (_, i) => ({
      title: `s${i}`,
      url: `https://example.com/${i}`,
    })),
    error: null,
  }));
  const view = decodeWebAccessRendererView("web_search", raw({ curatedQueries: many }));
  assert.equal(Check(WebAccessRendererViewSchema, view), true);
  assert.equal(view.queries.length, WEB_ACCESS_LIMITS.maxQueries);
  assert.equal(view.queries[0].sources.length, WEB_ACCESS_LIMITS.maxSourcesPerQuery);
  assert.equal(view.queries[0].answer.length, WEB_ACCESS_LIMITS.maxTextChars);
  assert.equal(view.omitted, 50);
  assert.match(view.notices.join(" "), /50 query records omitted/);
  assert.match(view.notices.join(" "), /source records omitted/);
  assert.match(view.notices.join(" "), /query answers truncated/);
  const rendered = renderTool("web_search", { curatedQueries: many }, { args: { query: "q" } });
  try {
    assert.match(rendered.root.textContent, /query records omitted/);
    assert.match(rendered.root.textContent, /source records omitted/);
    assert.match(rendered.root.textContent, /query answers truncated/);
  } finally {
    rendered.dom.window.close();
  }
  const sanitized = decodeWebAccessRendererView(
    "web_search",
    raw({ curatedQueries: [{ query: "safe\0query", sources: [] }] }),
  );
  assert.equal(sanitized.queries[0].query, "safequery");
});

test("empty source titles fall back to accessible link text", () => {
  const rendered = renderTool(
    "web_search",
    {
      queryCount: 1,
      curated: true,
      curatedQueries: [
        {
          query: "q",
          provider: "exa",
          sources: [{ title: "   ", url: "https://example.com/source" }],
        },
      ],
    },
    { args: { query: "q" } },
  );
  try {
    assert.equal(rendered.root.querySelector("a").textContent, "https://example.com/source");
  } finally {
    rendered.dom.window.close();
  }
});

test("URL allowlist rejects active schemes and loopback curator links", () => {
  assert.equal(safeWebAccessUrl("javascript:alert(1)"), undefined);
  assert.equal(safeWebAccessUrl("file:///etc/passwd"), undefined);
  assert.equal(safeWebAccessUrl("http://localhost:1234/x", true), undefined);
  assert.equal(safeWebAccessUrl("http://localhost.:1234/x", true), undefined);
  assert.equal(safeWebAccessUrl("http://127.23.45.67:1234/x", true), undefined);
  assert.equal(safeWebAccessUrl("http://[::1]:1234/x", true), undefined);
  assert.equal(safeWebAccessUrl("http://[::ffff:127.0.0.1]:1234/x", true), undefined);
  assert.equal(safeWebAccessUrl("https://example.com/x"), "https://example.com/x");
});

test("renderer shows progress, structured results, safe links and semantic error tone", () => {
  const progress = renderTool(
    "web_search",
    { phase: "searching", progress: 0.25, currentQuery: "alpha" },
    { resultExtras: { isPartial: true }, args: { query: "alpha" } },
  );
  try {
    assert.match(progress.root.textContent, /25%/);
    assert.match(progress.root.textContent, /alpha/);
    assert.equal(progress.root.querySelector("progress").value, 0.25);
    assert.match(progress.root.querySelector("progress").getAttribute("aria-label"), /25%/);
  } finally {
    progress.dom.window.close();
  }
  const approval = renderTool(
    "web_search",
    {
      phase: "waiting-for-approval",
      progress: 1,
      timeoutSeconds: 30,
      shortcut: "ctrl+shift+s",
    },
    { resultExtras: { isPartial: true }, args: { query: "alpha" } },
  );
  try {
    assert.match(approval.root.textContent, /Auto-submits after 30s idle/);
    assert.match(approval.root.textContent, /ctrl\+shift\+s reopens/);
  } finally {
    approval.dom.window.close();
  }
  const settled = renderTool(
    "web_search",
    {
      queryCount: 1,
      successfulQueries: 1,
      totalResults: 1,
      curated: true,
      curatedQueries: [
        {
          query: "alpha",
          provider: "exa",
          answer: "**answer**",
          sources: [{ title: "Source", url: "https://example.com/x" }],
          error: null,
        },
      ],
    },
    { args: { query: "alpha" } },
  );
  try {
    assert.equal(settled.root.querySelector("a").getAttribute("href"), "https://example.com/x");
    assert.match(settled.root.textContent, /answer/);
  } finally {
    settled.dom.window.close();
  }
  const failure = renderTool(
    "get_search_content",
    { error: "Query not found", query: "missing" },
    { args: { responseId: "id", query: "missing" } },
  );
  try {
    assert.equal(failure.rendering.status, "error");
    assert.match(failure.root.textContent, /Query not found/);
  } finally {
    failure.dom.window.close();
  }
});

test("source-check renders passage ids, retrieval guidance, and the full pinned call scope", () => {
  const rendered = renderTool(
    "source_check",
    {
      responseId: "research_1",
      artifact: {
        query: "claim",
        claims: [
          {
            claim: "claim",
            status: "supported",
            supporting_passages: ["p1"],
            contradicting_passages: ["p2"],
          },
        ],
        sources: [],
      },
    },
    {
      args: {
        claim: "claim",
        numResults: 8,
        recencyFilter: "month",
        domainFilter: ["docs.example.com", "-blog.example.com"],
      },
    },
  );
  try {
    assert.match(
      rendered.root.textContent,
      /8 per query · past month · docs\.example\.com, -blog\.example\.com/,
    );
    assert.match(rendered.root.textContent, /Supporting passages: p1/);
    assert.match(rendered.root.textContent, /Contradicting passages: p2/);
    assert.match(
      rendered.root.textContent,
      /Artifact research_1 is retrievable with get_search_content/,
    );
  } finally {
    rendered.dom.window.close();
  }
});

test("fetch errors retain bounded URL diagnostics from the vendor details shape", () => {
  const view = decodeWebAccessRendererView(
    "fetch_content",
    raw({
      error: "fetch failed",
      urls: ["https://example.com/a", "javascript:alert(1)"],
      urlCount: 2,
      successful: 1,
      responseId: "fetch_1",
    }),
  );
  assert.deepEqual(view.fetchUrls, ["https://example.com/a"]);
  const rendered = renderTool(
    "fetch_content",
    {
      error: "fetch failed",
      urls: ["https://example.com/a"],
      urlCount: 2,
      successful: 1,
      responseId: "fetch_1",
    },
    { args: { urls: ["https://example.com/a"] } },
  );
  try {
    assert.match(rendered.root.textContent, /https:\/\/example\.com\/a/);
  } finally {
    rendered.dom.window.close();
  }
});

test("fetch/get/source renderers preserve images and bounded raw fallback while adding details", () => {
  for (const [name, details, args] of [
    [
      "fetch_content",
      { urlCount: 1, successful: 1, totalChars: 20, title: "Page", responseId: "f" },
      { url: "https://example.com" },
    ],
    [
      "get_search_content",
      { title: "Page", contentLength: 100, offset: 10, returnedChars: 20, nextOffset: 30 },
      { responseId: "f", urlIndex: 0 },
    ],
    ["source_check", { responseId: "r", sourceCount: 0, passageCount: 0 }, { claim: "claim" }],
  ]) {
    const rendered = renderTool(name, details, {
      args,
      resultExtras: { images: [{ type: "image-omission", reason: "invalid-data" }] },
    });
    try {
      assert.match(rendered.root.textContent, /Image unavailable/);
      assert.match(rendered.root.textContent, /raw bounded output/);
    } finally {
      rendered.dom.window.close();
    }
  }
});
