import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
    url: "http://127.0.0.1/session/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
    history: window.history,
    location: window.location,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

const wait = (ms = 170) => new Promise((resolve) => setTimeout(resolve, ms));

const modelOf = (id) => ({ provider: "fixture", id, name: `Fixture ${id}` });

const metadataOf = (id, thinkingLevel) => ({
  cwd: "/repo",
  home: "/home/test",
  sessionCost: 0,
  model: modelOf(id),
  thinkingLevel,
});

// A stable, non-scrolling history window so mounting never fires history loads.
function baseEnvelope(sessionSnapshotFixture, { metadata, modelControl } = {}) {
  const envelope = sessionSnapshotFixture();
  envelope.snapshot.history = {
    historyGeneration: "model-control-history",
    beforeCursor: null,
    hasMore: false,
    oldestEntryId: "entry-1",
  };
  envelope.snapshot.metadata = metadata ?? metadataOf("model-1", "low");
  if (modelControl) envelope.snapshot.modelControl = modelControl;
  return envelope;
}

const key = (event, extra = {}) =>
  new globalThis.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...event,
    ...extra,
  });

const openViaControl = async (root) => {
  root.querySelector('button[aria-label="Choose model and thinking"]').click();
  await wait(20);
  return root.querySelector('[role="dialog"][aria-labelledby="model-control-title"]');
};

const dialogItems = (dialog) => [
  ...dialog.querySelectorAll('.model-control-model, [role="slider"]'),
];

test("Option+KeyM and the composer control open the dialog; Escape and backdrop close it", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture);
    const root = document.querySelector("#app");
    mount(root, createMockIncrementalTransport(envelope));
    await wait();

    const input = root.querySelector(".composer-input");
    input.focus();
    input.value = "draft stays put";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(key({ key: "µ", code: "KeyM", altKey: true }));
    await wait(20);

    let dialog = root.querySelector('[role="dialog"][aria-labelledby="model-control-title"]');
    assert.ok(dialog, "physical KeyM opens even when macOS reports µ");
    assert.equal(input.value, "draft stays put");
    const current = dialog.querySelector('[aria-current="true"]');
    assert.equal(current.textContent, "fixture/model-1");

    dialog.dispatchEvent(key({ key: "Escape" }));
    await wait(20);
    assert.equal(root.querySelector("#model-control-title"), null);
    assert.equal(document.activeElement, input, "Escape restores the composer focus");
    assert.equal(input.value, "draft stays put");

    const opener = root.querySelector('button[aria-label="Choose model and thinking"]');
    opener.click();
    await wait(20);
    dialog = root.querySelector('[role="dialog"][aria-labelledby="model-control-title"]');
    assert.ok(dialog, "the touch/click control opens the same dialog");

    document.dispatchEvent(key({ key: "k", code: "KeyK", ctrlKey: true }));
    await wait(20);
    assert.equal(root.querySelectorAll('[role="dialog"][aria-modal="true"]').length, 1);
    assert.equal(dialog.contains(document.activeElement), true, "focus stays in the dialog");

    const backdrop = dialog.closest(".palette-backdrop");
    backdrop.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    await wait(20);
    assert.equal(root.querySelector("#model-control-title"), null, "backdrop click closes");
    assert.equal(document.activeElement, input, "backdrop close returns focus to the composer");
  } finally {
    dom.window.close();
  }
});

