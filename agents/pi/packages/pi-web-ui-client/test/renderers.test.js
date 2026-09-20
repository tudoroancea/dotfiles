import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// Render the transcript through the incremental protocol. `installDom` gives the
// window virtualizer a very tall viewport so every fixture row mounts, letting one
// deterministic assertion still cover every renderer branch. The dedicated
// virtualization test uses a normal viewport to prove mounted rows stay bounded.
function installDom({ innerHeight = 100000 } = {}) {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
    url: "http://127.0.0.1/session/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.innerHeight = innerHeight;
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
    history: window.history,
    location: window.location,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

/** Expand every mounted tool box through the global tool-output hotkey. */
function expandAllTools(root) {
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "e" }));
  return root;
}

/** Wrap opaque transcript entries into a v1 snapshot envelope. */
function snapshotEnvelope(entries, { sessionName = "Broad fixture", metadata } = {}) {
  return {
    version: 1,
    type: "snapshot",
    generation: "render-fixture",
    revision: 0,
    snapshot: {
      commandEpoch: "render-command-epoch",
      header: { id: "fixture-session-broad" },
      leafId: entries.at(-1)?.id ?? null,
      sessionName,
      systemPrompt: "You are the deterministic test assistant.",
      entries: entries.map((entry) => ({ id: entry.id, payload: entry })),
      liveTail: [],
      history: {
        historyGeneration: "render-history",
        beforeCursor: null,
        hasMore: false,
        oldestEntryId: entries[0]?.id ?? null,
      },
      metadata,
      queue: [],
      running: { isRunning: false },
    },
  };
}

