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
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
  session.appendUserMessage("Preserved below the viewport");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole("button", { name: "Scroll to bottom" }).click();
  await expect(page.getByText("Preserved below the viewport", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
});
