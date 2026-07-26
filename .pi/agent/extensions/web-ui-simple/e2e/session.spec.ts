import { expect, openSession, test } from "./fixtures.js";

test("exchanges a bootstrap code once and requires the authenticated cookie", async ({
  browser,
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);
  await expect(page).not.toHaveURL(/#code=/);

  const isolated = await browser.newContext();
  const replay = await isolated.newPage();
  try {
    const rejected = await isolated.request.post(`${session.server.url}input`, {
      data: { content: "unauthenticated", delivery: "immediate" },
    });
    expect(rejected.status()).toBe(401);

    await replay.goto(session.bootstrapUrl);
    await expect(replay.getByText("disconnected", { exact: true })).toBeVisible();
    await expect(replay.getByText("Deterministic browser fixture", { exact: true })).toHaveCount(0);
  } finally {
    await isolated.close();
  }
});

test("renders live snapshots without a framework-specific test contract", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);
  await expect(page.getByText("idle", { exact: true })).toBeVisible();

  session.snapshot.isRunning = true;
  session.snapshot.workingWord = "considering";
  session.server.broadcast();
  await expect(page.getByText("considering", { exact: true })).toBeVisible();

  session.appendUserMessage("A message delivered after connection");
  await expect(
    page.getByText("A message delivered after connection", { exact: true }),
  ).toBeVisible();
});

test("supports preference hotkeys and persists them across reloads", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);

  await page.keyboard.press("s");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("button", { name: /timestamps/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.getByText("Deterministic browser fixture", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("button", { name: /timestamps/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("renders composer metadata and focuses the input with the global hotkey", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);

  await expect(page.getByText("25% of 128.0k", { exact: true })).toBeVisible();
  await expect(page.getByText("$0.02", { exact: true })).toBeVisible();
  await expect(page.getByText("(test) fixture-model", { exact: true })).toBeVisible();
  await expect(page.getByText("high", { exact: true })).toBeVisible();
  await expect(page.getByText("~/project", { exact: true })).toBeVisible();

  session.snapshot.metadata = {
    cwd: "/tmp/changed-project",
    home: "/tmp",
    contextUsage: { tokens: 64_000, contextWindow: 128_000, percent: 50 },
    sessionCost: 0.025,
    model: { provider: "next", id: "updated-model", name: "Updated Model" },
    thinkingLevel: "medium",
  };
  session.server.broadcast();
  await expect(page.getByText("50% of 128.0k", { exact: true })).toBeVisible();
  await expect(page.getByText("$0.03", { exact: true })).toBeVisible();
  await expect(page.getByText("(next) updated-model", { exact: true })).toBeVisible();
  await expect(page.getByText("medium", { exact: true })).toBeVisible();
  await expect(page.getByText("~/changed-project", { exact: true })).toBeVisible();

  session.snapshot.metadata.model = {
    provider: "next",
    id: "long-model",
    name: `model-${"x".repeat(300)}`,
  };
  session.server.broadcast();
  await page.setViewportSize({ width: 390, height: 760 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  const input = page.getByRole("textbox", { name: "Message" });
  const unfocusedBackground = await input.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(
    await page
      .locator(".composer")
      .evaluate(
        (element) =>
          getComputedStyle(element).backgroundColor ===
          getComputedStyle(document.body).backgroundColor,
      ),
  ).toBe(true);
  await page.getByText("Playwright fixture", { exact: true }).click();
  await page.keyboard.press("i");
  await expect(input).toBeFocused();
  expect(await input.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    unfocusedBackground,
  );
});

test("auto-grows on desktop without a resize handle", async ({ page, session }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openSession(page, session.bootstrapUrl);
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toHaveCSS("resize", "none");
  const initialHeight = await input.evaluate((element) => element.getBoundingClientRect().height);
  await input.fill("one\ntwo\nthree\nfour");
  await expect
    .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(initialHeight);
  const geometry = await page.locator(".composer").evaluate((element) => {
    const composer = element.getBoundingClientRect();
    const label = element.querySelector(".composer-border-label-right")!.getBoundingClientRect();
    const button = element.querySelector(".composer-button")!.getBoundingClientRect();
    return {
      leftRadius: getComputedStyle(element).borderTopLeftRadius,
      rightRadius: getComputedStyle(element).borderTopRightRadius,
      cornerGap: composer.right - label.right,
      buttonRight: composer.right - button.right,
      buttonBottom: composer.bottom - button.bottom,
    };
  });
  expect(geometry.leftRadius).toBe("9px");
  expect(geometry.rightRadius).toBe("9px");
  expect(geometry.cornerGap).toBeGreaterThanOrEqual(12);
  expect(geometry.buttonRight).toBeGreaterThanOrEqual(13);
  expect(geometry.buttonBottom).toBeGreaterThanOrEqual(9);

  await input.fill("wrapping text ".repeat(35));
  const wideHeight = await input.evaluate((element) => element.getBoundingClientRect().height);
  await page.setViewportSize({ width: 700, height: 700 });
  await expect
    .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(wideHeight);
});

test("uses a one-line idle editor and the visual viewport when focused on mobile", async ({
  page,
  session,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await openSession(page, session.bootstrapUrl);
  const input = page.getByRole("textbox", { name: "Message" });
  const composer = page.locator(".composer");

  await expect(input).toHaveCSS("font-size", "16px");
  expect(
    await composer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: window.innerWidth - rect.right };
    }),
  ).toEqual({ left: 20, right: 20 });
  const idleHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  await input.focus();
  await expect
    .poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(650);
  await expect
    .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(550);
  await input.fill("Review @many");
  await expect(page.getByRole("option", { name: /file-00\.txt/ })).toBeVisible();
  expect(
    await page.getByRole("listbox").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }),
  ).toBe(true);
  const send = page.getByRole("button", { name: "Send message" });
  await send.focus();
  await expect
    .poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(650);
  await send.evaluate((element) => element.blur());
  await expect
    .poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(idleHeight);
});

test("keeps the anti-zoom font size on a landscape touch device", async ({ browser, session }) => {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await openSession(page, session.bootstrapUrl);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCSS("font-size", "16px");
    const bounds = await page.locator(".composer").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, left: rect.left, right: window.innerWidth - rect.right };
    });
    expect(bounds.width).toBeLessThanOrEqual(800);
    expect(bounds.left).toBeGreaterThanOrEqual(32);
    expect(bounds.right).toBeGreaterThanOrEqual(32);
  } finally {
    await context.close();
  }
});