test("the dialog stays open across model and thinking command-epoch changes", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture);
    const mock = createMockIncrementalTransport(envelope);
    const root = document.querySelector("#app");
    mount(root, mock);
    await wait();
    const dialog = await openViaControl(root);

    // A confirmed model change arrives as a fresh command epoch (a snapshot/reset),
    // not just metadata; the dialog must ride through it.
    mock.emit({
      version: 1,
      type: "reset",
      generation: envelope.generation,
      revision: envelope.revision + 1,
      reason: "model change",
      snapshot: {
        ...envelope.snapshot,
        commandEpoch: "fixture-command-epoch-2",
        metadata: metadataOf("model-2", "low"),
      },
    });
    await wait(20);
    assert.ok(root.querySelector("#model-control-title"), "open across a model epoch change");
    assert.equal(dialog.querySelector('[aria-current="true"]').textContent, "fixture/model-2");
    assert.equal(
      document.activeElement,
      dialog.querySelector('[aria-current="true"]'),
      "focus follows the authoritative model so the old row is no longer highlighted",
    );

    mock.emit({
      version: 1,
      type: "reset",
      generation: envelope.generation,
      revision: envelope.revision + 2,
      reason: "thinking change",
      snapshot: {
        ...envelope.snapshot,
        commandEpoch: "fixture-command-epoch-3",
        metadata: metadataOf("model-2", "high"),
      },
    });
    await wait(20);
    assert.ok(root.querySelector("#model-control-title"), "open across a thinking epoch change");
    assert.equal(dialog.querySelector('[role="slider"]').getAttribute("aria-valuetext"), "high");

    // A different generation means another session took over: the dialog closes.
    mock.emit({
      version: 1,
      type: "reset",
      generation: "fixture-generation-2",
      revision: 1,
      reason: "generation replacement",
      snapshot: { ...envelope.snapshot },
    });
    await wait(20);
    assert.equal(root.querySelector("#model-control-title"), null, "generation replacement closes");
  } finally {
    dom.window.close();
  }
});

test("the dialog shows no status prose and no model display names", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture);
    const root = document.querySelector("#app");
    mount(root, createMockIncrementalTransport(envelope));
    await wait();
    const dialog = await openViaControl(root);
    const text = dialog.textContent;

    for (const banned of [
      "Fixture model-1",
      "Fixture model-2",
      "Updated from session state",
      "Selection updates",
      "waiting",
      "pending",
      "current",
    ])
      assert.equal(text.includes(banned), false, `dialog must not contain "${banned}"`);
    assert.ok(text.includes("fixture/model-1"), "the provider/id identity is shown");
    assert.ok(
      (text.match(/thinking/gi) ?? []).length <= 1,
      "the word thinking appears at most once",
    );
  } finally {
    dom.window.close();
  }
});

test("the authoritative current model receives initial focus", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture, {
      metadata: metadataOf("model-2", "low"),
    });
    const root = document.querySelector("#app");
    mount(root, createMockIncrementalTransport(envelope));
    await wait();
    await openViaControl(root);

    assert.equal(document.activeElement.textContent, "fixture/model-2");
    assert.equal(document.activeElement.getAttribute("aria-current"), "true");
  } finally {
    dom.window.close();
  }
});

test("model rows expose provider/id and arrows or jk change the model immediately", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture, {
      modelControl: {
        models: [modelOf("model-1"), modelOf("model-2"), modelOf("model-3")],
        thinkingLevels: ["low", "medium", "high"],
      },
    });
    const mock = createMockIncrementalTransport(envelope);
    const submitted = [];
    const transport = {
      ...mock,
      submitModelControl(command, signal) {
        submitted.push(command);
        return mock.submitModelControl(command, signal);
      },
    };
    const root = document.querySelector("#app");
    mount(root, transport);
    await wait();
    const dialog = await openViaControl(root);

    const currentRows = dialog.querySelectorAll('[aria-current="true"]');
    assert.equal(currentRows.length, 1, "exactly one row is current");
    const current = dialog.querySelector(".model-control-model.current");
    assert.equal(current, currentRows[0], "the current class marks the current row");
    assert.equal(current.getAttribute("aria-current"), "true");
    assert.equal(current.textContent, "fixture/model-1");
    assert.equal(current.textContent.includes("Fixture"), false, "no display name");

    const rovingItems = dialogItems(dialog).filter((item) => item.tabIndex === 0);
    assert.equal(rovingItems.length, 1, "one item is in the tab order");

    for (const shortcut of ["ArrowDown", "j", "ArrowUp", "k"]) {
      current.dispatchEvent(key({ key: shortcut }));
      await wait(20);
    }
    assert.equal(
      document.activeElement,
      current,
      "direct model changes do not move candidate focus",
    );
    assert.deepEqual(
      submitted.map((command) => [command.type, command.provider, command.modelId]),
      [
        ["set-model", "fixture", "model-2"],
        ["set-model", "fixture", "model-2"],
        ["set-model", "fixture", "model-3"],
        ["set-model", "fixture", "model-3"],
      ],
      "up/down and jk submit the adjacent model without Enter",
    );

    const modelTwo = [...dialog.querySelectorAll(".model-control-model")].find((button) =>
      button.textContent.includes("model-2"),
    );
    modelTwo.click();
    await wait(20);
    assert.equal(submitted.at(-1).modelId, "model-2", "clicking a model still applies it directly");
    assert.ok(root.querySelector("#model-control-title"), "the dialog stays open after a change");
  } finally {
    dom.window.close();
  }
});

