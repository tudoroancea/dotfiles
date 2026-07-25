import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, openLargeSession, test } from "./fixtures.js";

/** Attach diagnostic images without treating platform font rasterization as a baseline. */
async function assertParity(page: Page, testInfo: TestInfo, size: "desktop" | "mobile") {
  const scroller = page.locator(".timeline-scroll");
  const nextPaint = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  const seek = async (id: string): Promise<Locator> => {
    const locator = page.locator(`[data-tool-id="${id}"]`);
    const height = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
    for (let step = 0; step <= 30; step += 1) {
      await scroller.evaluate(
        (node, top) => {
          node.scrollTop = top;
        },
        (height * step) / 30,
      );
      await nextPaint();
      if ((await locator.count()) > 0) return locator;
    }
    throw new Error(`Tool ${id} was not mounted while scanning the virtual transcript`);
  };

  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.locator('.message[data-role="user"]')).toContainText(
    "Exercise exporter tool formatting",
  );
  await expect(page.locator('.message[data-role="assistant"] .prose')).toContainText(
    "Export parity",
  );

  const bodyMetrics = await page.locator("body").evaluate((node) => {
    const style = getComputedStyle(node);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight };
  });
  expect(bodyMetrics).toEqual({ fontSize: "12px", lineHeight: "18px" });
  const transcriptBox = await page.locator(".timeline").boundingBox();
  expect(transcriptBox).not.toBeNull();
  expect(transcriptBox!.width).toBe(size === "desktop" ? 800 : 358);
  const assistantPadding = await page
    .locator('.message[data-role="assistant"] .prose')
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        top: style.paddingTop,
        right: style.paddingRight,
        bottom: style.paddingBottom,
        left: style.paddingLeft,
      };
    });
  expect(assistantPadding).toEqual({ top: "18px", right: "18px", bottom: "0px", left: "18px" });

  const tools = [
    "bash-short",
    "bash-long",
    "read-short",
    "read-long",
    "write-short",
    "write-long",
    "edit-diff",
    "ls-long",
    "bash-error",
    "generic-fallback",
  ];
  for (const id of tools) await expect(await seek(id)).toBeVisible();

  const short = await seek("bash-short");
  await expect(short.locator('[aria-label="bash output"]')).toHaveText("short");
  await expect(short.locator(".ansi-output__hint")).toHaveCount(0);
  const toolMetrics = await short.evaluate((node) => {
    const style = getComputedStyle(node);
    return { padding: style.paddingTop, background: style.backgroundColor };
  });
  expect(toolMetrics.padding).toBe("18px");
  expect(toolMetrics.background).not.toBe("rgba(0, 0, 0, 0)");

  const error = await seek("bash-error");
  await expect(error).toHaveClass(/tool--error/);
  const errorBackground = await error.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(errorBackground).not.toBe(toolMetrics.background);
  const errorHeaderColors = await error.evaluate((node) => ({
    glyph: getComputedStyle(node.querySelector(".tool__glyph")!).color,
    title: getComputedStyle(node.querySelector(".tool__title")!).color,
  }));
  expect(errorHeaderColors.glyph).toBe(errorHeaderColors.title);

  const generic = await seek("generic-fallback");
  await expect(generic.locator(".tool__head")).toHaveJSProperty("tagName", "DIV");
  await expect(generic.locator(".tool__head")).not.toHaveAttribute("tabindex");
  await expect(generic.locator('[aria-label="custom_unknown output"]')).toBeVisible();
  await expect(generic.locator('[aria-label="custom_unknown output"] code')).toHaveCount(0);

  const bashTool = await seek("bash-long");
  const bash = bashTool.locator(".exporter-output");
  await expect(bashTool.locator(".tool__status")).toHaveCount(0);
  await expect(bashTool.locator(".tool__summary")).toHaveCount(0);
  await expect(bashTool.locator(".tool__head")).toHaveJSProperty("tagName", "DIV");
  await expect(bashTool.locator(".tool__head")).not.toHaveAttribute("tabindex");
  await expect(bash).toHaveAttribute("aria-expanded", "false");
  await expect(bash.locator(".ansi-output__hint")).toHaveText("... (3 more lines)");
  await expect(bash.locator(".ansi-line")).toHaveCount(6);

  const readShort = await seek("read-short");
  await expect(readShort.locator('[aria-label="read output"] .hljs-keyword').first()).toHaveText(
    "export",
  );
  const mixedOrder = await readShort.evaluate((node) => {
    const image = node.querySelector(".image")!;
    const output = node.querySelector('[aria-label="read output"]')!;
    return image.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(mixedOrder).not.toBe(0);
  await expect(readShort.locator('[aria-label="read output"] code')).toContainText(
    "export const ok = true;",
  );

  const readImage = await seek("read-short");
  const imageSpacing = await readImage.evaluate((tool) => {
    const header = tool.querySelector<HTMLElement>(".tool__head")!;
    const image = tool.querySelector<HTMLElement>(".image")!;
    return Math.round(image.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
  });
  expect(imageSpacing).toBe(18);

  const read = await seek("read-long");
  await expect(read.locator(".tool__path")).toHaveText("~/project/range.ts");
  await expect(read.locator(".tool__range")).toHaveText(":5-14");
  await expect(read.locator(".ansi-output__hint")).toHaveText("... (3 more lines)");
  const readHeaderStyles = await read.evaluate((node) => {
    const bar = node.querySelector(".tool__bar")!;
    const range = node.querySelector(".tool__range")!;
    const path = node.querySelector(".tool__path")!;
    return {
      gap: Number.parseFloat(getComputedStyle(bar).columnGap),
      rangeColor: getComputedStyle(range).color,
      pathColor: getComputedStyle(path).color,
    };
  });
  expect(readHeaderStyles.gap).toBeGreaterThan(7);
  expect(readHeaderStyles.gap).toBeLessThan(8);
  expect(readHeaderStyles.rangeColor).not.toBe(readHeaderStyles.pathColor);

  const write = await seek("write-long");
  await expect(write.locator(".tool__hint")).toHaveText(" (13 lines)");
  await expect(write.locator(".ansi-output__hint")).toHaveText("... (3 more lines)");
  await expect(write).toContainText("Wrote src/long.ts");

  const edit = await seek("edit-diff");
  await expect(edit.locator(".diff__line--removed")).toContainText("-old value");
  await expect(edit).not.toContainText("Applied 1 edit");
  const editGeometry = await edit.evaluate((node) => {
    const header = node.querySelector(".tool__head")!.getBoundingClientRect();
    const diff = node.querySelector(".diff")!.getBoundingClientRect();
    const body = node.querySelector(".tool__body")!;
    return {
      headerToDiff: diff.top - header.bottom,
      marginTop: getComputedStyle(body).marginTop,
    };
  });
  expect(editGeometry).toEqual({ headerToDiff: 0, marginTop: "0px" });

  const ls = await seek("ls-long");
  await expect(ls.locator(".tool__hint")).toHaveText(" (limit 50)");
  await expect(ls.locator(".ansi-output__hint")).toHaveText("... (3 more lines)");

  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.locator('.message[data-role="user"]')).toBeVisible();
  await testInfo.attach(`${size}-initial-top.png`, {
    body: await scroller.screenshot(),
    contentType: "image/png",
  });

  const expandedBash = (await seek("bash-long")).locator(".exporter-output");
  await expandedBash.click();
  await expect(expandedBash).toHaveAttribute("aria-expanded", "true");
  await expect(expandedBash.locator(".ansi-output__hint")).toHaveCount(0);
  await expect(expandedBash.locator(".ansi-line")).toHaveCount(8);
  await testInfo.attach(`${size}-bash-expanded.png`, {
    body: await page.locator('[data-tool-id="bash-long"]').screenshot(),
    contentType: "image/png",
  });

  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await nextPaint();
  await testInfo.attach(`${size}-bottom.png`, {
    body: await scroller.screenshot(),
    contentType: "image/png",
  });
}

test("desktop exporter parity", async ({ page, parityUrl }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await openLargeSession(page, parityUrl);
  await assertParity(page, testInfo, "desktop");
});

test("mobile exporter parity", async ({ page, parityUrl }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLargeSession(page, parityUrl);
  await assertParity(page, testInfo, "mobile");
});

test("intermediate viewport keeps the exporter 800px transcript measure", async ({
  page,
  parityUrl,
}) => {
  await page.setViewportSize({ width: 880, height: 900 });
  await openLargeSession(page, parityUrl);
  const transcriptBox = await page.locator(".timeline").boundingBox();
  expect(transcriptBox).not.toBeNull();
  expect(transcriptBox!.width).toBe(800);
});
