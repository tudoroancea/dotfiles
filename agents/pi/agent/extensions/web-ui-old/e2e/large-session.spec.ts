import { buildBranch, expect, openLargeSession, test } from "./fixtures.js";

const region = ".timeline-region";
const scroller = ".timeline-scroll";
const loader = ".timeline__earlier-button";

async function historyLength(page: import("@playwright/test").Page): Promise<number> {
  const value = await page.locator(region).getAttribute("data-history-length");
  return Number(value);
}

async function isComplete(page: import("@playwright/test").Page): Promise<boolean> {
  return (await page.locator(region).getAttribute("data-history-complete")) === "true";
}

async function delayNextHistoryPage(page: import("@playwright/test").Page): Promise<{
  requested: Promise<void>;
  release: () => void;
}> {
  let markRequested!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => (markRequested = resolve));
  await page.routeWebSocket(/\/ws(?:\?|$)/, (browser) => {
    const server = browser.connectToServer();
    let held: string | Buffer | undefined;
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const response = JSON.parse(message.toString()) as { type?: string };
      if (response.type === "history_page" && held === undefined) {
        held = message;
        release = () => browser.send(held!);
        markRequested();
      } else {
        browser.send(message);
      }
    });
  });
  return { requested, release: () => release() };
}

async function rejectNextHistoryPage(page: import("@playwright/test").Page): Promise<void> {
  await page.routeWebSocket(/\/ws(?:\?|$)/, (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const command = JSON.parse(message.toString()) as {
        type?: string;
        commandId?: string;
        generation?: string;
      };
      if (command.type !== "history_page") {
        server.send(message);
        return;
      }
      browser.send(
        JSON.stringify({
          type: "command_response",
          protocolVersion: 7,
          generation: command.generation,
          commandId: command.commandId,
          command: "history_page",
          accepted: false,
          error: "Deterministic rejected page",
        }),
      );
    });
    server.onMessage((message) => browser.send(message));
  });
}

test("renders a bounded DOM for a multi-thousand-entry session", async ({ page, largeSession }) => {
  await openLargeSession(page, largeSession.bootstrapUrl);

  // Only the newest bounded page is projected into the initial snapshot.
  expect(await historyLength(page)).toBeLessThanOrEqual(100);
  await expect.poll(() => page.locator("[data-row-key]").count()).toBeGreaterThan(0);
  const rows = await page.locator("[data-row-key]").count();
  // A 2400-entry branch never renders anywhere near the whole transcript.
  expect(rows).toBeLessThan(60);
});

test("uses CSP-safe virtual geometry across distant ranges after multiple pages", async ({
  page,
  largeSession,
}) => {
  await openLargeSession(page, largeSession.bootstrapUrl);

  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const previous = await historyLength(page);
    await page.locator(scroller).evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => historyLength(page)).toBe(previous + 100);
  }

  await expect(page.locator("[style]")).toHaveCount(0);
  const geometry = await page.locator(scroller).evaluate((element) => {
    const list = element.querySelector<HTMLElement>("[data-virtual-list]")!;
    return {
      listHeight: list.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(geometry.listHeight).toBeGreaterThan(400 * 50);
  expect(geometry.scrollHeight).toBeGreaterThanOrEqual(geometry.listHeight);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight * 10);

  const mountedRanges: string[][] = [];
  let previousSignature = await page
    .locator("[data-row-key]")
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.rowKey).join("|"));
  for (const fraction of [0.2, 0.5, 0.8]) {
    await page.locator(scroller).evaluate((element, targetFraction) => {
      const offset = (element.scrollHeight - element.clientHeight) * targetFraction;
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      element.scrollTop = offset;
      element.dispatchEvent(new Event("scroll"));
    }, fraction);
    await expect
      .poll(() =>
        page
          .locator(scroller)
          .evaluate((element) => element.scrollTop / (element.scrollHeight - element.clientHeight)),
      )
      .toBeGreaterThan(fraction - 0.1);
    await expect
      .poll(async () => {
        const signature = await page
          .locator("[data-row-key]")
          .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.rowKey).join("|"));
        return signature !== previousSignature;
      })
      .toBe(true);
    const keys = await page
      .locator("[data-row-key]")
      .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.rowKey!));
    mountedRanges.push(keys);
    previousSignature = keys.join("|");
  }

  expect(new Set(mountedRanges.flat()).size).toBeGreaterThan(
    Math.max(...mountedRanges.map((keys) => keys.length)),
  );
  await expect(page.locator("[style]")).toHaveCount(0);
});