test("sends, steers, and queues with explicit modifier behavior", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  const input = page.getByRole("textbox", { name: "Message" });

  await input.fill("first line");
  await input.press("Enter");
  await expect(input).toHaveValue("first line\n");
  expect(session.submitted).toHaveLength(0);

  await input.fill("start the turn");
  await input.press("Alt+Enter");
  await expect
    .poll(() => session.submitted)
    .toEqual([{ content: "start the turn", delivery: "immediate" }]);
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "Steer message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue follow-up" })).toHaveCount(0);

  await input.fill("change direction");
  await input.press("Alt+Enter");
  await expect(input).toHaveValue("");
  await input.fill("then summarize");
  await input.press("Control+Enter");
  await expect
    .poll(() => session.submitted)
    .toEqual([
      { content: "start the turn", delivery: "immediate" },
      { content: "change direction", delivery: "steer" },
      { content: "then summarize", delivery: "followUp" },
    ]);
  const pending = page.getByLabel("Pending messages");
  await expect(pending.getByText("change direction", { exact: true })).toBeVisible();
  await expect(pending.getByText("then summarize", { exact: true })).toBeVisible();
  await expect(pending.getByText("steer", { exact: true })).toBeVisible();
  await expect(pending.getByText("queue", { exact: true })).toBeVisible();
  session.deliverPending();
  await expect(pending).toHaveCount(0);

  session.snapshot.isRunning = false;
  session.server.broadcast();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByText("idle", { exact: true })).toBeVisible();

  await input.fill("meta starts another turn");
  await input.press("Meta+Enter");
  await expect(input).toHaveValue("");
  await input.fill("meta queues a follow-up");
  await input.press("Meta+Enter");
  await expect
    .poll(() => session.submitted.slice(-2))
    .toEqual([
      { content: "meta starts another turn", delivery: "immediate" },
      { content: "meta queues a follow-up", delivery: "followUp" },
    ]);
});