test("the thinking slider exposes discrete semantics for an arbitrary subset", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture, {
      metadata: metadataOf("model-1", "medium"),
      modelControl: {
        models: [modelOf("model-1"), modelOf("model-2")],
        thinkingLevels: ["max", "minimal", "medium"],
      },
    });
    const mock = createMockIncrementalTransport(envelope);
    const submitted = [];
    const transport = {
      ...mock,
      submitModelControl(command, signal) {
        submitted.push(command);
        return mock.submitModelControl(command, signal);
      },
    };
    const root = document.querySelector("#app");
    mount(root, transport);
    await wait();
    const dialog = await openViaControl(root);
    const slider = dialog.querySelector('[role="slider"]');

    // Ordered low-to-high regardless of the advertised order.
    assert.equal(slider.getAttribute("aria-valuemin"), "0");
    assert.equal(slider.getAttribute("aria-valuemax"), "2");
    assert.equal(slider.getAttribute("aria-valuenow"), "1");
    assert.equal(slider.getAttribute("aria-valuetext"), "medium");
    assert.equal(slider.getAttribute("data-thinking-level"), "medium");
    assert.equal(dialog.querySelector(".thinking-slider-value").textContent, "medium");

    slider.focus();
    for (const shortcut of ["ArrowRight", "l", "ArrowLeft", "h", "Home"]) {
      slider.dispatchEvent(key({ key: shortcut }));
      await wait(20);
    }
    dialog
      .querySelectorAll(".thinking-slider-stop")[2]
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(20);
    assert.deepEqual(
      submitted.map((command) => command.thinkingLevel),
      ["max", "max", "minimal", "minimal", "minimal", "max"],
      "left/right, hl, Home, and clicks submit only advertised levels",
    );

    slider.focus();
    slider.dispatchEvent(key({ key: "Tab" }));
    await wait(20);
    assert.ok(
      document.activeElement.classList.contains("model-control-model"),
      "Tab remains available for focus navigation",
    );
  } finally {
    dom.window.close();
  }
});

test("the level color hook follows the selected level", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture, {
      metadata: metadataOf("model-1", "high"),
    });
    const root = document.querySelector("#app");
    mount(root, createMockIncrementalTransport(envelope));
    await wait();
    const dialog = await openViaControl(root);
    const slider = dialog.querySelector('[role="slider"]');
    assert.equal(slider.getAttribute("data-thinking-level"), "high");
    const selected = dialog.querySelector(".thinking-slider-stop.selected");
    assert.equal(selected.getAttribute("data-thinking-level"), "high");
    assert.equal(selected.classList.contains("filled"), true);
  } finally {
    dom.window.close();
  }
});