test("pages to the first entry with no gaps or duplicates", async ({ page, largeSession }) => {
  await openLargeSession(page, largeSession.bootstrapUrl);

  let previous = await historyLength(page);
  for (let guard = 0; guard < 60 && !(await isComplete(page)); guard += 1) {
    await page.locator(scroller).evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => historyLength(page)).toBeGreaterThan(previous);
    previous = await historyLength(page);
  }

  expect(await isComplete(page)).toBe(true);
  // Contiguous id-deduplicated prepends land exactly on the full branch size.
  expect(await historyLength(page)).toBe(2400);

  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByText("User request 0", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Session details" })).toBeVisible();
});

test("anchors the first transcript row through a top-sentinel final prepend", async ({
  page,
  largeSession,
}) => {
  const finalBranch = buildBranch(150, "final", "Final");
  largeSession.resetBranch(finalBranch.branch, finalBranch.leafId, finalBranch.sessionId);
  const delayed = await delayNextHistoryPage(page);
  await openLargeSession(page, largeSession.bootstrapUrl);

  // Let the virtual range catch up before crossing the automatic top sentinel.
  await page.locator(scroller).evaluate(async (element) => {
    element.scrollTop = 320;
    element.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await delayed.requested;
  const before = await page.locator(scroller).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-row-key^="entry:"]')].sort(
      (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top,
    )[0];
    if (!row) throw new Error("No transcript row at the top sentinel");
    return { key: row.dataset.rowKey!, offset: row.getBoundingClientRect().top - top };
  });
  delayed.release();
  await expect.poll(() => historyLength(page)).toBe(150);
  expect(await isComplete(page)).toBe(true);
  await expect
    .poll(() =>
      page.locator(scroller).evaluate((scroll, anchor) => {
        const row = [...scroll.querySelectorAll<HTMLElement>("[data-row-key]")].find(
          (candidate) => candidate.dataset.rowKey === anchor.key,
        );
        if (!row) return Number.POSITIVE_INFINITY;
        return Math.abs(
          row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset,
        );
      }, before),
    )
    .toBeLessThan(8);
});

test("keeps the visible anchor row fixed across an older-page prepend", async ({
  page,
  largeSession,
}) => {
  await openLargeSession(page, largeSession.bootstrapUrl);

  const initialLength = await historyLength(page);

  // Stage 1: scroll outside the automatic sentinel and let virtualization settle.
  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = 320;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => page.locator(scroller).evaluate((element) => element.scrollTop))
    .toBe(320);
  await expect.poll(() => page.locator('[data-row-key^="entry:"]').count()).toBeGreaterThan(2);

  // Stage 2: capture the settled row crossing the viewport top.
  const before = await page.locator(scroller).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll<HTMLElement>('[data-row-key^="entry:"]')]
      .map((row) => ({ key: row.dataset.rowKey!, rect: row.getBoundingClientRect() }))
      .filter((row) => row.rect.bottom > top)
      .sort((left, right) => left.rect.top - right.rect.top);
    const anchor = rows[0];
    if (!anchor) throw new Error("No settled entry crosses the viewport top");
    return { key: anchor.key, offset: anchor.rect.top - top };
  });

  // Stage 3: issue exactly one explicit request without scrolling the offscreen control.
  await page.locator(loader).evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => historyLength(page)).toBe(initialLength + 100);

  // Stage 4: poll layout itself; history arrival and measurement are separate phases.
  await expect
    .poll(async () => {
      const row = page.locator(`[data-row-key="${before.key}"]`);
      if ((await row.count()) === 0) return Number.POSITIVE_INFINITY;
      const after = await row.evaluate((element) => {
        const scroll = element.closest<HTMLElement>(".timeline-scroll")!;
        return element.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      });
      return Math.abs(after - before.offset);
    })
    .toBeLessThan(8);
});

test("releases a delayed prepend anchor after user movement", async ({ page, largeSession }) => {
  const delayed = await delayNextHistoryPage(page);
  await openLargeSession(page, largeSession.bootstrapUrl);
  const initialLength = await historyLength(page);

  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await delayed.requested;
  await page.locator(scroller).evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    element.scrollTop = 500;
    element.dispatchEvent(new Event("scroll"));
  });
  delayed.release();
  await expect.poll(() => historyLength(page)).toBe(initialLength + 100);
  // Native overflow anchoring may absorb a few measured-height corrections,
  // but the released application anchor must not jump by an entire page.
  await expect
    .poll(() => page.locator(scroller).evaluate((element) => element.scrollTop))
    .toBeLessThan(650);
});