test("opens send options with right-click and mobile long press", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  session.snapshot.isRunning = true;
  session.server.broadcast();
  const input = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Steer message" });

  await input.fill("queue from context menu");
  await send.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Send options" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Queue follow-up" }).click();
  await expect
    .poll(() => session.submitted.at(-1))
    .toEqual({
      content: "queue from context menu",
      delivery: "followUp",
    });

  await input.fill("keyboard menu");
  await send.focus();
  await send.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Steer now" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Queue follow-up" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(send).toBeFocused();

  await input.fill("queue from long press");
  await send.dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.waitForTimeout(600);
  await send.dispatchEvent("pointerup", { pointerType: "touch", button: 0 });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Queue follow-up" }).click();
  await expect
    .poll(() => session.submitted.at(-1))
    .toEqual({
      content: "queue from long press",
      delivery: "followUp",
    });

  await input.fill("next tap steers");
  await send.click();
  await expect
    .poll(() => session.submitted.at(-1))
    .toEqual({ content: "next tap steers", delivery: "steer" });
});

test("preserves a draft when server admission rejects stale browser state", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);
  const input = page.getByRole("textbox", { name: "Message" });
  session.snapshot.isRunning = true;

  await input.fill("keep this draft");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Pi is busy; choose Steer or Queue", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("keep this draft");
  expect(session.submitted).toHaveLength(0);
});

test("does not erase a newer draft when an earlier send is accepted", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  const input = page.getByRole("textbox", { name: "Message" });
  session.setSubmissionDelay(150);

  await input.fill("slow first prompt");
  await page.getByRole("button", { name: "Send message" }).click();
  await input.fill("new draft while sending");
  await expect.poll(() => session.submitted).toHaveLength(1);
  await expect(input).toHaveValue("new draft while sending");
});

test("offers RPC-compatible file completion through the canonical provider", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);
  session.useFallbackCompletion();
  const input = page.getByRole("textbox", { name: "Message" });

  await input.fill("Review @app");
  const option = page.getByRole("option", { name: /app\.js/ });
  await expect(option).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("Review @web/app.js ");

  await input.fill("Review @app");
  await expect(page.getByRole("option", { name: /app\.js/ })).toBeVisible();
  for (let index = 0; index < 12; index += 1) await input.press("ArrowLeft");
  await expect
    .poll(() => input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart))
    .toBe(0);
  await expect(page.getByRole("option", { name: /app\.js/ })).toHaveCount(0);
  await input.press("Tab");
  await expect(input).toHaveValue("Review @app");

  await input.fill('Review @"space"');
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(14, 14));
  await input.dispatchEvent("select");
  await expect(page.getByRole("option", { name: /space file\.txt/ })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue('Review @"space file.txt" ');

  await input.fill('Review @"dir');
  await expect(page.getByRole("option", { name: /dir name\// })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue('Review @"dir name/"');
  await input.type("child");
  await expect(page.getByRole("option", { name: /child\.txt/ })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue('Review @"dir name/child.txt" ');

  await input.fill("Review @many");
  await expect(page.getByRole("option", { name: /file-00\.txt/ })).toBeVisible();
  for (let index = 0; index < 15; index += 1) await input.press("ArrowDown");
  const active = page.getByRole("option", { selected: true });
  await expect(active).toContainText("file-15.txt");
  expect(
    await active.evaluate((element) => {
      const option = element.getBoundingClientRect();
      const list = element.parentElement!.getBoundingClientRect();
      return option.top >= list.top && option.bottom <= list.bottom;
    }),
  ).toBe(true);
  await input.press("Escape");
  await page.waitForTimeout(200);
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("docks the sticky composer at the bottom for a short session", async ({ page, session }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  session.snapshot.entries.length = 0;
  session.snapshot.leafId = null;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(session.bootstrapUrl);
  await expect(page).toHaveTitle("π – Playwright fixture");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();

  await expect
    .poll(() =>
      page.locator(".composer").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return window.innerHeight - rect.bottom;
      }),
    )
    .toBeLessThanOrEqual(20);
});

test("keeps a long pending queue usable on mobile", async ({ page, session }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await openSession(page, session.bootstrapUrl);
  session.snapshot.isRunning = true;
  session.snapshot.pendingInputs = Array.from({ length: 40 }, (_, index) => ({
    id: `mobile-pending-${index}`,
    content: `Pending mobile message ${index}`,
    delivery: index % 2 === 0 ? ("steer" as const) : ("followUp" as const),
  }));
  session.server.broadcast();

  const pending = page.getByLabel("Pending messages");
  await expect(pending).toBeVisible();
  expect(await pending.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  expect(
    await page.getByRole("button", { name: "Steer message" }).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }),
  ).toBe(true);
});

test("keeps thinking and compaction disclosures independently operable", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);

  const thinking = page.getByRole("button", { name: "thinking... (click to expand)" });
  await thinking.click();
  const expandedThinking = page.getByRole("button", { name: "Collapse thinking" });
  await expect(expandedThinking).toHaveAttribute("aria-expanded", "true");
  await expandedThinking.press("Enter");
  await expect(thinking).toBeVisible();

  await page.getByText("Compacted from 12,345 tokens", { exact: true }).click();
  await expect(page.getByText("Earlier work was summarized here.", { exact: true })).toBeVisible();
  await expect(thinking).toBeVisible();
});