test("broad fixture renders deterministically without Pi or HTTP", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { broadFixtureEntries, BASE_METADATA, createMockIncrementalTransport }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const root = document.querySelector("#app");
    const entries = broadFixtureEntries();
    entries[1].message.content[0].thinking =
      "Private reasoning with a [reference](https://example.com/thinking).";
    entries.push(
      {
        id: "malformed-assistant",
        type: "message",
        message: {
          role: "assistant",
          content: [null, { type: "toolCall", id: "missing-name", arguments: null }],
        },
      },
      { id: "malformed-summary", type: "branch_summary", summary: { unexpected: true } },
    );
    const transport = createMockIncrementalTransport(
      snapshotEnvelope(entries, { metadata: BASE_METADATA }),
    );
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(document.title, "π – Broad fixture");
    assert.match(root.textContent, /A visible assistant response/);
    assert.match(root.textContent, /Compacted from 12,345 tokens/);
    assert.match(root.textContent, /Please apply the demo skill/);
    assert.match(root.textContent, /✓ completed bg_1 · completed/);
    assert.match(root.textContent, /■ bg_2 #1 1-3/);
    assert.match(root.textContent, /line one/);
    const compaction = root.querySelector(".compaction");
    assert.equal(compaction.querySelector(".compaction-content"), null);
    compaction.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    compaction.querySelector(".compaction-content").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(compaction.querySelector(".compaction-content"), null);

    const skill = root.querySelector(".skill-invocation");
    skill.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(
      skill.querySelector(".skill-invocation-content").textContent,
      /Skill body content/,
    );

    const completion = [...root.querySelectorAll(".hook-message")].find((node) =>
      node.textContent.includes("bg_1"),
    );
    assert.ok(completion);
    completion.querySelector(".tool-header").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(completion.querySelector(".background-job"));
    assert.match(completion.textContent, /sleep 30/);
    assert.equal(root.querySelectorAll("script").length, 0);
    assert.equal(root.querySelectorAll("img[onerror]").length, 0);
    assert.equal(root.querySelector('a[href^="javascript:"]'), null);
    assert.equal(root.querySelectorAll(".tool-execution").length >= 7, true);
    assert.match(root.textContent, /unknown/);
    // Malformed entries degrade in place rather than tripping the error boundary:
    // every renderer coerces untrusted fields, so a non-string branch summary
    // renders as an empty summary instead of throwing. The boundary remains
    // defence-in-depth and is asserted not to fire for valid payloads below.
    assert.equal(root.querySelector('[aria-label="Message"]')?.tagName, "TEXTAREA");
    assert.equal(root.querySelector('[aria-label="Send message"]')?.tagName, "BUTTON");
    assert.equal(
      root.querySelector('[aria-label^="Whole-session recorded spend:"]')?.getAttribute("title"),
      "Recorded spend across the whole session tree",
    );

    root.querySelector(".thinking-collapsed").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const thinkingToggle = root.querySelector('[aria-label="Collapse thinking"]');
    const thinkingLink = root.querySelector(
      '.thinking-block a[href="https://example.com/thinking"]',
    );
    assert.ok(thinkingToggle);
    assert.ok(thinkingLink);
    const enter = new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    thinkingLink.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false);
    assert.equal(thinkingToggle.getAttribute("aria-expanded"), "true");

    assert.deepEqual(
      [...root.children].map((element) => element.className || element.id),
      ["status-bar", "messages", "composer-dock"],
    );

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("edit diff renders bounded selectable semantics and persists disclosure across replacement", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    localStorage.setItem("web-ui.pref.tools", "1");
    const makeEntries = (diff, details = { diff }, isPartial = false) => [
      {
        id: "edit-call-entry",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "bounded-edit-call",
              name: "edit",
              arguments: { path: "/tmp/file", edits: [{ oldText: "old", newText: "new" }] },
            },
          ],
        },
      },
      {
        id: "edit-result-entry",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "bounded-edit-call",
          toolName: "edit",
          content: [{ type: "text", text: "Applied fallback text" }],
          details,
          isError: false,
          isPartial,
        },
      },
    ];
    const lines = ["--- a/file", "+++ b/file", "@@ -1 +1 @@", "-old", "+new"];
    for (let index = 0; index < 1_100; index += 1) lines.push(` context ${index}`);
    const transport = createMockIncrementalTransport(
      snapshotEnvelope(makeEntries(lines.join("\n"))),
    );
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));

    let box = root.querySelector(".tool-execution");
    let diff = root.querySelector(".tool-diff");
    assert.equal(
      box.querySelector(".tool-disclosure-toggle").getAttribute("aria-expanded"),
      "true",
      "pref default expands the box",
    );
    assert.equal(diff.getAttribute("role"), null, "selectable text is not an interactive wrapper");
    assert.equal(diff.getAttribute("tabindex"), null);
    assert.equal(diff.querySelector(".diff-toggle"), null, "no inner diff disclosure toggle");
    assert.equal(
      diff.querySelectorAll(".diff-line").length,
      1_024,
      "expansion renders the full retained diff",
    );
    assert.match(root.textContent, /\+1 \/ -1.*partial retained stats/s);
    assert.deepEqual(
      [...diff.querySelectorAll(".diff-semantic")].slice(0, 5).map((node) => node.textContent),
      [],
      "diff lines carry no label column",
    );
    assert.equal(diff.querySelectorAll("pre.diff-line-text").length, 1_024);
    assert.equal(
      diff.querySelectorAll("code, [style]").length,
      0,
      "plain text has no highlighting",
    );
    assert.equal(diff.querySelectorAll(".diff-added .diff-line-text")[0].textContent, "+new");
    assert.equal(diff.querySelector(".diff-removed .diff-line-text").textContent, "-old");

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(diff.querySelector(".diff-added .diff-line-text"));
    selection.removeAllRanges();
    selection.addRange(range);
    assert.equal(selection.toString(), "+new", "diff text remains selectable for copying");
    assert.match(diff.textContent, /Additional source content omitted; total is unknown/);

    // The box disclosure is the single source of truth and survives a snapshot
    // replacement because the entry/call ids are stable.
    transport.emit({
      ...snapshotEnvelope(makeEntries(lines.join("\n") + "\n replacement")),
      type: "reset",
      revision: 1,
      reason: "edit replacement",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    box = root.querySelector(".tool-execution");
    diff = root.querySelector(".tool-diff");
    assert.equal(
      box.querySelector(".tool-disclosure-toggle").getAttribute("aria-expanded"),
      "true",
      "box disclosure survives replacement",
    );
    assert.equal(diff.querySelector(".diff-toggle"), null, "no inner diff disclosure toggle");
    assert.equal(diff.querySelectorAll(".diff-line").length, 1_024, "expanded DOM remains bounded");

    transport.emit({
      ...snapshotEnvelope(makeEntries(lines.join("\n"), undefined, true)),
      type: "reset",
      revision: 2,
      reason: "partial edit result",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(root.querySelector(".diff-stats"), null, "producer-partial stats are withheld");
    assert.ok(root.querySelector(".tool-diff"), "partial diff text remains available");

    transport.emit({
      ...snapshotEnvelope(makeEntries(lines.join("\n"))),
      type: "reset",
      revision: 3,
      reason: "final edit result",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(root.querySelector(".diff-stats")?.textContent ?? "", /\+1 \/ -1/s);

    transport.emit({
      ...snapshotEnvelope(makeEntries("", { diff: 42 })),
      type: "reset",
      revision: 4,
      reason: "malformed edit replacement",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    diff = root.querySelector(".tool-diff");
    assert.match(diff.textContent, /Applied fallback text/);
    assert.match(diff.textContent, /bounded plain-text fallback/);
    assert.equal(diff.querySelectorAll(".diff-fallback .diff-line-text").length, 1);
    assert.equal(root.querySelectorAll(".tool-diff script, .tool-diff a").length, 0);

    const failedEntries = makeEntries("", null);
    failedEntries[1].message.isError = true;
    failedEntries[1].message.content = [{ type: "text", text: "Edit could not find old text" }];
    transport.emit({
      ...snapshotEnvelope(failedEntries),
      type: "reset",
      revision: 5,
      reason: "failed edit result",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(root.querySelector(".tool-diff"), null);
    assert.match(root.querySelector(".error-output")?.textContent ?? "", /could not find old text/);
    assert.doesNotMatch(root.textContent, /missing or malformed details/);

    const surrogateEntries = makeEntries("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new");
    surrogateEntries[0].message.content[0].id = "surrogate-\ud800";
    surrogateEntries[1].message.toolCallId = "surrogate-\ud800";
    transport.emit({
      ...snapshotEnvelope(surrogateEntries),
      type: "reset",
      revision: 6,
      reason: "opaque surrogate tool id",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(root.querySelector(".tool-diff"));
    assert.equal(root.textContent.includes("[Unsupported transcript entry]"), false);
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("questionnaire fixture renders read-only semantics and keeps disclosure state across replacement", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, questionnaireFixtureEntries }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const root = document.querySelector("#app");
    const entries = questionnaireFixtureEntries();
    const transport = createMockIncrementalTransport(
      snapshotEnvelope(entries, { sessionName: "Questionnaire fixture" }),
    );
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const view = root.querySelector(".questionnaire-view");
    assert.ok(view);
    const box = view.closest(".tool-execution");
    assert.equal(box?.classList.contains("success"), true);
    assert.match(box.textContent, /2 questions \(Scope, Q2\)/);
    assert.equal(
      view.querySelector(".questionnaire-status")?.textContent,
      "2 of 2 questions answered.",
    );
    assert.equal(
      view.querySelector(".questionnaire-announcement")?.textContent,
      "",
      "historical terminal rows do not announce when mounted",
    );
    // Collapsed: the header and the status line only, like every other tool box.
    assert.equal(view.querySelector("dl.questionnaire-summary"), null);
    assert.doesNotMatch(view.textContent, /Which scope should be changed\?/);

    const disclosure = box.querySelector(".tool-disclosure-toggle");
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    disclosure.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.match(view.textContent, /Selected: All/);
    assert.match(view.textContent, /Custom answer: Ship it <b>literally<\/b>/);
    assert.equal(view.querySelector(".questionnaire-summary b"), null, "custom HTML stays text");
    assert.equal(view.querySelectorAll("input, textarea, select, form").length, 0);
    assert.equal(view.querySelector("dl.questionnaire-summary")?.tagName, "DL");
    assert.match(view.textContent, /Which scope should be changed?/);
    assert.match(view.textContent, /✓ Selected: All/);
    assert.equal(view.querySelectorAll(".questionnaire-options input").length, 0);

    transport.emit({
      ...snapshotEnvelope(structuredClone(entries), { sessionName: "Questionnaire fixture" }),
      type: "reset",
      revision: 1,
      reason: "fixture replacement",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      root
        .querySelector(".questionnaire-view")
        ?.closest(".tool-execution")
        ?.querySelector(".tool-disclosure-toggle")
        ?.getAttribute("aria-expanded"),
      "true",
      "row-independent disclosure survives replacement/remount and remains measurable",
    );
    assert.match(
      root.querySelector(".questionnaire-view")?.textContent ?? "",
      /Only the affected module/,
    );
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("questionnaire announces only a mounted running-to-terminal transition", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, questionnaireFixtureEntries }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const root = document.querySelector("#app");
    const completedEntries = questionnaireFixtureEntries();
    const transport = createMockIncrementalTransport(snapshotEnvelope([completedEntries[0]]));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(root.querySelector(".questionnaire-announcement")?.textContent, "");

    transport.emit({
      ...snapshotEnvelope(completedEntries),
      type: "reset",
      revision: 1,
      reason: "questionnaire completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      root.querySelector(".questionnaire-announcement")?.textContent,
      "2 of 2 questions answered.",
    );
    assert.equal(
      root.querySelector(".questionnaire-announcement")?.getAttribute("aria-live"),
      "polite",
    );
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("questionnaire keeps retained answers visible while partial or failed", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, questionnaireDecoderFixtures }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const fixture = questionnaireDecoderFixtures();
    const failed = structuredClone(fixture.custom.result);
    failed.isError = true;
    failed.content = [{ type: "text", text: "Explicit failure after an answer" }];
    const cases = [fixture.partial, { args: fixture.custom.args, result: failed }];
    const entries = cases.flatMap((item, index) => [
      {
        id: `retained-${index}-call-entry`,
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `retained-${index}-call`,
              name: "questionnaire",
              arguments: item.args,
            },
          ],
        },
      },
      {
        id: `retained-${index}-result-entry`,
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `retained-${index}-call`,
          toolName: "questionnaire",
          ...item.result,
        },
      },
    ]);
    const root = document.querySelector("#app");
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expandAllTools(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const views = root.querySelectorAll(".questionnaire-view");
    assert.equal(views.length, 2);
    assert.match(views[0].textContent, /Selected: All/);
    assert.match(views[1].textContent, /Custom answer: Ship it <b>literally<\/b>/);
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("questionnaire running, malformed, hostile, cancellation, and failures degrade visibly", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, questionnaireDecoderFixtures }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const fixture = questionnaireDecoderFixtures();
    const cases = [
      ["running", fixture.running],
      ["malformed", fixture.malformed],
      ["hostile", fixture.hostile],
      ["cancelled", fixture.cancelled],
      ["legacy", fixture.legacyErrorResult],
      ["is-error", fixture.isError],
      ["orphan", fixture.orphan],
      ["bounded", fixture.bounded],
      ["overlong-failed", fixture.overlongFailedWithOmissions],
    ];
    const entries = [];
    for (const [name, item] of cases) {
      entries.push({
        id: `${name}-call-entry`,
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: `${name}-call`, name: "questionnaire", arguments: item.args },
          ],
        },
      });
      if (item.result !== undefined)
        entries.push({
          id: `${name}-result-entry`,
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: `${name}-call`,
            toolName: "questionnaire",
            ...item.result,
          },
        });
    }
    const root = document.querySelector("#app");
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expandAllTools(root);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.match(root.textContent, /Response is awaited in the session terminal\./);
    assert.match(
      root.textContent,
      /Question details are unavailable or malformed|\[question unavailable\]/,
    );
    assert.match(root.textContent, /Questionnaire was cancelled\./);
    assert.match(root.textContent, /Error: Questionnaire requires interactive TUI mode/);
    assert.match(root.textContent, /Explicit failure/);
    assert.match(root.textContent, /Answers without a matching question/);
    assert.match(root.textContent, /1 question omitted/);
    assert.match(root.textContent, /1 answer omitted/);
    const overlongFailedView = root.querySelectorAll(".questionnaire-view")[8];
    assert.match(overlongFailedView.textContent, /1 question omitted/);
    assert.match(overlongFailedView.textContent, /1 answer omitted/);
    assert.match(overlongFailedView.textContent, /Questionnaire text was truncated for display/);
    const views = root.querySelectorAll(".questionnaire-view");
    assert.equal(views[0].closest(".tool-execution")?.classList.contains("pending"), true);
    assert.equal(views[3].closest(".tool-execution")?.classList.contains("error"), true);
    assert.equal(views[4].closest(".tool-execution")?.classList.contains("error"), true);
    assert.equal(views[5].closest(".tool-execution")?.classList.contains("error"), true);
    assert.equal(
      root.querySelectorAll("script, .questionnaire-view a, .questionnaire-view img").length,
      0,
    );
    assert.match(root.textContent, /<script>alert\(2\)<\/script>/);
    assert.equal(root.querySelectorAll(".questionnaire-view").length, cases.length);
    assert.equal(
      root.querySelectorAll(".questionnaire-view input, .questionnaire-view form").length,
      0,
    );
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("remote references and every omission render accessibly through the transport seam", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, imageFixtureEntries, FIXTURE_IMAGE_ID }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const root = document.querySelector("#app");
    const transport = createMockIncrementalTransport(snapshotEnvelope(imageFixtureEntries()), [], {
      imageUrl: () => "/mock/verified-image",
    });
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const rendered = [...root.querySelectorAll("img")];
    assert.equal(rendered.length, 2, "user and supported tool-result images render");
    for (const image of rendered) {
      assert.equal(image.getAttribute("src"), "/mock/verified-image");
      assert.equal(image.getAttribute("width"), "2");
      assert.equal(image.getAttribute("height"), "1");
      assert.equal(image.getAttribute("loading"), "lazy");
      assert.equal(image.getAttribute("decoding"), "async");
      assert.equal(image.getAttribute("alt"), "Attached image");
      assert.equal(image.hasAttribute("title"), false);
      const frame = image.closest(".image-frame");
      assert.match(frame?.getAttribute("style") ?? "", /width:\s*2px/);
      assert.match(frame?.getAttribute("style") ?? "", /height:\s*1px/);
    }
    assert.equal(root.textContent.includes(FIXTURE_IMAGE_ID), false);
    assert.equal(root.innerHTML.includes("data:image"), false);
    assert.equal(root.querySelectorAll(".image-omission").length, 8);
    for (const text of [
      "invalid image data",
      "unsupported image format",
      "file type does not match",
      "animated images",
      "image file is too large",
      "image dimensions are too large",
      "image pixel count is too large",
      "too many images",
    ])
      assert.match(root.textContent, new RegExp(text));

    rendered[0].dispatchEvent(new window.Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failure = root.querySelector('.image-error[role="status"]');
    assert.match(failure?.textContent ?? "", /failed to load or decode/);
    assert.equal(failure?.getAttribute("aria-live"), "polite");
    assert.equal(
      failure?.querySelector('[role="img"]')?.getAttribute("aria-label"),
      "Image failed to load",
    );
    const retry = failure?.querySelector("button");
    assert.equal(retry?.textContent, "Retry");
    assert.equal(retry?.closest('[role="img"]'), null, "Retry is outside the image semantic");
    retry.focus();
    assert.equal(document.activeElement, retry, "Retry is keyboard focusable");
    const failedFrame = failure?.closest('.image-frame[role="group"]');
    assert.match(failedFrame?.getAttribute("style") ?? "", /width:\s*240px/);
    assert.match(failedFrame?.getAttribute("style") ?? "", /height:\s*88px/);
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.querySelector("img")?.getAttribute("src"), "/mock/verified-image?retry=1");
    root.querySelector("img").dispatchEvent(new window.Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    root.querySelector(".image-error button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.querySelector("img")?.getAttribute("src"), "/mock/verified-image?retry=2");
    root.querySelector("img").dispatchEvent(new window.Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.querySelector(".image-error button"), null, "retry count is bounded");
    assert.equal(root.textContent.includes(FIXTURE_IMAGE_ID), false);
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("extreme image frames stay clamped and failure resets for a replacement reference", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const entry = {
      id: "extreme-image-entry",
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "image-reference",
            id: "wide".repeat(11),
            mimeType: "image/png",
            width: 8192,
            height: 1,
            byteLength: 1,
          },
        ],
      },
    };
    const initial = snapshotEnvelope([entry]);
    const transport = createMockIncrementalTransport(initial, [], {
      imageUrl: (id) => `/mock/${id}`,
    });
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));

    let frame = root.querySelector(".image-frame");
    assert.match(frame?.getAttribute("style") ?? "", /width:\s*500px/);
    assert.match(frame?.getAttribute("style") ?? "", /height:\s*1px/);
    root.querySelector("img").dispatchEvent(new window.Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(root.querySelector(".image-error"));

    const replacement = structuredClone(entry);
    replacement.message.content[0] = {
      ...replacement.message.content[0],
      id: "tall".repeat(11),
      width: 1,
      height: 8192,
    };
    transport.emit({
      ...snapshotEnvelope([replacement]),
      type: "reset",
      revision: 1,
      reason: "replacement image",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    frame = root.querySelector(".image-frame");
    assert.match(frame?.getAttribute("style") ?? "", /width:\s*1px/);
    assert.match(frame?.getAttribute("style") ?? "", /height:\s*500px/);
    assert.equal(root.querySelector(".image-error"), null);
    assert.match(root.querySelector("img")?.getAttribute("src") ?? "", /talltall/);
    assert.equal(root.textContent.includes(replacement.message.content[0].id), false);
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("image DOM stays bounded with one visible overflow placeholder", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const content = Array.from({ length: 40 }, (_, index) => ({
      type: "image-reference",
      id: String(index).padStart(46, "a"),
      mimeType: "image/png",
      width: 2,
      height: 2,
      byteLength: 1,
    }));
    const transport = createMockIncrementalTransport(
      snapshotEnvelope([
        {
          id: "bounded-images",
          type: "message",
          message: { role: "user", content },
        },
      ]),
      [],
      { imageUrl: () => "/mock/bounded" },
    );
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(root.querySelectorAll("img").length, 8);
    assert.equal(root.querySelectorAll(".image-omission").length, 1);
    assert.match(root.textContent, /too many images/);
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("duplicate image references keep occurrence-specific state across updates", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const duplicate = {
      type: "image-reference",
      id: "duplicate".repeat(6),
      mimeType: "image/png",
      width: 2,
      height: 2,
      byteLength: 1,
    };
    const entry = {
      id: "duplicate-image-entry",
      type: "message",
      message: { role: "user", content: [duplicate, duplicate] },
    };
    const transport = createMockIncrementalTransport(snapshotEnvelope([entry]), [], {
      imageUrl: () => "/mock/duplicate",
    });
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const rendered = root.querySelectorAll("img");
    assert.equal(rendered.length, 2);
    rendered[0].dispatchEvent(new window.Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.querySelectorAll(".image-error").length, 1);
    assert.equal(root.querySelectorAll("img").length, 1);

    const replacement = structuredClone(entry);
    replacement.message.content.push({ type: "text", text: "updated" });
    transport.emit({
      ...snapshotEnvelope([replacement]),
      type: "reset",
      revision: 1,
      reason: "duplicate update",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(root.querySelectorAll(".image-error").length, 1);
    assert.equal(root.querySelectorAll("img").length, 1);
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("generic tool arguments redact image resource identifiers", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const secretId = "secret-image-reference".repeat(2);
    const transport = createMockIncrementalTransport(
      snapshotEnvelope([
        {
          id: "generic-image-argument",
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "generic-image-call",
                name: "custom_tool",
                arguments: {
                  resource: {
                    type: "image-reference",
                    id: secretId,
                    mimeType: "image/png",
                    width: 1,
                    height: 1,
                    byteLength: 1,
                  },
                  legacy: { type: "image", data: "secret-base64" },
                  malformed: {
                    type: "image-reference",
                    id: "malformed-secret-id",
                    source: "file:///tmp/secret.png",
                    width: 8192,
                    height: 8192,
                  },
                },
              },
            ],
          },
        },
      ]),
    );
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Arguments of an unrecognised tool live behind the box like every other body.
    assert.doesNotMatch(root.textContent, /\[image\]/);
    expandAllTools(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(root.textContent, /\[image\]/);
    assert.doesNotMatch(
      root.textContent,
      /secret-image-reference|secret-base64|malformed-secret-id|file:\/\/\/tmp\/secret/,
    );
    transport.close();
  } finally {
    dom.window.close();
  }
});

test("tool-result entries fold into their call without adding a zero-height row", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const entries = [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "First question" }] },
      },
      {
        id: "a1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running a command" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } },
          ],
        },
      },
      {
        id: "r1",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "hi from the tool" }],
          isError: false,
        },
      },
      {
        id: "u2",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Second question" }] },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The toolResult entry renders no row of its own; only the two user messages and
    // the assistant message are mounted, with contiguous indices (no phantom gap).
    const mounted = [...root.querySelectorAll(".message-row")];
    assert.equal(mounted.length, 3, `expected three rows, saw ${mounted.length}`);
    const indices = mounted.map((row) => Number(row.getAttribute("data-index")));
    assert.deepEqual(indices, [0, 1, 2]);
    assert.equal(root.querySelectorAll(".tool-execution").length, 1);
    // The folded result is still indexed for its call: the bash tool renders its
    // one-line result summary rather than leaving the call without an outcome.
    assert.match(root.textContent, /output line/);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("special-renderer tool calls expand per call by clicking the box", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const longCommand =
      "run --long --flag first-part\nsecond-part-with-more-text\nthird part that keeps going and going until it exceeds the compact display limit for sure";
    const entries = [
      {
        id: "t-user",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Do the work" }] },
      },
      {
        id: "t-calls",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "t-bash",
              name: "bash",
              arguments: { command: longCommand, timeout: 30 },
            },
            {
              type: "toolCall",
              id: "t-read",
              name: "read",
              arguments: { path: "/tmp/read-me.txt" },
            },
            {
              type: "toolCall",
              id: "t-write",
              name: "write",
              arguments: { path: "/tmp/write-me.txt", content: "alpha\nbeta\ngamma" },
            },
            {
              type: "toolCall",
              id: "t-edit",
              name: "edit",
              arguments: {
                path: "/tmp/edit-me.txt",
                edits: [{ oldText: "old", newText: "new" }],
              },
            },
          ],
        },
      },
      {
        id: "t-bash-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t-bash",
          toolName: "bash",
          content: [{ type: "text", text: "bash output line 1\nbash output line 2" }],
          isError: false,
        },
      },
      {
        id: "t-read-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t-read",
          toolName: "read",
          content: [{ type: "text", text: "read line 0\nread line 1\nread line 2" }],
          isError: false,
        },
      },
      {
        id: "t-write-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t-write",
          toolName: "write",
          content: [{ type: "text", text: "wrote file" }],
          isError: false,
        },
      },
      {
        id: "t-edit-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t-edit",
          toolName: "edit",
          content: [{ type: "text", text: "applied" }],
          details: { diff: "--- a/tmp/edit-me.txt\n+++ b/tmp/edit-me.txt\n-old\n+new\n context" },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const boxes = [...root.querySelectorAll(".tool-execution")];
    assert.equal(boxes.length, 4);
    const toggleOf = (box) => box.querySelector(".tool-disclosure-toggle");

    // Collapsed by default: headers and summaries only, bash command compacted.
    assert.equal(root.querySelectorAll(".tool-output").length, 0);
    assert.equal(boxes[0].getAttribute("role"), null, "the box is a plain container, not a button");
    assert.equal(toggleOf(boxes[0]).getAttribute("aria-expanded"), "false");
    assert.match(boxes[0].textContent, /2 output lines/);
    assert.match(boxes[0].textContent, /\.\.\./);
    assert.doesNotMatch(boxes[0].textContent, /until it exceeds the compact display limit/);

    // Clicking the bash box shows the full command (no ellipsis) and the output.
    boxes[0].click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(boxes[0]).getAttribute("aria-expanded"), "true");
    assert.match(boxes[0].textContent, /until it exceeds the compact display limit for sure/);
    assert.doesNotMatch(boxes[0].textContent, /\.\.\./);
    assert.match(boxes[0].textContent, /bash output line 1/);
    assert.doesNotMatch(boxes[0].textContent, /2 output lines/);

    // The other calls stay collapsed; each expands independently.
    assert.equal(toggleOf(boxes[1]).getAttribute("aria-expanded"), "false");
    assert.equal(toggleOf(boxes[2]).getAttribute("aria-expanded"), "false");
    assert.equal(toggleOf(boxes[3]).getAttribute("aria-expanded"), "false");
    boxes[1].click();
    boxes[2].click();
    boxes[3].click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(root.textContent, /read line 2/);
    assert.match(root.textContent, /alpha/);
    assert.ok(root.querySelector(".tool-diff"));
    assert.equal(toggleOf(boxes[1]).getAttribute("aria-expanded"), "true");
    assert.equal(toggleOf(boxes[2]).getAttribute("aria-expanded"), "true");
    assert.equal(toggleOf(boxes[3]).getAttribute("aria-expanded"), "true");

    // Collapsing one call leaves the per-call state of the others intact.
    boxes[0].click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(boxes[0]).getAttribute("aria-expanded"), "false");
    assert.match(boxes[0].textContent, /2 output lines/);
    assert.doesNotMatch(boxes[0].textContent, /bash output line 1/);
    assert.match(root.textContent, /read line 2/);
    assert.match(root.textContent, /alpha/);
    assert.ok(root.querySelector(".tool-diff"));

    // The header disclosure button toggles the call with a stable accessible
    // label (native Enter/Space activation is covered in the e2e suite). Like
    // the TUI and exporter it carries no visible glyph.
    assert.equal(toggleOf(boxes[0]).textContent, "");
    assert.equal(toggleOf(boxes[0]).getAttribute("aria-label"), "Expand bash tool call");
    toggleOf(boxes[0]).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(boxes[0]).getAttribute("aria-expanded"), "true");
    assert.equal(toggleOf(boxes[0]).getAttribute("aria-label"), "Collapse bash tool call");
    assert.match(boxes[0].textContent, /bash output line 1/);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("agentflow and background tool calls expand per call by clicking the box", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const entries = [
      {
        id: "ab-user",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Run a review and a job" }] },
      },
      {
        id: "ab-calls",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-af",
              name: "agentflow_review",
              arguments: { task: "Review the screenshots" },
            },
            {
              type: "toolCall",
              id: "tc-bg",
              name: "background_run",
              arguments: { command: "npm test", description: "run tests" },
            },
          ],
        },
      },
      {
        id: "ab-af-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-af",
          toolName: "agentflow_review",
          content: [{ type: "text", text: "- Fully captured screenshot" }],
          details: {
            snapshot: {
              runId: "run-1",
              status: "completed",
              semanticRole: "review",
              nodes: [
                {
                  status: "completed",
                  backend: "claude",
                  model: "opus",
                  tools: 3,
                  usage: { total: 12_345, cost: 0.0421 },
                  resultPreview: JSON.stringify({ findings: [{ a: 1 }, { b: 2 }] }),
                  toolCalls: [
                    { id: "n1", name: "read", status: "completed", argumentSummary: "file.ts" },
                  ],
                },
              ],
            },
          },
          isError: false,
        },
      },
      {
        id: "ab-bg-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-bg",
          toolName: "background_run",
          content: [{ type: "text", text: "started" }],
          details: {
            jobs: [
              {
                jobId: "job-1",
                command: "npm test",
                description: "run tests",
                status: "running",
                durationMs: 1500,
                outputBytes: 4096,
                tail: "PASS suite\nPASS other",
              },
            ],
          },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const boxes = [...root.querySelectorAll(".tool-execution")];
    assert.equal(boxes.length, 2);
    const toggleOf = (box) => box.querySelector(".tool-disclosure-toggle");
    const afBox = boxes[0];
    const bgBox = boxes[1];

    // Collapsed by default: the launched run keeps showing the child's tool
    // calls (like the TUI) with a compact status line, while the run metadata
    // and output stay behind the box. The background job list stays hidden.
    for (const box of boxes) assert.match(box.className, /expandable/);
    assert.equal(toggleOf(afBox).getAttribute("aria-expanded"), "false");
    assert.equal(toggleOf(bgBox).getAttribute("aria-expanded"), "false");
    assert.ok(afBox.querySelector(".agentflow-live-run"));
    assert.match(afBox.querySelector(".agentflow-tool-row").textContent, /read.*file\.ts/s);
    assert.equal(afBox.querySelector(".tool-facts"), null);
    assert.equal(root.querySelectorAll(".background-job").length, 0);
    assert.match(afBox.textContent, /review · Review the screenshots/);
    assert.match(bgBox.textContent, /background_run · npm test · run tests/);
    assert.match(
      afBox.textContent,
      /✓ completed · claude\/opus · 2 findings · 3 tools · 12\.3k tokens · \$0\.0421 · click to expand/,
    );
    assert.match(bgBox.textContent, /◆ running · 1 job · click to expand/);

    // Clicking anywhere on the agentflow box expands it: run metadata first,
    // then the tool calls, then the status line with the collapse hint.
    afBox.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(afBox).getAttribute("aria-expanded"), "true");
    assert.equal(toggleOf(afBox).getAttribute("aria-label"), "Collapse agentflow_review tool call");
    const summary = afBox.querySelector(".tool-run-summary");
    assert.ok(summary);
    assert.match(summary.textContent, /completed.*claude\/opus.*click to collapse/s);
    assert.match(afBox.textContent, /Run.*run-1/s);
    const runBody = afBox.querySelector(".agentflow-live-run").textContent;
    assert.ok(
      runBody.indexOf("run-1") < runBody.indexOf("file.ts"),
      "run metadata precedes the tool calls",
    );
    assert.ok(
      runBody.indexOf("file.ts") < runBody.indexOf("click to collapse"),
      "the status line closes the run",
    );

    // Clicking plain text in the expanded box collapses it again.
    afBox.querySelector(".tool-header").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(afBox).getAttribute("aria-expanded"), "false");
    assert.equal(afBox.querySelector(".tool-facts"), null);

    // The background box expands by clicking anywhere and opens the job list.
    bgBox.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(bgBox).getAttribute("aria-expanded"), "true");
    const job = bgBox.querySelector(".background-job");
    assert.ok(job);
    // The launching tool's header owns the command, so its job card leads with the
    // job id and does not repeat it.
    assert.match(bgBox.querySelector(".tool-header").textContent, /npm test/);
    assert.doesNotMatch(job.textContent, /npm test/);
    assert.match(job.textContent, /job-1/);
    assert.match(job.textContent, /PASS suite/);
    bgBox.querySelector(".tool-details-body").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(bgBox).getAttribute("aria-expanded"), "false");
    assert.equal(bgBox.querySelector(".background-job"), null);

    // The header disclosure button is the keyboard-accessible control and flips
    // the box state like the other tools'.
    toggleOf(afBox).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(afBox).getAttribute("aria-expanded"), "true");
    assert.ok(afBox.querySelector(".tool-facts"));
    toggleOf(afBox).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(afBox).getAttribute("aria-expanded"), "false");

    // The global tool-output preference drives the box default: toggling the
    // hotkey clears the per-call overrides and expands every box.
    expandAllTools(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(afBox).getAttribute("aria-expanded"), "true");
    assert.equal(toggleOf(bgBox).getAttribute("aria-expanded"), "true");
    assert.ok(afBox.querySelector(".tool-facts"));
    assert.ok(bgBox.querySelector(".background-job"));
    expandAllTools(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(afBox).getAttribute("aria-expanded"), "false");
    assert.equal(toggleOf(bgBox).getAttribute("aria-expanded"), "false");
    assert.equal(afBox.querySelector(".tool-facts"), null);
    assert.equal(bgBox.querySelector(".background-job"), null);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("agentflow workflows group their nodes by phase in both collapsed and expanded views", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const workflowSnapshot = {
      runId: "run-wf",
      kind: "workflow",
      status: "running",
      createdAt: "2026-08-03T09:00:00.000Z",
      phases: ["survey", "verify"],
      nodes: [
        {
          id: "s1",
          label: "survey",
          phase: "survey",
          status: "completed",
          prompt: "list every wire schema",
          tools: 2,
          usage: { total: 900, cost: 0.0021 },
          toolCalls: [{ id: "t0", name: "grep", status: "completed", argumentSummary: "schema" }],
          startedAt: "2026-08-03T09:00:00.000Z",
          completedAt: "2026-08-03T09:00:04.000Z",
        },
        {
          id: "v1",
          label: "verify",
          phase: "verify",
          status: "running",
          prompt: "compare the renderers",
          tools: 1,
          usage: { total: 300, cost: 0, costKnown: false },
          toolCalls: [{ id: "t1", name: "bash", status: "running", argumentSummary: "typecheck" }],
          startedAt: "2026-08-03T09:00:04.000Z",
        },
        {
          id: "x1",
          label: "loose",
          phase: "cleanup",
          status: "queued",
          prompt: "tidy up",
          tools: 0,
          usage: { total: 0, cost: 0 },
        },
      ],
    };
    const entries = [
      {
        id: "wf-call",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-wf",
              name: "agentflow_workflow",
              arguments: {
                script: 'export const meta = { name: "audit", description: "audit the surface" }',
              },
            },
          ],
        },
      },
      {
        id: "wf-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-wf",
          toolName: "agentflow_workflow",
          content: [{ type: "text", text: "" }],
          details: {
            snapshot: workflowSnapshot,
            observedAt: Date.parse("2026-08-03T09:00:10.000Z"),
          },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const box = root.querySelector(".tool-execution");
    assert.ok(box);

    // Collapsed: declared phases become headings, ungrouped nodes trail with no heading, and
    // each phase carries its derived status and (for a started phase) an elapsed time.
    const phases = () => [...box.querySelectorAll(".agentflow-phase")];
    assert.deepEqual(
      phases().map((phase) => phase.querySelector(".agentflow-run-status").textContent.trim()),
      ["✓ survey", "◆ verify"],
    );
    assert.match(phases()[0].textContent, /survey · 4\.0s/);
    assert.doesNotMatch(phases()[0].textContent, /completed/);
    assert.match(phases()[1].textContent, /verify · 6\.0s/);
    assert.doesNotMatch(phases()[1].textContent, /running/);
    // The ungrouped node stays visible after the declared phases.
    assert.match(box.textContent, /loose/);
    // No expanded node detail or status line while collapsed; node metadata stays inline.
    assert.equal(box.querySelector(".agentflow-node"), null);
    assert.match(box.querySelector(".agentflow-node-compact").textContent, /survey· 2 tools/);

    // Expanded: each node reads like a collapsed subagent — its prompt, its recent tool calls,
    // and a closing status line with the established unknown-cost wording.
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const nodes = [...box.querySelectorAll(".agentflow-node")];
    assert.equal(nodes.length, 3);
    const surveyNode = nodes[0];
    assert.match(
      surveyNode.querySelector(".agentflow-node-heading").textContent,
      /^survey· list every wire schema$/,
    );
    assert.match(surveyNode.querySelector(".agentflow-tool-list").textContent, /grep/);
    assert.match(
      surveyNode.querySelector(".agentflow-node-status").textContent,
      /✓ completed · 4\.0s · 2 tools · 900 tokens · \$0\.0021/,
    );
    // The running node's cost is unknown, so it says so rather than reporting $0.
    assert.match(nodes[1].querySelector(".agentflow-node-status").textContent, /cost unavailable/);
    // Phase headings are still present when expanded.
    assert.deepEqual(
      phases().map((phase) => phase.querySelector(".agentflow-run-status").textContent.trim()),
      ["✓ survey", "◆ verify"],
    );

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("background agentflow runs state their mode instead of a stale usage summary", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const entries = [
      {
        id: "bg-user",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Review in the background" }] },
      },
      {
        id: "bg-call",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-af-bg",
              name: "agentflow_review",
              arguments: { task: "Review the diff", base: "HEAD", mode: "background" },
            },
          ],
        },
      },
      {
        id: "bg-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-af-bg",
          toolName: "agentflow_review",
          content: [{ type: "text", text: "- findings" }],
          details: {
            snapshot: {
              runId: "run-bg",
              status: "running",
              semanticRole: "review",
              background: true,
              nodes: [
                {
                  status: "running",
                  backend: "claude",
                  model: "opus",
                  tools: 2,
                  usage: { total: 42, cost: 0.0123 },
                  toolCalls: [],
                },
              ],
            },
          },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const box = root.querySelector(".tool-execution");
    // Collapsed: the header names the prompt and the background mode; the stale
    // tools/tokens/cost summary is not rendered anywhere, and the collapsed
    // status line states the mode instead.
    assert.match(box.textContent, /review · background · Review the diff/);
    assert.doesNotMatch(box.textContent, /tools ·/);
    assert.match(box.textContent, /◆ running in the background · claude\/opus · click to expand/);

    // Expanded: the status line states the mode instead of the usage summary.
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const summary = box.querySelector(".tool-run-summary");
    assert.ok(summary);
    assert.match(
      summary.textContent,
      /◆ running in the background · claude\/opus · click to collapse/,
    );
    assert.doesNotMatch(summary.textContent, /tools/);
    assert.doesNotMatch(summary.textContent, /tokens/);
    assert.doesNotMatch(summary.textContent, /\$/);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("a delivered background agent result renders as its own run box", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const entries = [
      {
        id: "af-msg",
        type: "custom_message",
        customType: "agentflow-result",
        display: true,
        content: "librarian completed",
        details: {
          snapshot: {
            runId: "af_bg_1",
            status: "completed",
            semanticRole: "librarian",
            nodes: [
              {
                status: "completed",
                prompt: "What is the state of the Rust async runtime ecosystem?",
                cwd: "/Users/tester/.pi",
                tools: 40,
                usage: { total: 5300, cost: 0.0009 },
                resultPreview: JSON.stringify({ sources: [{ url: "https://example.invalid" }] }),
                toolCalls: Array.from({ length: 10 }, (_, index) => ({
                  id: `c${index + 1}`,
                  name: "web_search",
                  status: "completed",
                  argumentSummary: index === 9 ? "tokio releases" : `earlier-${index}`,
                })),
              },
            ],
          },
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const box = root.querySelector(".tool-execution");
    assert.ok(box, "the delivered result gets a run box instead of a bare hook message");
    assert.match(box.className, /success/);
    // Collapsed: role, prompt, the child's tool calls and the status line.
    assert.match(
      box.textContent,
      /librarian · result · What is the state of the Rust async runtime/,
    );
    assert.match(box.textContent, /… 32 earlier tool calls/);
    assert.match(box.textContent, /web_search/);
    assert.match(box.textContent, /tokio releases/);
    assert.match(box.textContent, /✓ completed · 1 source · 40 tools · 5\.3k tokens · \$0\.0009/);
    assert.equal(box.querySelector(".tool-facts"), null);

    // Expanded: run metadata and the result preview join it.
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(box.textContent, /af_bg_1/);
    assert.match(box.textContent, /~\/\.pi/);
    assert.match(box.textContent, /example\.invalid/);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("agentflow semantic output renders bounded hierarchy, Markdown, and literal plain text", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const result = {
      summary: "# Delegate summary\n\nImplemented **one** change.",
      filesChanged: ["src/session.ts"],
      verification: [
        {
          command: "nub run test",
          status: "passed",
          output: "first line\n  indented second line\twith tab",
        },
      ],
      followUps: Array.from({ length: 20 }, (_, index) =>
        index === 19
          ? "Follow-up [docs](https://example.test/hidden)"
          : `Follow-up **${index + 1}**`,
      ),
    };
    const entries = [
      {
        id: "semantic-call",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-semantic",
              name: "agentflow_delegate",
              arguments: {
                task: "Implement the session update",
                ownership: ["src/session.ts"],
                acceptanceCriteria: ["Tests pass"],
                verificationCommands: ["nub run test"],
              },
            },
          ],
        },
      },
      {
        id: "semantic-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-semantic",
          toolName: "agentflow_delegate",
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: {
            result,
            snapshot: {
              runId: "run-delegate",
              kind: "agent",
              semanticRole: "delegate",
              status: "completed",
              createdAt: "2026-08-03T09:00:00.000Z",
              completedAt: "2026-08-03T09:00:01.000Z",
              phases: [],
              resultPreview: '{"summary":"truncated",',
              nodes: [
                {
                  status: "completed",
                  prompt: "Implement the session update",
                  cwd: "/work/project",
                  tools: 0,
                  usage: { total: 100, cost: 0.001 },
                  resultPreview: '{"summary":"truncated",',
                  toolCalls: [],
                },
              ],
              logs: [],
            },
          },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const box = root.querySelector(".tool-execution");
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const structured = box.querySelector(".agentflow-structured-output");
    assert.ok(structured);
    assert.deepEqual(
      [...structured.querySelectorAll(".agentflow-structured-section-title")].map(
        (element) => element.textContent,
      ),
      ["Summary", "Files changed", "Verification", "Follow-ups"],
    );
    assert.equal(
      structured.querySelector(".agentflow-structured-item-title").textContent,
      "Check 1",
    );
    assert.deepEqual(
      [...structured.querySelectorAll(".agentflow-structured-field-label")].map(
        (element) => element.textContent,
      ),
      ["Command", "Status", "Output"],
    );
    const markdown = structured.querySelector(".agentflow-structured-value .markdown-content");
    assert.ok(markdown);
    assert.ok(
      markdown.closest(".agentflow-structured-section-body"),
      "a Markdown value remains nested below its schema property even when its source starts at H1",
    );
    assert.match(structured.textContent, /src\/session\.ts/);
    const plainOutput = [...structured.querySelectorAll(".agentflow-structured-plain")].find(
      (element) => element.textContent.includes("indented second line"),
    );
    assert.ok(plainOutput);
    assert.equal(plainOutput.textContent, "first line\n  indented second line   with tab");
    assert.ok(structured.classList.contains("bounded"));
    assert.equal(structured.getAttribute("aria-hidden"), "true");
    assert.ok(structured.hasAttribute("inert"));
    const nestedToggle = box.querySelector(".agentflow-structured-toggle");
    assert.equal(nestedToggle.getAttribute("aria-expanded"), "false");
    assert.equal(nestedToggle.getAttribute("aria-controls"), structured.id);
    nestedToggle.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(nestedToggle.getAttribute("aria-expanded"), "true");
    assert.ok(!structured.classList.contains("bounded"));
    assert.equal(structured.getAttribute("aria-hidden"), null);
    assert.ok(!structured.hasAttribute("inert"));

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("agentflow control-tool results gate behind the box", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const entries = [
      {
        id: "nl-user",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Check the run" }] },
      },
      {
        id: "nl-call",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-nl",
              name: "agentflow_status",
              arguments: { runId: "run-42" },
            },
          ],
        },
      },
      {
        id: "nl-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-nl",
          toolName: "agentflow_status",
          content: [{ type: "text", text: "run details" }],
          details: {
            snapshot: {
              runId: "run-42",
              kind: "agent",
              semanticRole: "finder",
              status: "completed",
              createdAt: "2026-08-03T09:00:00.000Z",
              completedAt: "2026-08-03T09:00:12.000Z",
              phases: ["explore", "report"],
              nodes: [
                {
                  status: "completed",
                  prompt: "Inspect the authentication boundary",
                  cwd: "/work/project",
                  tools: 1,
                  usage: { total: 2048, cost: 0.002 },
                  resultPreview: JSON.stringify({ findings: [{ title: "missing check" }] }),
                  toolCalls: [
                    { id: "s1", name: "read", status: "completed", argumentSummary: "auth.ts" },
                  ],
                },
              ],
              logs: [],
            },
          },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const box = root.querySelector(".tool-execution");
    const toggleOf = (box) => box.querySelector(".tool-disclosure-toggle");
    // A control tool stays compact while collapsed.
    assert.equal(toggleOf(box).getAttribute("aria-expanded"), "false");
    assert.equal(box.querySelector(".tool-details-toggle"), null);
    assert.match(box.textContent, /agentflow_status · run-42/);
    const stateRow = box.querySelector(".agentflow-tool-row");
    assert.match(stateRow.textContent, /run-42/);
    assert.match(stateRow.textContent, /finder · completed · 12\.0s · 1 finding/);
    assert.equal(box.querySelector(".agentflow-live-run"), null);
    assert.doesNotMatch(box.textContent, /Inspect the authentication boundary/);
    assert.doesNotMatch(box.textContent, /auth\.ts/);

    // Expanded controls carry the TUI's full observed run depth without raw JSON.
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(box).getAttribute("aria-expanded"), "true");
    assert.equal(box.querySelector(".tool-details-toggle"), null);
    assert.ok(box.querySelector(".agentflow-live-run"));
    assert.match(box.textContent, /Runrun-42/);
    assert.match(box.textContent, /explore → report/);
    assert.match(box.textContent, /Inspect the authentication boundary/);
    assert.match(box.textContent, /auth\.ts/);
    assert.match(box.textContent, /2\.0k tokens/);
    assert.doesNotMatch(box.textContent, /"runId"/, "no raw result payload");

    // Plain text clicks still collapse the whole box.
    box.querySelector(".tool-header").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(box).getAttribute("aria-expanded"), "false");
    assert.equal(box.querySelector(".agentflow-live-run"), null);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("agentflow box disclosure survives a partial result arriving after expansion", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const call = {
      id: "pr-call",
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-pr",
            name: "agentflow_review",
            arguments: { task: "Review the diff", mode: "background" },
          },
        ],
      },
    };
    const partialResult = {
      id: "pr-result",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-pr",
        toolName: "agentflow_review",
        content: [{ type: "text", text: "- partial findings" }],
        details: {
          snapshot: {
            runId: "run-pr",
            status: "running",
            semanticRole: "review",
            background: true,
            nodes: [
              {
                status: "running",
                backend: "claude",
                model: "opus",
                tools: 1,
                usage: { total: 42, cost: 0.01 },
                toolCalls: [],
              },
            ],
          },
        },
        isError: false,
        isPartial: true,
      },
    };
    const transport = createMockIncrementalTransport(snapshotEnvelope([call]));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const box = root.querySelector(".tool-execution");
    const toggleOf = (box) => box.querySelector(".tool-disclosure-toggle");
    // Pending call: header only, but the box still expands and collapses.
    assert.equal(toggleOf(box).getAttribute("aria-expanded"), "false");
    assert.equal(box.querySelector(".tool-run-summary"), null);
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(box).getAttribute("aria-expanded"), "true");
    assert.equal(box.querySelector(".tool-run-summary"), null);

    // A partial result arrives while the box is expanded: the disclosure
    // survives the replacement and the result body appears already open.
    transport.emit({
      ...snapshotEnvelope([call, partialResult]),
      type: "reset",
      revision: 1,
      reason: "partial agentflow result",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(toggleOf(box).getAttribute("aria-expanded"), "true");
    const summary = box.querySelector(".tool-run-summary");
    assert.ok(summary);
    assert.match(summary.textContent, /◆ running in the background · claude\/opus/);
    assert.doesNotMatch(summary.textContent, /tools/);
    assert.doesNotMatch(summary.textContent, /\$/);
    assert.ok(box.querySelector(".tool-facts"));

    // The box still collapses afterwards.
    box.querySelector(".tool-header").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(box).getAttribute("aria-expanded"), "false");
    assert.equal(box.querySelector(".tool-facts"), null);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("box expansion ignores nested controls and live text selections", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const diffLines = Array.from({ length: 15 }, (_, i) =>
      i % 2 ? `+added ${i}` : `-removed ${i}`,
    );
    const entries = [
      {
        id: "n-user",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Read and edit" }] },
      },
      {
        id: "n-calls",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "n-read",
              name: "read",
              arguments: { path: "/tmp/long.txt" },
            },
            {
              type: "toolCall",
              id: "n-edit",
              name: "edit",
              arguments: {
                path: "/tmp/edit.txt",
                edits: [{ oldText: "old", newText: "new" }],
              },
            },
          ],
        },
      },
      {
        id: "n-read-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "n-read",
          toolName: "read",
          content: [
            {
              type: "text",
              text: Array.from({ length: 30 }, (_, i) => `read line ${i}`).join("\n"),
            },
          ],
          isError: false,
        },
      },
      {
        id: "n-edit-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "n-edit",
          toolName: "edit",
          content: [{ type: "text", text: "applied" }],
          details: { diff: `--- a/tmp/edit.txt\n+++ b/tmp/edit.txt\n${diffLines.join("\n")}` },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const readBox = root.querySelector(".tool-execution");
    const editBox = root.querySelectorAll(".tool-execution")[1];
    const toggleOf = (box) => box.querySelector(".tool-disclosure-toggle");

    // Expanding the read box shows the full output at once: exactly two
    // states, no inner excerpt with a hint.
    readBox.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(readBox).getAttribute("aria-expanded"), "true");
    assert.equal(readBox.querySelectorAll(".tool-output.expandable").length, 0);
    assert.match(readBox.textContent, /read line 0/);
    assert.match(readBox.textContent, /read line 29/);
    assert.doesNotMatch(readBox.textContent, /more lines/);

    // Clicking anywhere in the expanded box collapses it again.
    readBox.querySelector(".tool-output").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(readBox).getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(readBox.textContent, /read line 0/);

    // A live text selection blocks the box toggle even on a plain-text click.
    const originalGetSelection = window.getSelection.bind(window);
    window.getSelection = () => ({ toString: () => "selected text" });
    try {
      readBox.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(toggleOf(readBox).getAttribute("aria-expanded"), "false");
    } finally {
      window.getSelection = originalGetSelection;
    }
    // With no selection, the same click expands the box again.
    readBox.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(readBox).getAttribute("aria-expanded"), "true");
    assert.match(readBox.textContent, /read line 29/);

    // Expanding the edit box renders the full retained diff at once — two states
    // only, with no inner disclosure toggle.
    editBox.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(editBox).getAttribute("aria-expanded"), "true");
    assert.equal(editBox.querySelector(".diff-toggle"), null, "no inner diff disclosure toggle");
    // 2 file headers + 15 body lines, all retained.
    assert.equal(editBox.querySelectorAll(".diff-line").length, 17);
    assert.doesNotMatch(editBox.textContent, /more retained lines/);

    // Clicking the diff body collapses the whole box.
    editBox.querySelector(".diff-lines").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggleOf(editBox).getAttribute("aria-expanded"), "false");

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("read error output stays visible while the box is collapsed", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const entries = [
      {
        id: "err-user",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Read it" }] },
      },
      {
        id: "err-call",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "err-read", name: "read", arguments: { path: "/tmp/x" } },
          ],
        },
      },
      {
        id: "err-result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "err-read",
          toolName: "read",
          content: [{ type: "text", text: "read failed: no such file" }],
          isError: true,
        },
      },
    ];
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const box = root.querySelector(".tool-execution");
    const toggle = box.querySelector(".tool-disclosure-toggle");
    // Error output stays readable even though the box reports collapsed.
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.match(box.textContent, /read failed: no such file/);
    // The disclosure button still flips state normally.
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.match(box.textContent, /read failed: no such file/);

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("transcript virtualization bounds mounted rows for large sessions", async () => {
  const dom = installDom({ innerHeight: 800 });
  try {
    const [{ mount }, { generateLargeSession, createMockIncrementalTransport }] = await Promise.all(
      [import("../src/client/index.tsx"), import("../src/testing/index.ts")],
    );
    const root = document.querySelector("#app");
    const large = generateLargeSession(5000);
    const initialEntries = large.entries.slice(0, 200);
    const transport = createMockIncrementalTransport(
      snapshotEnvelope(initialEntries, { sessionName: "Large fixture", metadata: undefined }),
    );
    mount(root, transport);
    let revision = 0;
    let afterId = initialEntries.at(-1).id;
    for (let offset = initialEntries.length; offset < large.entries.length; offset += 1000) {
      const entries = large.entries.slice(offset, offset + 1000);
      transport.emit({
        version: 1,
        type: "operations",
        generation: "render-fixture",
        fromRevision: revision,
        revision: ++revision,
        operations: [
          {
            kind: "append",
            afterId,
            entries: entries.map((entry) => ({ id: entry.id, payload: entry })),
          },
        ],
      });
      afterId = entries.at(-1).id;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const viewport = root.querySelector(".messages-viewport");
    assert.ok(viewport, "virtualized viewport is present");
    assert.match(viewport.getAttribute("style") ?? "", /height:\s*\d+px/);

    const mounted = root.querySelectorAll(".message-row");
    assert.equal(mounted.length > 0, true, "some rows mount");
    assert.equal(mounted.length < 200, true, `mounted rows stay bounded (was ${mounted.length})`);

    // Stable, position-independent keys: mounted rows carry contiguous indices that
    // start at the top of the 5,000-entry session rather than the middle.
    const indices = [...mounted].map((row) => Number(row.getAttribute("data-index")));
    assert.equal(indices[0], 0);
    for (let i = 1; i < indices.length; i += 1) assert.equal(indices[i], indices[i - 1] + 1);

    transport.close();
  } finally {
    dom.window.close();
  }
});

// One call per registered tool, exercising both expansion states. This is the guard
// that every tool has a renderer at all: the table is asserted to cover exactly the
// registry, so adding a tool without a fixture fails here rather than silently
// falling through to the generic view.
const AGENT_RUN = {
  runId: "af_9",
  kind: "agent",
  status: "completed",
  createdAt: "2026-08-03T09:00:00.000Z",
  completedAt: "2026-08-03T09:00:04.000Z",
  phases: [],
  logs: [],
  nodes: [
    {
      id: "n0",
      label: "child",
      status: "completed",
      prompt: "the child prompt",
      cwd: "/Users/tester/project",
      tools: 1,
      usage: { total: 1_000, cost: 0.002 },
      resultPreview: '{"summary":"done"}',
      toolCalls: [{ id: "c0", name: "read", status: "completed", argumentSummary: "a.ts" }],
    },
  ],
};
const JOB = {
  jobId: "bg_7",
  kind: "background_run",
  status: "completed",
  command: "npm test",
  description: "run tests",
  cwd: "/Users/tester/project",
  durationMs: 2_500,
  exitCode: 0,
  outputBytes: 128,
  outputPath: "/tmp/bg/output.log",
  deliveryState: "sent",
  tail: "PASS one\nPASS two",
};
const JOBS_DETAILS = { jobs: [JOB], truncated: false, omittedCount: 0 };
const lines = (count) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

/** name, arguments, result details/text, and a fragment expected in each state. */
const TOOL_CASES = [
  [
    "bash",
    { command: "ls -la", timeout: 30 },
    { text: lines(4) },
    /\$ ls -la.*4 output lines/,
    /line 3/,
  ],
  [
    "read",
    { path: "/Users/tester/a.ts", offset: 5, limit: 10 },
    { text: lines(9) },
    /read ~\/a\.ts:5-14.*9 lines/,
    /line 8/,
  ],
  [
    "write",
    { path: "/tmp/a.txt", content: "x\ny" },
    { text: "ok" },
    /write \/tmp\/a\.txt · 2 lines/,
    /x/,
  ],
  [
    "edit",
    { path: "/tmp/a.txt", edits: [{ oldText: "a", newText: "b" }] },
    { text: "applied", details: { diff: "@@ -1 +1 @@\n-a\n+b" } },
    /edit \/tmp\/a\.txt · 1 replacement/,
    /\+1 \/ -1/,
  ],
  [
    "ls",
    { path: "/tmp", limit: 50 },
    { text: lines(3) },
    /ls \/tmp · limit 50.*3 entries/,
    /line 2/,
  ],
  [
    "grep",
    {
      pattern: "foo",
      path: "src",
      glob: "*.ts",
      ignoreCase: true,
      literal: true,
      context: 2,
      limit: 20,
    },
    { text: lines(2) },
    /grep foo · in src · \*\.ts · ignoring case · literal · ±2 context · limit 20.*2 matching lines/,
    /line 1/,
  ],
  [
    "find",
    { pattern: "*.ts", path: "src", limit: 10 },
    { text: lines(5) },
    /find \*\.ts · in src · limit 10.*5 paths/,
    /line 4/,
  ],
  [
    "ffgrep",
    {
      pattern: "bar",
      path: "src",
      exclude: ["test/"],
      caseSensitive: true,
      context: 1,
      cursor: "c1",
    },
    // File-grouped output: headings and context rows must not be counted as matches,
    // and the trailing bracketed notice must not be counted at all.
    {
      text: [
        "src/a.ts",
        " 11-  const before = 1;",
        " 12:  const bar = 2;",
        "",
        "src/b.ts",
        " 40:  bar();",
        "",
        "[40 matches limit reached]",
      ].join("\n"),
    },
    /ffgrep bar · in src · excluding test\/ · case-sensitive · ±1 context · next page.*2 matching lines in 2 files.*40 matches limit reached/,
    /const bar = 2;/,
  ],
  [
    "fffind",
    { pattern: "auth", exclude: "vendor/" },
    { text: lines(2), details: { totalMatched: 90, pageIndex: 1, hasMore: true } },
    /fffind auth · excluding vendor\/.*90 paths · page 2 · more available/,
    /line 1/,
  ],
  [
    "fff-multi-grep",
    { patterns: ["auth_state", "authState"], constraints: "*.ts" },
    { text: "src/auth.ts\n 12: authState();" },
    /fff-multi-grep auth_state, authState · matching \*\.ts.*1 matching line/,
    /authState/,
  ],
  [
    "agentflow_finder",
    { task: "find the boundary", paths: ["src"] },
    { details: { snapshot: AGENT_RUN } },
    /finder · find the boundary/,
    /Paths/,
  ],
  [
    "agentflow_oracle",
    { question: "which design?", files: ["a.ts"] },
    { details: { snapshot: AGENT_RUN } },
    /oracle · which design\?/,
    /Files/,
  ],
  [
    "agentflow_librarian",
    { question: "tokio state?" },
    { details: { snapshot: AGENT_RUN } },
    /librarian · tokio state\?/,
    /completed/,
  ],
  [
    "agentflow_look_at",
    {
      path: "/Users/tester/shot.png",
      objective: "read the chart",
      referenceFiles: ["/Users/tester/b.png"],
    },
    { details: { snapshot: AGENT_RUN } },
    /look_at ~\/shot\.png · read the chart/,
    /References/,
  ],
  [
    "agentflow_delegate",
    {
      task: "do the thing",
      ownership: ["src/a.ts"],
      acceptanceCriteria: ["tests pass"],
      verificationCommands: ["npm test"],
    },
    { details: { snapshot: AGENT_RUN } },
    /delegate · do the thing/,
    /Ownership.*Acceptance criteria.*Verification/s,
  ],
  [
    "agentflow_review",
    { task: "review it", base: "HEAD~1" },
    { details: { snapshot: AGENT_RUN } },
    /review · review it/,
    /Base/,
  ],
  [
    "agentflow_claude",
    { task: "design it", model: "fable" },
    { details: { snapshot: AGENT_RUN } },
    /claude fable · design it/,
    /completed/,
  ],
  [
    "agentflow_agent",
    { prompt: "go", label: "scout", model: "gpt-5.6-luna", thinking: "high" },
    { details: { snapshot: AGENT_RUN } },
    /agentflow_agent scout · go/,
    /Model.*Thinking/s,
  ],
  [
    "agentflow_workflow",
    {
      script: 'export const meta = { name: "sweep", description: "sweep the repo" }',
      limits: { maxAgents: 4 },
    },
    {
      details: {
        snapshot: {
          ...AGENT_RUN,
          kind: "workflow",
          phases: ["Find", "Fix"],
          nodes: [
            {
              id: "a",
              label: "scan",
              phase: "Find",
              status: "completed",
              prompt: "scan the repo for the boundary",
              tools: 1,
              usage: { total: 10, cost: 0.001 },
              toolCalls: [
                { id: "a0", name: "grep", status: "completed", argumentSummary: "boundary" },
              ],
              startedAt: "2026-08-03T09:00:00.000Z",
              completedAt: "2026-08-03T09:00:02.000Z",
            },
            {
              id: "b",
              label: "fix",
              phase: "Fix",
              status: "completed",
              prompt: "apply the fix and verify",
              tools: 0,
              usage: { total: 20, cost: 0.001 },
              startedAt: "2026-08-03T09:00:02.000Z",
              completedAt: "2026-08-03T09:00:04.000Z",
            },
          ],
        },
      },
    },
    /agentflow_workflow sweep · sweep the repo/,
    /Nodes.*Find.*scan.*Fix.*fix/s,
  ],
  [
    "agentflow_status",
    { runId: "af_9" },
    { details: { snapshot: AGENT_RUN } },
    /agentflow_status · af_9/,
    /Run.*Prompt/s,
  ],
  [
    "agentflow_wait",
    { runIds: ["af_9", "af_8"] },
    { details: { results: [{ snapshot: AGENT_RUN }] } },
    /agentflow_wait · af_9, af_8/,
    /Run.*Prompt/s,
  ],
  [
    "agentflow_cancel",
    { runIds: ["af_9"] },
    { details: { snapshots: [AGENT_RUN] } },
    /agentflow_cancel · af_9/,
    /Run.*Prompt/s,
  ],
  [
    "agentflow_steer",
    { runId: "af_9", nodeId: "n0", message: "focus on auth" },
    { text: "Steering accepted for n0.", details: { nodeId: "n0" } },
    /agentflow_steer · af_9 \/ n0 · focus on auth/,
    /steering accepted for n0/,
  ],
  [
    "background_run",
    { command: "npm test", description: "run tests", timeout: 60 },
    { details: JOBS_DETAILS },
    /background_run · npm test · run tests · 60s timeout/,
    /bg_7/,
  ],
  [
    "background_event_stream",
    { command: "tail -f log", description: "watch", persistent: true },
    {
      details: {
        jobs: [
          {
            ...JOB,
            kind: "background_event_stream",
            monitor: {
              deliveries: 3,
              droppedLines: 1,
              droppedBytes: 20,
              splitLines: 0,
              captureOnly: true,
              completionOutput: "remaining",
            },
          },
        ],
        truncated: false,
        omittedCount: 0,
      },
    },
    /background_event_stream · tail -f log · watch · persistent/,
    /Deliveries.*Capture only/s,
  ],
  [
    "background_status",
    { jobId: "bg_7", tailLines: 20 },
    { details: JOBS_DETAILS },
    /background_status · bg_7 · tail 20 lines/,
    /npm test/,
  ],
  [
    "background_wait",
    { jobIds: ["bg_7"], timeout: 30 },
    { details: JOBS_DETAILS },
    /background_wait · bg_7 · giving up after 30s/,
    /npm test/,
  ],
  [
    "background_stop",
    { jobIds: ["bg_7", "bg_8"] },
    { details: JOBS_DETAILS },
    /background_stop · bg_7, bg_8/,
    /npm test/,
  ],
  [
    "questionnaire",
    {
      questions: [
        { id: "q1", label: "Scope", prompt: "How far?", options: [{ value: "a", label: "All" }] },
      ],
    },
    {
      text: "Questionnaire completed",
      details: { answers: [{ id: "q1", value: "a", label: "All", wasCustom: false, index: 0 }] },
    },
    /questionnaire · 1 question \(Scope\)/,
    /Selected: All/,
  ],
  [
    "web_search",
    {
      queries: ["a", "b"],
      numResults: 5,
      provider: "brave",
      recencyFilter: "week",
      includeContent: true,
    },
    {
      text: "Approved summary",
      details: {
        queryCount: 2,
        successfulQueries: 2,
        totalResults: 7,
        curated: true,
        curatedFrom: 3,
        curatedQueries: [
          {
            query: "a",
            provider: "brave",
            answer: "**Answer A**",
            sources: [{ title: "Source A", url: "https://example.com/a" }],
            error: null,
          },
        ],
        summary: {
          text: "Approved summary",
          workflow: "summary-review",
          model: "openai/gpt-test",
          durationMs: 42,
          tokenEstimate: 10,
          fallbackUsed: false,
          edited: true,
        },
      },
    },
    /web_search · 2 queries · brave · 5 per query · past week · with page content.*2\/2 queries · 7 sources · 2\/3 queries curated/,
    /Summary.*summary-review.*openai\/gpt-test.*a · brave.*Source A/s,
  ],
  [
    "fetch_content",
    { url: "https://example.com/p", prompt: "what is shown?", timestamp: "1:23", frames: 4 },
    {
      text: lines(3),
      details: {
        urlCount: 1,
        successful: 1,
        totalChars: 500,
        title: "Example page",
        responseId: "r_fetch",
        truncated: true,
        imageCount: 4,
      },
    },
    /fetch_content https:\/\/example\.com\/p · at 1:23 · 4 frames · what is shown\?.*Example page · 500 chars · 4 images · truncated/,
    /Status.*Example page.*line 0/s,
  ],
  [
    "get_search_content",
    { responseId: "r_1", url: "https://example.com/p", offset: 100, limit: 500 },
    {
      text: lines(3),
      details: {
        contentLength: 900,
        offset: 100,
        returnedChars: 500,
        nextOffset: 600,
        truncated: true,
      },
    },
    /get_search_content · r_1 · https:\/\/example\.com\/p · from 100 for 500 chars.*500\/900 chars · more available/,
    /Content.*line 0/s,
  ],
  [
    "source_check",
    {
      claim: "Rust is memory safe",
      queries: ["a", "b"],
      numResults: 8,
      provider: "exa",
      recencyFilter: "month",
      domainFilter: ["doc.rust-lang.org", "-blogs.example"],
      fetchContent: true,
    },
    {
      text: lines(2),
      details: {
        artifact: {
          query: "Rust is memory safe",
          claims: [{ claim: "Rust is memory safe", status: "supported", confidence: 0.9 }],
          sources: [
            { rank: 1, quality: "primary", title: "Rust docs", url: "https://doc.rust-lang.org/" },
          ],
          errors: [],
        },
      },
    },
    /source_check · Rust is memory safe · 2 queries · exa · 8 per query · past month · doc\.rust-lang\.org, -blogs\.example · with passages.*supported · 1 source/,
    /Assessment.*Rust docs/s,
  ],
  [
    "some_unregistered_tool",
    { alpha: 1 },
    { text: "opaque output" },
    /some_unregistered_tool/,
    /"alpha": 1/,
  ],
];

test("every registered tool renders a collapsed and an expanded view", async () => {
  const dom = installDom();
  try {
    const [{ mount, REGISTERED_TOOL_NAMES }, { createMockIncrementalTransport }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);

    const covered = new Set(TOOL_CASES.map(([name]) => name));
    assert.deepEqual(
      REGISTERED_TOOL_NAMES.filter((name) => !covered.has(name)),
      [],
      "every registered tool has a fixture in TOOL_CASES",
    );

    const root = document.querySelector("#app");
    const entries = TOOL_CASES.flatMap(([name, args, result], index) => [
      {
        id: `case-call-${index}`,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `case-${index}`, name, arguments: args }],
        },
      },
      {
        id: `case-result-${index}`,
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `case-${index}`,
          toolName: name,
          content: [{ type: "text", text: result.text ?? "" }],
          details: result.details,
          isError: false,
        },
      },
    ]);
    const transport = createMockIncrementalTransport(snapshotEnvelope(entries));
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const boxes = [...root.querySelectorAll(".tool-execution")];
    assert.equal(boxes.length, TOOL_CASES.length, "one box per tool call");

    // Collapsed: the header identifies the call and no box is left blank.
    TOOL_CASES.forEach(([name, , , collapsed], index) => {
      const box = boxes[index];
      assert.match(box.textContent.replaceAll("\n", " "), collapsed, `${name} collapsed`);
      assert.equal(
        box.querySelector(".tool-disclosure-toggle").getAttribute("aria-expanded"),
        "false",
        `${name} starts collapsed`,
      );
    });

    // Expanded: every tool reveals its detail view rather than repeating the header.
    expandAllTools(root);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const expandedBoxes = [...root.querySelectorAll(".tool-execution")];
    TOOL_CASES.forEach(([name, , , , expanded], index) => {
      const box = expandedBoxes[index];
      assert.equal(
        box.querySelector(".tool-disclosure-toggle").getAttribute("aria-expanded"),
        "true",
        `${name} expands`,
      );
      assert.match(box.textContent.replaceAll("\n", " "), expanded, `${name} expanded`);
    });

    transport.close();
  } finally {
    dom.window.close();
  }
});