test("does not reuse a rejected request anchor for a later live append", async ({
  page,
  largeSession,
}) => {
  await rejectNextHistoryPage(page);
  await openLargeSession(page, largeSession.bootstrapUrl);
  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByText("Retry loading earlier messages", { exact: true })).toBeVisible();

  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = 500;
    element.dispatchEvent(new Event("scroll"));
  });
  largeSession.broadcast("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "APPEND AFTER REJECTION" }],
      timestamp: 99,
    },
  });
  await expect(page.locator(".timeline__jump-count")).toBeVisible();
  await expect
    .poll(() => page.locator(scroller).evaluate((element) => element.scrollTop))
    .toBe(500);
});

test("follows live growth at the bottom and offers jump-to-latest when scrolled away", async ({
  page,
  largeSession,
}) => {
  await openLargeSession(page, largeSession.bootstrapUrl);

  // At the bottom, a new finalized message scrolls into view automatically.
  largeSession.broadcast("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "FOLLOW ME NOW" }],
      timestamp: 1,
    },
  });
  await expect(page.getByText("FOLLOW ME NOW", { exact: true })).toBeVisible();

  // Scroll away from the bottom (clear of the sentinel zone).
  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = 600;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".timeline__jump")).toBeVisible();

  largeSession.broadcast("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "SECOND UPDATE" }],
      timestamp: 2,
    },
  });
  await expect(page.locator(".timeline__jump-count")).toBeVisible();
  await expect(page.getByText("SECOND UPDATE", { exact: true })).not.toBeVisible();

  await page.locator(".timeline__jump").click();
  await expect(page.getByText("SECOND UPDATE", { exact: true })).toBeVisible();
  await expect(page.locator(".timeline__jump")).toHaveCount(0);
});

test("preserves focus and expansion when a live tool persists", async ({ page, largeSession }) => {
  await openLargeSession(page, largeSession.bootstrapUrl);
  const toolCallId = "focused-live-tool";
  largeSession.broadcast("tool_execution_start", {
    toolCallId,
    toolName: "bash",
    args: { command: "echo live" },
  });
  largeSession.broadcast("tool_execution_end", {
    toolCallId,
    toolName: "bash",
    result: {
      content: [
        {
          type: "text",
          text: Array.from({ length: 8 }, (_, index) => `live result ${index + 1}`).join("\n"),
        },
      ],
    },
    isError: false,
  });

  const row = page.locator(`[data-row-key="tool:${toolCallId}"]`);
  const output = row.locator(".exporter-output");
  await output.click();
  await output.focus();
  await expect(output).toHaveAttribute("aria-expanded", "true");
  await expect(output).toBeFocused();

  largeSession.persistTool(toolCallId);
  await expect(page.locator(`[data-tool-id="${toolCallId}"]`)).toHaveCount(1);
  await expect(output).toHaveAttribute("aria-expanded", "true");
  await expect(output).toBeFocused();
});

test("preserves an expanded tool across virtual unmount and remount", async ({
  page,
  largeSession,
}) => {
  await openLargeSession(page, largeSession.bootstrapUrl);

  const tool = page.locator("[data-tool-id]").last();
  const toolId = await tool.getAttribute("data-tool-id");
  const disclosure = page.locator(`[data-tool-id="${toolId}"] .exporter-output`);

  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");

  // Scroll far away without entering the prepend sentinel, then back to it.
  await page.locator(scroller).evaluate((element) => {
    (document.activeElement as HTMLElement | null)?.blur();
    element.scrollTop = 600;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(`[data-tool-id="${toolId}"]`)).toHaveCount(0);

  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator(`[data-tool-id="${toolId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-tool-id="${toolId}"] .exporter-output`)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

test("resets cleanly on a history-generation change without mixing branches", async ({
  page,
  largeSession,
}) => {
  await openLargeSession(page, largeSession.bootstrapUrl);

  // Load an older page so multiple chunks are resident.
  await page.locator(scroller).evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => historyLength(page)).toBeGreaterThan(100);

  const replacement = buildBranch(40, "reset", "Reset");
  largeSession.resetBranch(replacement.branch, replacement.leafId, replacement.sessionId);

  // A fresh generation follows its latest rows rather than retaining the old scroll offset.
  await expect(page.getByText("Reset request 36", { exact: true })).toBeVisible();
  await expect.poll(() => historyLength(page)).toBe(40);
  expect(await isComplete(page)).toBe(true);
  // No entry from the superseded lineage survives the rotation.
  await expect(page.getByText("User request", { exact: false })).toHaveCount(0);
});