test("offers keyboard-complete command palette behavior", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Display settings" });
  await expect(palette).toBeVisible();
  const thinking = palette.getByRole("button", { name: /^thinking / });
  const tools = palette.getByRole("button", { name: /^tool output / });
  await expect(thinking).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(tools).toBeFocused();
  await page.keyboard.press("Space");
  await expect(tools).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("follows live growth only while the reader remains at the bottom", async ({
  page,
  session,
}) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  await openSession(page, session.bootstrapUrl);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.locator(".composer-dock")).toHaveCSS("position", "fixed");
  const composerBottom = await page
    .locator(".composer")
    .evaluate((element) => element.getBoundingClientRect().bottom);

  session.appendUserMessage("Followed at the bottom");
  await expect(page.getByText("Followed at the bottom", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(2);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect
    .poll(() =>
      page.locator(".composer").evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBe(composerBottom);
  const bottomButton = page.getByRole("button", { name: "Scroll to bottom" });
  await expect(bottomButton).toBeVisible();
  expect(
    await bottomButton.evaluate((button) => {
      const buttonRect = button.getBoundingClientRect();
      const composerRect = document.querySelector(".composer")!.getBoundingClientRect();
      return composerRect.top - buttonRect.bottom;
    }),
  ).toBeGreaterThanOrEqual(10);
  session.appendUserMessage("Preserved below the viewport");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole("button", { name: "Scroll to bottom" }).click();
  await expect(page.getByText("Preserved below the viewport", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
});

test("wraps long paths without widening the page on mobile", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  const longPath =
    "/var/folders/3_/hp4nl8v920364pxvzx8rx2m40000gn/T/TemporaryItems/NSIRD_screencaptureui_" +
    "JQfDho/Screenshot\\ 2026-07-26\\ at\\ 00.06.11.png";
  const longSessionPath =
    "/Users/tudoroancea/.pi/agent/sessions/--Users-tudoroancea-dotfiles--/" +
    "2026-07-25T17-21-15-285Z_019f9a4b-a015-7980-b0b9-a7a4ff0e6d31.jsonl";
  session.snapshot.entries.push(
    {
      id: "entry-long-path",
      parentId: session.snapshot.leafId,
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting a deeply nested artifact" },
          {
            type: "toolCall",
            id: "tc-long-read",
            name: "read",
            arguments: { file_path: longPath },
          },
          {
            type: "toolCall",
            id: "tc-long-review",
            name: "agentflow_review",
            arguments: { task: "Review screenshots" },
          },
        ],
      },
    } as never,
    {
      id: "entry-long-result",
      parentId: "entry-long-path",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-long-review",
        toolName: "agentflow_review",
        content: [{ type: "text", text: `- Fully captured screenshot at:\n  ${longPath}` }],
        isError: false,
      },
    } as never,
  );
  session.snapshot.leafId = "entry-long-result";
  session.appendUserMessage(`Session file: ${longSessionPath}`);

  await page.setViewportSize({ width: 390, height: 760 });
  await page.keyboard.press("e");
  await expect(
    page.getByText("Inspecting a deeply nested artifact", { exact: true }),
  ).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  const wrappingContent = [
    page.locator(".tool-path").first(),
    page.locator(".agentflow-result .markdown-content li").first(),
    page.locator(".user-message").last(),
  ];
  await expect(wrappingContent[0]).toContainText("NSIRD_screencaptureui");
  await expect(wrappingContent[1]).toContainText("NSIRD_screencaptureui");
  await expect(wrappingContent[2]).toContainText("019f9a4b-a015-7980-b0b9-a7a4ff0e6d31");
  for (const element of wrappingContent) {
    expect(await element.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(
      36,
    );
  }
});
