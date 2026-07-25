import { expect, test, openAuthenticatedSession } from "./fixtures.js";

test("bootstraps the built app into an authenticated live session", async ({
  page,
  context,
  bootstrapUrl,
}) => {
  const secret = new URL(bootstrapUrl).hash;
  expect(secret).toMatch(/^#bootstrap=.+/);

  const bootstrapExchange = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/bootstrap",
  );
  const socket = await openAuthenticatedSession(page, bootstrapUrl);
  expect((await bootstrapExchange).status()).toBe(204);

  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain(secret);
  expect(socket.url()).toBe(new URL("ws", page.url()).href.replace(/^http/, "ws"));

  const cookies = await context.cookies(page.url());
  expect(cookies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: expect.stringMatching(/^pi_web_ui_/),
        httpOnly: true,
        sameSite: "Strict",
      }),
    ]),
  );

  const intro = page.getByRole("region", { name: "Session details" });
  await expect(intro).toBeVisible();
  await expect(intro.getByText("fixture-model", { exact: true })).toBeVisible();
  await expect(intro.getByText("/home/e2e/project", { exact: true })).toBeVisible();
  await expect(intro.getByText("session e2e-sess", { exact: true })).toBeVisible();
  await expect(page.getByText("Deterministic browser fixture", { exact: true })).toBeVisible();

  expect(await intro.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  expect(await intro.evaluate((element) => element.closest("main") !== null)).toBe(true);
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
});