test("a live run advances its elapsed time; settled and background ones stay put", async () => {
  const dom = installDom();
  // The interval and the clock are both taken over, so one tick can be driven on demand
  // instead of the test waiting a real second.
  const ticks = [];
  const realNow = Date.now;
  let clock = Date.parse("2026-08-03T09:00:30.000Z");
  window.setInterval = (callback) => ticks.push(callback);
  window.clearInterval = () => {};
  Date.now = () => clock;
  try {
    const [{ mount }, { createMockIncrementalTransport }] = await Promise.all([
      import("../src/client/index.tsx"),
      import("../src/testing/index.ts"),
    ]);
    const root = document.querySelector("#app");
    const run = (status, background = false) => ({
      runId: "af_live",
      kind: "agent",
      semanticRole: "finder",
      status,
      background,
      createdAt: "2026-08-03T09:00:00.000Z",
      completedAt: status === "running" ? undefined : "2026-08-03T09:00:12.000Z",
      phases: [],
      logs: [],
      nodes: [
        {
          status,
          prompt: "Find the auth boundary",
          cwd: "/work/project",
          tools: 1,
          usage: { total: 10, cost: 0.01 },
          completedAt: status === "running" ? undefined : "2026-08-03T09:00:12.000Z",
          toolCalls: [],
        },
      ],
    });
    const entries = (status, suffix, background = false) => [
      {
        id: `live-call-${suffix}`,
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `live-run-${suffix}`,
              name: "agentflow_finder",
              arguments: { task: "Find the auth boundary" },
            },
          ],
        },
      },
      {
        id: `live-result-${suffix}`,
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `live-run-${suffix}`,
          toolName: "agentflow_finder",
          content: [{ type: "text", text: "{}" }],
          details: { snapshot: run(status, background) },
          isError: false,
        },
      },
    ];
    const transport = createMockIncrementalTransport(
      snapshotEnvelope([
        ...entries("running", "a"),
        ...entries("completed", "b"),
        // Launched and left: the extension never corrects this snapshot, so the card reports
        // its mode and no duration, and schedules no redraw of its own.
        ...entries("running", "c", true),
      ]),
    );
    mount(root, transport);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const summaries = () =>
      [...root.querySelectorAll(".tool-run-summary")].map((node) => node.textContent);
    assert.deepEqual(
      summaries().map((text) => /· ([\d.]+m?[\d.]*s) ·/.exec(text)?.[1]),
      ["30.0s", "12.0s", undefined],
      "a running run measures against now; a finished one against its completion",
    );
    assert.match(summaries()[2], /running in the background/);
    assert.equal(ticks.length, 1, "only the foreground live run schedules a redraw");

    clock += 5_000;
    ticks[0]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      summaries().map((text) => /· ([\d.]+m?[\d.]*s) ·/.exec(text)?.[1]),
      ["35.0s", "12.0s", undefined],
    );
  } finally {
    Date.now = realNow;
    dom.window.close();
  }
});