test("the slider handles a single available level", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture, {
      metadata: metadataOf("model-1", "medium"),
      modelControl: { models: [modelOf("model-1")], thinkingLevels: ["medium"] },
    });
    const mock = createMockIncrementalTransport(envelope);
    const submitted = [];
    const transport = {
      ...mock,
      submitModelControl(command, signal) {
        submitted.push(command);
        return mock.submitModelControl(command, signal);
      },
    };
    const root = document.querySelector("#app");
    mount(root, transport);
    await wait();
    const dialog = await openViaControl(root);
    const slider = dialog.querySelector('[role="slider"]');
    assert.equal(slider.getAttribute("aria-valuemin"), "0");
    assert.equal(slider.getAttribute("aria-valuemax"), "0");
    assert.equal(slider.getAttribute("aria-valuenow"), "0");
    assert.equal(slider.getAttribute("aria-valuetext"), "medium");
    assert.equal(dialog.querySelectorAll(".thinking-slider-stop").length, 1);

    slider.focus();
    for (const k of ["ArrowRight", "ArrowLeft", "Home", "End"])
      slider.dispatchEvent(key({ key: k }));
    await wait(20);
    assert.equal(submitted.length, 0, "a lone level never submits a change");
  } finally {
    dom.window.close();
  }
});

test("an authoritative rejection is announced off-screen and keeps the dialog open", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture);
    const mock = createMockIncrementalTransport(envelope);
    const transport = {
      ...mock,
      async submitModelControl(command) {
        return {
          version: 1,
          type: "command-response",
          commandId: command.commandId,
          generation: command.generation,
          commandEpoch: command.commandEpoch,
          accepted: false,
          error: "Model is unavailable",
          reason: "invalid",
        };
      },
    };
    const root = document.querySelector("#app");
    mount(root, transport);
    await wait();
    const dialog = await openViaControl(root);

    const modelTwo = [...dialog.querySelectorAll(".model-control-model")].find((button) =>
      button.textContent.includes("model-2"),
    );
    modelTwo.click();
    await wait(20);

    const live = dialog.querySelector('.model-control-live[role="alert"]');
    assert.ok(live, "an sr-only live region exists");
    assert.equal(live.textContent, "Model is unavailable");
    assert.ok(root.querySelector("#model-control-title"), "a rejection keeps the dialog open");
    assert.equal(
      dialog.querySelector('[aria-current="true"]').textContent,
      "fixture/model-1",
      "the selected model stays metadata-driven after a rejection",
    );
  } finally {
    dom.window.close();
  }
});

test("capability shrink keeps one focusable item and closes on capability removal", async () => {
  const dom = installDom();
  try {
    const [{ mount }, { createMockIncrementalTransport, sessionSnapshotFixture }] =
      await Promise.all([import("../src/client/index.tsx"), import("../src/testing/index.ts")]);
    const envelope = baseEnvelope(sessionSnapshotFixture);
    const mock = createMockIncrementalTransport(envelope);
    const root = document.querySelector("#app");
    mount(root, mock);
    await wait();
    const dialog = await openViaControl(root);

    // Move focus onto the second model with Tab, then drop it.
    dialog.dispatchEvent(key({ key: "Tab" }));
    await wait(20);
    assert.equal(document.activeElement.textContent, "fixture/model-2");

    mock.emit({
      version: 1,
      type: "reset",
      generation: envelope.generation,
      revision: envelope.revision + 1,
      reason: "capability shrink",
      snapshot: {
        ...envelope.snapshot,
        modelControl: { models: [modelOf("model-1")], thinkingLevels: ["off", "low", "medium"] },
      },
    });
    await wait(20);

    assert.ok(root.querySelector("#model-control-title"), "shrinking keeps the dialog open");
    assert.equal(
      [...dialog.querySelectorAll(".model-control-model")].some((button) =>
        button.textContent.includes("model-2"),
      ),
      false,
      "the removed model is gone",
    );
    assert.equal(dialog.contains(document.activeElement), true, "focus stays inside the dialog");
    assert.equal(
      dialogItems(dialog).filter((item) => item.tabIndex === 0).length,
      1,
      "one item stays in the tab order",
    );

    // Removing the capability entirely closes the dialog.
    mock.emit({
      version: 1,
      type: "reset",
      generation: envelope.generation,
      revision: envelope.revision + 2,
      reason: "capability removed",
      snapshot: { ...envelope.snapshot, modelControl: undefined },
    });
    await wait(20);
    assert.equal(root.querySelector("#model-control-title"), null, "capability removal closes");
  } finally {
    dom.window.close();
  }
});
