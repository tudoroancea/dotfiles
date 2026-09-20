import type { Locator } from "@playwright/test";
import { startServer, type Snapshot } from "../src/index.js";
import { expect, openSession, test } from "./fixtures.js";

function minimalSnapshot(): Snapshot {
  return {
    header: { id: "lifecycle-session" },
    leafId: null,
    sessionName: "Lifecycle fixture",
    isRunning: false,
    workingWord: undefined,
    theme: undefined,
    systemPrompt: "",
    metadata: undefined,
    pendingInputs: [],
    entries: [],
  };
}

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

test("serves strict security headers under a random nested base path", async ({
  page,
  session,
}) => {
  const response = await page.goto(session.bootstrapUrl);
  const headers = response!.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("img-src 'self' https:");
  expect(csp).not.toContain("data:");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-inline");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(new URL(session.server.url).pathname).toMatch(/^\/[A-Za-z0-9_-]{20,}\/$/);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
});

test("edits and removes broker-owned pending rows without combining neighboring items", async ({
  page,
}) => {
  const snapshot: Snapshot = {
    ...minimalSnapshot(),
    sessionName: "Playwright fixture",
    isRunning: true,
    pendingInputBroker: { edit: true, remove: true },
    pendingInputs: [
      {
        id: "broker-row-1",
        content: "duplicate text",
        delivery: "steer",
        itemVersion: 1,
        editable: true,
        state: "held",
      },
      {
        id: "broker-row-2",
        content: "duplicate text",
        delivery: "followUp",
        itemVersion: 1,
        editable: true,
        state: "held",
      },
    ],
    entries: [],
  };
  let server: Awaited<ReturnType<typeof startServer>>;
  server = await startServer(() => snapshot, {
    submitInput: async () => ({ accepted: false, error: "unused" }),
    mutatePendingInput: async (command) => {
      const row = snapshot.pendingInputs.find((item) => item.id === command.itemId);
      if (!row || row.itemVersion !== command.expectedItemVersion)
        return { accepted: false, error: "Pending input changed", reason: "stale-item" };
      if (command.type === "queue-edit") {
        row.content = command.content;
        row.itemVersion += 1;
      } else {
        snapshot.pendingInputs = snapshot.pendingInputs.filter((item) => item.id !== row.id);
      }
      server.broadcast();
      return { accepted: true };
    },
  });
  try {
    await openSession(page, server.bootstrapUrl());
    await expect(page.getByText("duplicate text", { exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Edit pending message 1 of 2" }).click();
    const editor = page.getByRole("textbox", { name: "Edit Steer message 1 of 2" });
    await editor.fill("edited first row");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("edited first row", { exact: true })).toBeVisible();
    await expect(page.getByText("duplicate text", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Edit pending message 1 of 2" }).click();
    const preserved = page.getByRole("textbox", { name: "Edit Steer message 1 of 2" });
    await preserved.fill("preserved draft after conflict");
    snapshot.pendingInputs[0]!.itemVersion = 3;
    await page.getByRole("button", { name: "Save" }).click();
    await expect(preserved).toHaveValue("preserved draft after conflict");
    await expect(page.getByRole("status")).toContainText("changed");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Remove pending message 2 of 2" }).click();
    await expect(page.getByText("duplicate text", { exact: true })).toHaveCount(0);
    await expect(page.getByText("edited first row", { exact: true })).toBeVisible();
  } finally {
    await server.close();
  }
});

test("requires an exact authorized Origin for browser mutations", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  const valid = await page.request.post(`${session.server.url}complete`, {
    headers: { Origin: session.server.origin },
    data: {
      version: 1,
      type: "completion-request",
      generation: session.server.generation,
      query: "@fixture",
    },
  });
  expect(valid.status()).toBe(200);

  const wrongScheme = await page.request.post(`${session.server.url}complete`, {
    headers: { Origin: session.server.origin.replace("http:", "https:") },
    data: {
      version: 1,
      type: "completion-request",
      generation: session.server.generation,
      query: "@fixture",
    },
  });
  expect(wrongScheme.status()).toBe(403);

  const missingOrigin = await page.request.post(`${session.server.url}complete`, {
    data: { query: "@fixture" },
  });
  expect(missingOrigin.status()).toBe(403);
  const nullOrigin = await page.request.post(`${session.server.url}input`, {
    headers: { Origin: "null" },
    data: { content: "must not submit", delivery: "immediate" },
  });
  expect(nullOrigin.status()).toBe(403);

  const notEventSource = await page.request.get(`${session.server.url}events`);
  expect(notEventSource.status()).toBe(406);
  const foreignEventSource = await page.request.get(`${session.server.url}events`, {
    headers: { Accept: "text/event-stream", Origin: "https://example.com" },
  });
  expect(foreignEventSource.status()).toBe(403);
});

test("rejects malformed strict command and completion requests", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  const post = (route: string, data: unknown) =>
    page.request.post(`${session.server.url}${route}`, {
      headers: { Origin: session.server.origin },
      data,
    });

  for (const data of [
    { content: "missing delivery" },
    { content: "hello", delivery: "later" },
    { content: "hello", delivery: "immediate", extra: true },
    { content: "   ", delivery: "immediate" },
    { content: "😀".repeat(10_000), delivery: "immediate" },
  ]) {
    expect((await post("input", data)).status()).toBe(400);
  }
  expect((await post("complete", {})).status()).toBe(400);
  expect(
    (
      await post("queue", {
        version: 1,
        type: "queue-edit",
        commandId: "bad-queue",
        generation: session.server.generation,
        commandEpoch: session.server.commandEpoch,
        itemId: "row",
        expectedItemVersion: 1,
        content: "edited",
        extra: true,
      })
    ).status(),
  ).toBe(400);
  expect((await post("complete", { query: "@fixture", extra: true })).status()).toBe(400);
  expect((await post("complete", { query: "😀".repeat(2_000) })).status()).toBe(400);
});

test("echoes explicit command identity and rejects conflicting command ID reuse", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);
  const post = (data: unknown) =>
    page.request.post(`${session.server.url}input`, {
      headers: { Origin: session.server.origin },
      data,
    });
  const command = {
    version: 1,
    type: "command",
    commandId: "idempotent-command",
    generation: session.server.generation,
    commandEpoch: session.server.commandEpoch,
    content: "accepted exactly once",
    delivery: "immediate",
  };
  const accepted = await post(command);
  expect(accepted.status()).toBe(202);
  expect(await accepted.json()).toEqual({
    version: 1,
    type: "command-response",
    commandId: command.commandId,
    generation: command.generation,
    commandEpoch: command.commandEpoch,
    accepted: true,
  });
  const replay = await post(command);
  expect(replay.status()).toBe(202);
  expect(session.submitted.filter((item) => item.content === command.content)).toHaveLength(1);

  const conflict = await post({ ...command, content: "conflicting reuse" });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({
    commandId: command.commandId,
    generation: command.generation,
    commandEpoch: command.commandEpoch,
    accepted: false,
  });
});

test("bounds unresolved command admissions and rejects saturation", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  session.setSubmissionDelay(1_000);
  const commandEpoch = session.server.commandEpoch;
  const requests = Array.from({ length: 128 }, (_, index) =>
    page.request.post(`${session.server.url}input`, {
      headers: { Origin: session.server.origin },
      data: {
        version: 1,
        type: "command",
        commandId: `saturated-command-${index}`,
        generation: session.server.generation,
        commandEpoch,
        content: `queued admission ${index}`,
        delivery: "immediate",
      },
    }),
  );
  await expect
    .poll(async () => {
      const response = await page.request.post(`${session.server.url}input`, {
        headers: { Origin: session.server.origin },
        data: {
          version: 1,
          type: "command",
          commandId: "saturated-command-overflow",
          generation: session.server.generation,
          commandEpoch,
          content: "must be bounded",
          delivery: "immediate",
        },
      });
      return response.status();
    })
    .toBe(503);

  const resetStarted = Date.now();
  session.server.reset("cancel saturated admissions");
  const responses = await Promise.all(requests);
  expect(Date.now() - resetStarted).toBeLessThan(500);
  expect(responses.every((response) => response.status() === 409)).toBe(true);
  expect(session.submitted).toHaveLength(0);
});

test("rejects commands scoped to the branch before a reset", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  const staleEpoch = session.server.commandEpoch;
  session.server.reset("branch changed");
  expect(session.server.commandEpoch).not.toBe(staleEpoch);

  const stale = await page.request.post(`${session.server.url}input`, {
    headers: { Origin: session.server.origin },
    data: {
      version: 1,
      type: "command",
      commandId: "stale-branch-command",
      generation: session.server.generation,
      commandEpoch: staleEpoch,
      content: "must not reach the replacement branch",
      delivery: "immediate",
    },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({
    commandId: "stale-branch-command",
    commandEpoch: staleEpoch,
    accepted: false,
  });
  expect(session.submitted).toHaveLength(0);
});

test("loads bundled assets without any request leaving the loopback origin", async ({
  page,
  session,
}) => {
  const origin = session.server.origin;
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      external.push(url);
    }
  });
  await openSession(page, session.bootstrapUrl);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  expect(external).toEqual([]);
  // The theme is applied through the CSSOM, so no inline <style> element exists.
  expect(await page.locator("style").count()).toBe(0);
});

test("reports disconnect and cleans up when the server shuts down", async ({ browser }) => {
  const snapshot = minimalSnapshot();
  const server = await startServer(() => snapshot);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(server.bootstrapUrl());
    await expect(page.getByText("idle", { exact: true })).toBeVisible();
    await server.close();
    await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await server.close();
  }
});

test("snapshot freshness polling does not serialize unchanged full snapshots", async ({
  browser,
}) => {
  let serializations = 0;
  const snapshot = minimalSnapshot();
  snapshot.entries = [
    {
      toJSON() {
        serializations += 1;
        return { id: "serialization-probe", role: "custom" };
      },
    },
  ];
  const server = await startServer(() => snapshot);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(server.bootstrapUrl());
    await expect(page.getByText("idle", { exact: true })).toBeVisible();
    const initialSerializations = serializations;

    await page.waitForTimeout(1_100);
    expect(serializations).toBe(initialSerializations);

    snapshot.isRunning = true;
    snapshot.workingWord = "freshness-probe";
    await expect(page.getByText("freshness-probe", { exact: true })).toBeVisible();
    expect(serializations).toBe(initialSerializations);

    let cyclicSerializations = 0;
    const cyclicWireValue: { self?: unknown } = {};
    cyclicWireValue.self = cyclicWireValue;
    snapshot.entries = [
      {
        id: "cyclic",
        timestamp: 1,
        toJSON() {
          cyclicSerializations += 1;
          return cyclicWireValue;
        },
      },
    ];
    snapshot.workingWord = "rejected-cyclic";
    await page.waitForTimeout(1_100);
    expect(cyclicSerializations).toBe(1);

    let oversizedSerializations = 0;
    snapshot.entries = [
      {
        id: "oversized",
        timestamp: 2,
        toJSON() {
          oversizedSerializations += 1;
          return { payload: "x".repeat(17 * 1024 * 1024) };
        },
      },
    ];
    snapshot.workingWord = "rejected-oversized";
    await page.waitForTimeout(1_100);
    expect(oversizedSerializations).toBe(1);
  } finally {
    await context.close();
    await server.close();
  }
});

test("snapshot streams skip invalid frames and reject an invalid initial snapshot", async ({
  browser,
}) => {
  const snapshot = minimalSnapshot();
  const server = await startServer(() => snapshot);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(server.bootstrapUrl());
    await expect(page.getByText("idle", { exact: true })).toBeVisible();

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    snapshot.entries = [cyclic];
    expect(() => server.broadcast()).not.toThrow();
    await page.waitForTimeout(600);

    snapshot.entries = [];
    snapshot.header = {
      toJSON() {
        return "invalid serialized header";
      },
    };
    snapshot.workingWord = "must-not-reach-the-browser";
    expect(() => server.broadcast()).not.toThrow();
    await page.waitForTimeout(600);
    await expect(page.getByText("must-not-reach-the-browser", { exact: true })).toHaveCount(0);

    snapshot.header = { id: "recovered-session" };
    snapshot.isRunning = true;
    snapshot.workingWord = "recovered";
    server.broadcast();
    await expect(page.getByText("recovered", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await server.close();
  }

  const malformed = { ...minimalSnapshot(), isRunning: "invalid" } as unknown as Snapshot;
  const invalidServer = await startServer(() => malformed);
  const invalidContext = await browser.newContext();
  const invalidPage = await invalidContext.newPage();
  try {
    await invalidPage.goto(invalidServer.bootstrapUrl());
    await expect(invalidPage).not.toHaveURL(/#code=/);
    const response = await invalidPage.request.get(`${invalidServer.url}events`, {
      headers: { Accept: "text/event-stream", Origin: invalidServer.origin },
    });
    expect(response.status()).toBe(500);
  } finally {
    await invalidContext.close();
    await invalidServer.close();
  }
});

test("expands read, write, and edit tool detail with the tool-output preference", async ({
  page,
  session,
}) => {
  session.snapshot.entries.push(
    {
      id: "rwe-call",
      parentId: session.snapshot.leafId,
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-r",
            name: "read",
            arguments: { path: "/tmp/read-me.txt" },
          },
          {
            type: "toolCall",
            id: "tc-w",
            name: "write",
            arguments: { file_path: "/tmp/write-me.txt", content: "alpha\nbeta\ngamma" },
          },
          {
            type: "toolCall",
            id: "tc-e",
            name: "edit",
            arguments: {
              file_path: "/tmp/edit-me.txt",
              edits: [{ oldText: "old", newText: "new" }],
            },
          },
        ],
      },
    } as never,
    {
      id: "rwe-read-result",
      parentId: "rwe-call",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-r",
        toolName: "read",
        content: [{ type: "text", text: "read line 0\nread line 1\nread line 2" }],
        isError: false,
      },
    } as never,
    {
      id: "rwe-write-result",
      parentId: "rwe-read-result",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-w",
        toolName: "write",
        content: [{ type: "text", text: "wrote file" }],
        isError: false,
      },
    } as never,
    {
      id: "rwe-edit-result",
      parentId: "rwe-write-result",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-e",
        toolName: "edit",
        content: [{ type: "text", text: "applied" }],
        details: { diff: "--- a/tmp/edit-me.txt\n+++ b/tmp/edit-me.txt\n-old\n+new\n context" },
        isError: false,
      },
    } as never,
  );
  session.snapshot.leafId = "rwe-edit-result";
  await openSession(page, session.bootstrapUrl);

  // Collapsed by default: no read output, no write content, no diff.
  await expect(page.getByText("read line 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("alpha", { exact: true })).toHaveCount(0);
  await expect(page.locator(".tool-diff")).toHaveCount(0);

  await page.keyboard.press("e");

  await expect(page.locator(".tool-path").filter({ hasText: "read-me.txt" })).toBeVisible();
  await expect(page.getByText("read line 2", { exact: true })).toBeVisible();
  await expect(page.getByText("alpha", { exact: true })).toBeVisible();
  await expect(page.locator(".tool-diff")).toBeVisible();
  await expect(page.locator(".diff-added").filter({ hasText: "+new" })).toBeVisible();
});

test("anchors global tool expansion at the pointer with a centered fallback", async ({
  page,
  session,
}) => {
  const entries: unknown[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < 40; index += 1) {
    const callEntryId = `anchor-call-entry-${index}`;
    const resultEntryId = `anchor-result-entry-${index}`;
    const toolCallId = `anchor-tool-call-${index}`;
    entries.push(
      {
        id: callEntryId,
        parentId,
        timestamp: new Date(Date.UTC(2026, 0, 2, 4, index)).toISOString(),
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: toolCallId,
              name: "read",
              arguments: { path: `/tmp/anchor-${index}.txt` },
            },
          ],
        },
      },
      {
        id: resultEntryId,
        parentId: callEntryId,
        timestamp: new Date(Date.UTC(2026, 0, 2, 4, index, 1)).toISOString(),
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "read",
          content: [
            {
              type: "text",
              text: Array.from({ length: 24 }, (_, line) => `anchor ${index} line ${line}`).join(
                "\n",
              ),
            },
          ],
          isError: false,
        },
      },
    );
    parentId = resultEntryId;
  }
  session.snapshot.entries = entries as never[];
  session.snapshot.leafId = parentId;

  await page.setViewportSize({ width: 1000, height: 700 });
  await openSession(page, session.bootstrapUrl);
  await page.evaluate(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.round(max * 0.45));
  });
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();

  const headerNearest = async (requestedLine?: number) =>
    page.evaluate((requestedLine) => {
      const composerTop = document.querySelector(".composer-dock")!.getBoundingClientRect().top;
      const readingLine = requestedLine ?? composerTop / 2;
      const headers = Array.from(document.querySelectorAll<HTMLElement>(".tool-header")).filter(
        (header) => {
          const rect = header.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < composerTop;
        },
      );
      const header = headers.reduce((closest, candidate) => {
        const candidateRect = candidate.getBoundingClientRect();
        const closestRect = closest.getBoundingClientRect();
        return Math.abs((candidateRect.top + candidateRect.bottom) / 2 - readingLine) <
          Math.abs((closestRect.top + closestRect.bottom) / 2 - readingLine)
          ? candidate
          : closest;
      });
      const rect = header.getBoundingClientRect();
      return {
        path: header.querySelector(".tool-path")!.textContent!,
        top: rect.top,
        pointerX: rect.left + 20,
        pointerY: (rect.top + rect.bottom) / 2,
      };
    }, requestedLine);

  const expandedAnchor = await headerNearest(120);
  const expandedHeader = page.locator(".tool-header", { hasText: expandedAnchor.path }).first();
  const scrollBeforeExpand = await page.evaluate(() => window.scrollY);
  await page.mouse.move(expandedAnchor.pointerX, expandedAnchor.pointerY);
  await page.keyboard.press("e");
  await expect(
    expandedHeader.getByRole("button", { name: /Collapse read tool call/ }),
  ).toBeVisible();
  const expandedDistance = () =>
    expandedHeader.evaluate(
      (header, top) => Math.abs(header.getBoundingClientRect().top - top),
      expandedAnchor.top,
    );
  await expect.poll(expandedDistance).toBeLessThanOrEqual(3);
  await page.waitForTimeout(1_050);
  expect(await expandedDistance()).toBeLessThanOrEqual(3);
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(scrollBeforeExpand);
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();

  // Moving over the fixed composer clears the transcript pointer and exercises
  // the centered fallback for keyboard use.
  await page.mouse.move(10, 680);
  const collapsedAnchor = await headerNearest();
  const collapsedHeader = page.locator(".tool-header", { hasText: collapsedAnchor.path }).first();
  await page.keyboard.press("e");
  await expect(
    collapsedHeader.getByRole("button", { name: /Expand read tool call/ }),
  ).toBeVisible();
  const collapsedDistance = () =>
    collapsedHeader.evaluate(
      (header, top) => Math.abs(header.getBoundingClientRect().top - top),
      collapsedAnchor.top,
    );
  await expect.poll(collapsedDistance).toBeLessThanOrEqual(3);
  await page.waitForTimeout(1_050);
  expect(await collapsedDistance()).toBeLessThanOrEqual(3);
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();

  // Explicit keyboard navigation takes ownership immediately instead of being
  // pulled back to the global expansion anchor during its settle window.
  await page.keyboard.press("e");
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.waitForTimeout(1_050);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("expands bash, read, write, and edit tool calls per call by clicking the box", async ({
  page,
  session,
}) => {
  const longCommand =
    "printf 'first\\n' && sleep 1\nsecond-command --flag with plenty of trailing arguments that make this command long enough to be compacted with an ellipsis";
  session.snapshot.entries.push(
    {
      id: "click-call",
      parentId: session.snapshot.leafId,
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-bash",
            name: "bash",
            arguments: { command: longCommand },
          },
          {
            type: "toolCall",
            id: "tc-r",
            name: "read",
            arguments: { path: "/tmp/read-me.txt" },
          },
          {
            type: "toolCall",
            id: "tc-w",
            name: "write",
            arguments: { file_path: "/tmp/write-me.txt", content: "alpha\nbeta\ngamma" },
          },
          {
            type: "toolCall",
            id: "tc-e",
            name: "edit",
            arguments: {
              file_path: "/tmp/edit-me.txt",
              edits: [{ oldText: "old", newText: "new" }],
            },
          },
        ],
      },
    } as never,
    {
      id: "click-bash-result",
      parentId: "click-call",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-bash",
        toolName: "bash",
        content: [{ type: "text", text: "bash output line 1\nbash output line 2" }],
        isError: false,
      },
    } as never,
    {
      id: "click-read-result",
      parentId: "click-bash-result",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-r",
        toolName: "read",
        content: [
          {
            type: "text",
            text: Array.from({ length: 14 }, (_, i) => `read line ${i}`).join("\n"),
          },
        ],
        isError: false,
      },
    } as never,
    {
      id: "click-write-result",
      parentId: "click-read-result",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-w",
        toolName: "write",
        content: [{ type: "text", text: "wrote file" }],
        isError: false,
      },
    } as never,
    {
      id: "click-edit-result",
      parentId: "click-write-result",
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-e",
        toolName: "edit",
        content: [{ type: "text", text: "applied" }],
        details: { diff: "--- a/tmp/edit-me.txt\n+++ b/tmp/edit-me.txt\n-old\n+new\n context" },
        isError: false,
      },
    } as never,
  );
  session.snapshot.leafId = "click-edit-result";
  await openSession(page, session.bootstrapUrl);

  const bashBox = page.locator(".tool-execution", { hasText: "printf 'first" });
  const readBox = page.locator(".tool-execution", { hasText: "read-me.txt" });
  const writeBox = page.locator(".tool-execution", { hasText: "write-me.txt" });
  const editBox = page.locator(".tool-execution", { hasText: "edit-me.txt" });
  const toggleIn = (box: Locator) => box.getByRole("button", { name: /tool call/ });

  // Collapsed by default: headers and summaries only, bash command compacted.
  await expect(toggleIn(bashBox)).toHaveAttribute("aria-expanded", "false");
  await expect(bashBox.locator(".tool-argument")).toContainText("...");
  await expect(bashBox.locator(".tool-argument")).not.toContainText("compacted with an ellipsis");
  await expect(page.getByText("bash output line 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("read line 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("alpha", { exact: true })).toHaveCount(0);
  await expect(page.locator(".tool-diff")).toHaveCount(0);
  // Clicking the bash box expands the full command and the output.
  await bashBox.click();
  await expect(toggleIn(bashBox)).toHaveAttribute("aria-expanded", "true");
  await expect(bashBox.locator(".tool-argument")).toContainText("compacted with an ellipsis");
  await expect(bashBox.locator(".tool-argument")).not.toContainText("...");
  await expect(bashBox.getByText("bash output line 2", { exact: true })).toBeVisible();
  await expect(bashBox.getByText("2 output lines", { exact: true })).toHaveCount(0);

  // Other calls stay collapsed while the bash call is expanded.
  await expect(toggleIn(readBox)).toHaveAttribute("aria-expanded", "false");
  await expect(toggleIn(writeBox)).toHaveAttribute("aria-expanded", "false");
  await expect(toggleIn(editBox)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("read line 2", { exact: true })).toHaveCount(0);

  // Each remaining call expands independently by clicking its box.
  await readBox.click();
  await expect(toggleIn(readBox)).toHaveAttribute("aria-expanded", "true");
  await expect(readBox.getByRole("button", { name: "Collapse read tool call" })).toBeVisible();
  // Two states only: the full output appears at once, with no excerpt hint.
  await expect(page.getByText("read line 13", { exact: true })).toBeVisible();
  await expect(page.getByText(/more lines/)).toHaveCount(0);

  await writeBox.click();
  await expect(toggleIn(writeBox)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("alpha", { exact: true })).toBeVisible();

  await editBox.click();
  await expect(toggleIn(editBox)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".tool-diff")).toBeVisible();

  // A drag-selection click inside the box leaves it expanded: selecting text
  // stays possible without collapsing the call.
  const boxRect = await readBox.boundingBox();
  expect(boxRect).not.toBeNull();
  await page.mouse.move(boxRect!.x + 20, boxRect!.y + 12);
  await page.mouse.down();
  await page.mouse.move(boxRect!.x + 140, boxRect!.y + 34, { steps: 5 });
  await page.mouse.up();
  await expect(toggleIn(readBox)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("read line 2", { exact: true })).toBeVisible();

  // The header disclosure button is keyboard-operable: Enter collapses the
  // bash call, Space expands it again.
  const bashToggle = toggleIn(bashBox);
  await bashToggle.focus();
  await bashToggle.press("Enter");
  await expect(bashToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("bash output line 1", { exact: true })).toHaveCount(0);
  await bashToggle.press("Space");
  await expect(bashToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("bash output line 1", { exact: true })).toBeVisible();

  // Collapsing the read call leaves write and edit expanded.
  await readBox.click();
  await expect(toggleIn(readBox)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("read line 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("alpha", { exact: true })).toBeVisible();
  await expect(page.locator(".tool-diff")).toBeVisible();
});

test("expands agentflow and background tool calls per call by clicking the box", async ({
  page,
  session,
}) => {
  session.snapshot.entries.push(
    {
      id: "afb-call",
      parentId: session.snapshot.leafId,
      timestamp: new Date().toISOString(),
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
    } as never,
    {
      id: "afb-af-result",
      parentId: "afb-call",
      timestamp: new Date().toISOString(),
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
    } as never,
    {
      id: "afb-bg-result",
      parentId: "afb-af-result",
      timestamp: new Date().toISOString(),
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
    } as never,
  );
  session.snapshot.leafId = "afb-bg-result";
  await openSession(page, session.bootstrapUrl);

  const afBox = page.locator(".tool-execution", { hasText: "Review the screenshots" });
  const bgBox = page.locator(".tool-execution", { hasText: "npm test" });
  const toggleIn = (box: Locator) => box.getByRole("button", { name: /tool call/ });

  // Collapsed by default: headers, the child's tool calls (as in the TUI) and a
  // compact status line, but no run metadata and no job details.
  await expect(toggleIn(afBox)).toHaveAttribute("aria-expanded", "false");
  await expect(toggleIn(bgBox)).toHaveAttribute("aria-expanded", "false");
  await expect(afBox.locator(".agentflow-live-run")).toBeVisible();
  await expect(afBox.locator(".tool-facts")).toHaveCount(0);
  await expect(page.locator(".background-job")).toHaveCount(0);
  await expect(afBox.getByText(/Review the screenshots/)).toBeVisible();
  await expect(bgBox.getByText(/npm test/)).toBeVisible();
  await expect(
    afBox.getByText(/✓ completed · claude\/opus · 2 findings · 3 tools · 12\.3k tokens/),
  ).toBeVisible();
  await expect(bgBox.getByText(/◆ running · 1 job · click to expand/)).toBeVisible();

  // Clicking anywhere on the agentflow box expands it: run metadata joins the
  // tool calls, and the status line offers to collapse it again.
  await afBox.click();
  await expect(toggleIn(afBox)).toHaveAttribute("aria-expanded", "true");
  await expect(afBox.locator(".tool-facts")).toBeVisible();
  await expect(afBox.getByText("run-1", { exact: true })).toBeVisible();
  await expect(afBox.getByText(/click to collapse/)).toBeVisible();

  // Clicking plain text in the expanded box collapses it again.
  await afBox.locator(".tool-header").click();
  await expect(toggleIn(afBox)).toHaveAttribute("aria-expanded", "false");
  await expect(afBox.locator(".tool-facts")).toHaveCount(0);

  // The background box expands by clicking anywhere and opens the job list.
  await bgBox.click();
  await expect(toggleIn(bgBox)).toHaveAttribute("aria-expanded", "true");
  await expect(bgBox.locator(".background-job")).toBeVisible();
  await expect(bgBox.getByText("PASS suite", { exact: true })).toBeVisible();
  await bgBox.locator(".tool-details-body").click();
  await expect(toggleIn(bgBox)).toHaveAttribute("aria-expanded", "false");
  await expect(bgBox.locator(".background-job")).toHaveCount(0);

  // The header disclosure button is keyboard-operable: Enter expands the
  // agentflow call, Space collapses it.
  const afToggle = toggleIn(afBox);
  await afToggle.focus();
  await afToggle.press("Enter");
  await expect(afToggle).toHaveAttribute("aria-expanded", "true");
  await expect(afBox.locator(".tool-facts")).toBeVisible();
  await afToggle.press("Space");
  await expect(afToggle).toHaveAttribute("aria-expanded", "false");
  await expect(afBox.locator(".tool-facts")).toHaveCount(0);

  // The global tool-output preference drives the box default for these tools.
  await page.keyboard.press("e");
  await expect(toggleIn(afBox)).toHaveAttribute("aria-expanded", "true");
  await expect(toggleIn(bgBox)).toHaveAttribute("aria-expanded", "true");
  await expect(afBox.locator(".tool-facts")).toBeVisible();
  await expect(bgBox.locator(".background-job")).toBeVisible();
  await page.keyboard.press("e");
  await expect(toggleIn(afBox)).toHaveAttribute("aria-expanded", "false");
  await expect(toggleIn(bgBox)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".background-job")).toHaveCount(0);
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
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("button", { name: /timestamps/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("model control route fences, deduplicates, and applies authoritative changes", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);
  session.enableModelControl();
  const base = {
    version: 1 as const,
    generation: session.server.generation,
    commandEpoch: session.server.commandEpoch,
  };
  const post = (body: unknown) =>
    page.evaluate(async (value) => {
      const response = await fetch("model-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      return { status: response.status, body: await response.json() };
    }, body);

  expect((await post({ nope: true })).status).toBe(400);
  const thinking = {
    ...base,
    type: "set-thinking" as const,
    commandId: "thinking-command",
    thinkingLevel: "medium" as const,
  };
  const admitted = await post(thinking);
  expect(admitted).toMatchObject({
    status: 202,
    body: { type: "command-response", accepted: true },
  });
  expect((await post(thinking)).body).toEqual(admitted.body);
  expect(session.modelControls).toHaveLength(1);

  const reused = await post({ ...thinking, thinkingLevel: "low" });
  expect(reused.status).toBe(409);
  expect(reused.body).toMatchObject({ accepted: false, reason: "invalid" });
  expect(session.modelControls).toHaveLength(1);

  const stale = await post({ ...thinking, commandId: "stale", generation: "stale" });
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ accepted: false, reason: "session-changed" });

  const model = await post({
    ...base,
    type: "set-model",
    commandId: "model-command",
    provider: "test",
    modelId: "alternate-model",
  });
  expect(model.status).toBe(202);
  expect(session.snapshot.metadata?.model?.id).toBe("alternate-model");
  expect(session.server.commandEpoch).not.toBe(base.commandEpoch);
  const oldEpochReplay = await post({
    ...base,
    type: "set-model",
    commandId: "model-command",
    provider: "test",
    modelId: "alternate-model",
  });
  expect(oldEpochReplay.status).toBe(409);
  expect(oldEpochReplay.body).toMatchObject({ accepted: false, reason: "session-changed" });
  expect(session.modelControls).toHaveLength(2);

  session.snapshot.modelControl = undefined;
  session.server.broadcast();
  const unavailable = await post({
    version: 1 as const,
    generation: session.server.generation,
    commandEpoch: session.server.commandEpoch,
    type: "set-thinking" as const,
    commandId: "capability-off",
    thinkingLevel: "low" as const,
  });
  expect(unavailable.status).toBe(409);
  expect(unavailable.body).toMatchObject({ accepted: false, reason: "capability-off" });
});

test("standalone transport rejects malformed model-control responses", async ({
  page,
  session,
}) => {
  session.enableModelControl();
  await openSession(page, session.bootstrapUrl);
  const malformed = [
    { accepted: false, error: "Missing reason" },
    { accepted: false, error: "Wrong reason", reason: "not-a-reason" },
    { accepted: false, error: "Wrong identity", reason: "invalid", commandId: "wrong" },
  ];
  await page.route("**/model-control", async (route) => {
    const command = route.request().postDataJSON();
    const response = malformed.shift();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        type: "command-response",
        commandId: command.commandId,
        generation: command.generation,
        commandEpoch: command.commandEpoch,
        ...response,
      }),
    });
  });
  await page.keyboard.press("Alt+KeyM");
  const dialog = page.getByRole("dialog", { name: "Model settings" });
  const alternate = dialog.getByRole("button", { name: "test/alternate-model" });
  for (let index = 0; index < 3; index += 1) {
    await alternate.click();
    await expect(dialog).toBeVisible();
    await expect(alternate).not.toHaveAttribute("aria-current", "true");
  }
});

test("model and thinking shortcuts apply immediately and keep the compact selector open", async ({
  page,
  session,
}) => {
  session.enableModelControl();
  await openSession(page, session.bootstrapUrl);
  await page.keyboard.press("Alt+KeyM");

  const dialog = page.getByRole("dialog", { name: "Model settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("Fixture Model");
  await expect(dialog.locator(".model-control-status")).toHaveCount(0);

  const current = dialog.getByRole("button", { name: "test/fixture-model" });
  const alternate = dialog.getByRole("button", { name: "test/alternate-model" });
  const authoritativeStatus = dialog.getByRole("status");
  await page.keyboard.press("j");
  await expect(dialog).toBeVisible();
  await expect(alternate).toHaveAttribute("aria-current", "true");
  await expect(alternate).toBeFocused();
  await expect(authoritativeStatus).toHaveText("Model test/alternate-model");
  await page.keyboard.press("ArrowUp");
  await expect(current).toHaveAttribute("aria-current", "true");
  await expect(current).toBeFocused();
  await expect(authoritativeStatus).toHaveText("Model test/fixture-model");

  const slider = dialog.getByRole("slider", { name: "Thinking" });
  await page.keyboard.press("h");
  await expect(dialog).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuetext", "medium");
  await expect(slider).toHaveAttribute("data-thinking-level", "medium");
  await expect(authoritativeStatus).toHaveText("Thinking level medium");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "high");
});

test("model control route normalizes malformed rejection reasons", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  session.enableModelControl();
  const post = (commandId: string) =>
    page.evaluate(
      async ({ commandId, generation, commandEpoch }) => {
        const response = await fetch("model-control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: 1,
            generation,
            commandEpoch,
            type: "set-thinking",
            commandId,
            thinkingLevel: "medium",
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      {
        commandId,
        generation: session.server.generation,
        commandEpoch: session.server.commandEpoch,
      },
    );

  for (const [commandId, acceptance] of [
    ["missing-reason", { accepted: false, error: "Missing" }],
    ["wrong-reason", { accepted: false, error: "Wrong", reason: "not-a-reason" }],
    ["malformed-rejection", { accepted: false, error: 42, reason: null }],
  ] as const) {
    session.setModelControlAcceptance(acceptance);
    await expect(post(commandId)).resolves.toMatchObject({
      status: 409,
      body: { accepted: false, reason: "invalid" },
    });
  }
});

test("delayed racing model controls use one handoff lane", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  session.enableModelControl();
  session.setModelControlDelay(100);

  const race = (commands: readonly Record<string, unknown>[]) =>
    page.evaluate(async (values) => {
      return Promise.all(
        values.map(async (value, index) => {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, index * 20));
          const response = await fetch("model-control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(value),
          });
          return { status: response.status, body: await response.json() };
        }),
      );
    }, commands);
  const base = () => ({
    version: 1 as const,
    generation: session.server.generation,
    commandEpoch: session.server.commandEpoch,
  });

  const modelRace = await race([
    {
      ...base(),
      type: "set-model",
      commandId: "model-race-first",
      provider: "test",
      modelId: "alternate-model",
    },
    {
      ...base(),
      type: "set-model",
      commandId: "model-race-second",
      provider: "test",
      modelId: "fixture-model",
    },
  ]);
  expect(modelRace.filter(({ body }) => body.accepted)).toHaveLength(1);
  expect(modelRace.find(({ body }) => !body.accepted)?.body.reason).toBe("session-changed");
  expect(session.modelControls).toHaveLength(1);
  expect(session.modelControlMaxConcurrency).toBe(1);

  const nextBase = base();
  const mixedRace = await race([
    {
      ...nextBase,
      type: "set-model",
      commandId: "mixed-race-model",
      provider: "test",
      modelId: "fixture-model",
    },
    {
      ...nextBase,
      type: "set-thinking",
      commandId: "mixed-race-thinking",
      thinkingLevel: "medium",
    },
  ]);
  expect(mixedRace.filter(({ body }) => body.accepted)).toHaveLength(1);
  expect(mixedRace.find(({ body }) => !body.accepted)?.body.reason).toBe("session-changed");
  expect(session.modelControls).toHaveLength(2);
  expect(session.modelControlMaxConcurrency).toBe(1);
  expect(session.snapshot.metadata?.thinkingLevel).not.toBe("medium");
});

test("model control admission is cancelled by a reset", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  session.enableModelControl();
  session.setModelControlDelay(1_000);
  const pending = page.evaluate(
    async (command) => {
      const response = await fetch("model-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      return { status: response.status, body: await response.json() };
    },
    {
      version: 1,
      generation: session.server.generation,
      commandEpoch: session.server.commandEpoch,
      type: "set-thinking",
      commandId: "cancelled-thinking",
      thinkingLevel: "medium",
    },
  );
  await page.waitForTimeout(50);
  session.server.reset("test reset");
  const cancelled = await pending;
  expect(cancelled.status).toBe(409);
  expect(cancelled.body).toMatchObject({ accepted: false });
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
  await expect(page.locator(".composer")).toHaveAttribute("data-thinking-level", "high");

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
  await expect(page.locator(".composer")).toHaveAttribute("data-thinking-level", "medium");
  await expect
    .poll(() =>
      page.locator(".composer").evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.borderColor = "var(--thinkingMedium)";
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return getComputedStyle(element).borderTopColor === expected;
      }),
    )
    .toBe(true);
  session.snapshot.metadata.thinkingLevel = "xhigh";
  session.server.broadcast();
  await expect(page.locator(".composer")).toHaveAttribute("data-thinking-level", "xhigh");
  await expect
    .poll(() =>
      page.locator(".composer").evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.borderColor = "var(--thinkingXhigh)";
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return getComputedStyle(element).borderTopColor === expected;
      }),
    )
    .toBe(true);

  session.snapshot.metadata.model = {
    provider: "next",
    id: "long-model",
    name: `model-${"x".repeat(240)}`,
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

test("shows eventual command completion and failure after authoritative admission", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);
  const input = page.getByRole("textbox", { name: "Message" });

  await input.fill("complete this turn");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  session.completeLast("completed");
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();

  session.snapshot.isRunning = false;
  session.server.broadcast();
  await input.fill("fail this turn");
  await page.getByRole("button", { name: "Send message" }).click();
  session.completeLast("failed", "Fixture turn failed");
  await expect(page.getByText("Fixture turn failed", { exact: true })).toBeVisible();
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

test("offers fallback file completion in the shared composer", async ({ page, session }) => {
  await openSession(page, session.bootstrapUrl);
  session.useFallbackCompletion();
  const input = page.getByRole("textbox", { name: "Message" });

  await input.fill("Review @app");
  const option = page.getByRole("option", { name: /app\.js/ });
  await expect(option).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("Review @dist/client/assets/app.js ");
  await expect
    .poll(() => input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart))
    .toBe(34);

  await input.fill("Review @app");
  await expect(page.getByRole("option", { name: /app\.js/ })).toBeVisible();
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 0));
  await input.dispatchEvent("select");
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
  await expect
    .poll(() => input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart))
    .toBe(25);

  await input.fill('Review @"dir');
  await expect(page.getByRole("option", { name: /dir name\// })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue('Review @"dir name/"');
  await expect
    .poll(() => input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart))
    .toBe(18);
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
  await page.evaluate(() => window.scrollTo(0, 0));

  const thinking = page.getByRole("button", { name: "thinking... (click to expand)" });
  await thinking.click();
  const expandedThinking = page.getByRole("button", { name: "Collapse thinking" });
  await expect(expandedThinking).toHaveAttribute("aria-expanded", "true");
  await expandedThinking.press("Enter");
  await expect(thinking).toBeVisible();

  await page.getByText("Compacted from 12,345 tokens", { exact: true }).click();
  const compactionContent = page.getByText("Earlier work was summarized here.", { exact: true });
  await expect(compactionContent).toBeVisible();
  await compactionContent.click();
  await expect(compactionContent).toHaveCount(0);
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

  await page.keyboard.press("t");
  await expect(thinking).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(tools).toBeFocused();
  await page.keyboard.press("Space");
  await expect(tools).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("e");
  await expect(tools).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("Escape unfocuses the composer and ? opens the shortcut cheat sheet", async ({
  page,
  session,
}) => {
  await openSession(page, session.bootstrapUrl);

  const input = page.getByRole("textbox", { name: "Message" });
  const cheatsheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });

  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).not.toBeFocused();

  // Typing ? inside the editor inserts the character instead of opening the dialog.
  await input.click();
  await page.keyboard.type("?");
  await expect(cheatsheet).toHaveCount(0);
  await expect(input).toHaveValue("?");

  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await expect(cheatsheet).toBeVisible();

  // The dialog opens without stealing focus; Escape still closes it.
  await expect(cheatsheet).not.toBeFocused();

  // Preference rows and their displayed hotkeys toggle the same persisted state.
  const thinking = cheatsheet.getByRole("button", { name: /^thinking / });
  await expect(thinking).toHaveAttribute("aria-pressed", "false");
  await thinking.click();
  await expect(thinking).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("t");
  await expect(thinking).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Escape");
  await expect(cheatsheet).toHaveCount(0);

  // The plain-key toggle continues to work once the cheat sheet is closed.
  await page.keyboard.press("t");
  await page.keyboard.press("?");
  await expect(cheatsheet.getByRole("button", { name: /^thinking / })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(cheatsheet).toHaveCount(0);
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

test("settles the very first open exactly at the bottom even when rows measure far taller than estimated", async ({
  page,
  session,
}) => {
  session.populateLarge(300);
  // Make the final entries very tall so measured heights grow far beyond the
  // virtualizer's 96px estimate, stretching the initial measurement race over
  // many frames (regression: the first open used to rest a few entries above
  // the bottom once the last rows measured taller).
  const entries = session.snapshot.entries as {
    id: string;
    message: { role?: string; content: unknown[] };
  }[];
  for (let index = entries.length - 4; index < entries.length; index += 1) {
    const lines = Array.from({ length: 80 }, (_, i) => `tall line ${i} of the final entry`);
    entries[index]!.message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: lines.join("\n") },
        { type: "text", text: lines.join("\n") },
      ],
    };
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await openSession(page, session.bootstrapUrl);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(page.getByText(/tall line 79 of the final entry/).last()).toBeVisible();
});

test("restores a persisted mid-transcript position after a reload", async ({ page, session }) => {
  session.populateLarge(300);
  await page.setViewportSize({ width: 1000, height: 700 });
  await openSession(page, session.bootstrapUrl);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(2);
  const target = await page.evaluate(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return Math.round(max * 0.4);
  });
  await page.evaluate((y) => window.scrollTo(0, y), target);
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("pi-web-ui:scroll:" + location.pathname) ?? "null")?.y as
            | number
            | undefined,
      ),
    )
    .toBeGreaterThanOrEqual(target - 1);
  await page.reload();
  await expect(page).toHaveTitle("π – Playwright fixture");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(target - 2);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(target + 2);
});

test("keeps the bottom across a reload that left off at the bottom", async ({ page, session }) => {
  session.populateLarge(300);
  await page.setViewportSize({ width: 1000, height: 700 });
  await openSession(page, session.bootstrapUrl);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("pi-web-ui:scroll:" + location.pathname) ?? "null")
            ?.atBottom === true,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(page).toHaveTitle("π – Playwright fixture");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(2);
});

test("bounds and anchors multi-thousand-row history with distinct browser timings", async ({
  page,
  session,
}) => {
  session.populateLarge(3_000);
  await page.setViewportSize({ width: 390, height: 760 });
  await openSession(page, session.bootstrapUrl);
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  expect(await page.locator(".message-row").count()).toBeLessThan(60);

  const historyRequest = page.waitForRequest(
    (request) => request.url().endsWith("/history") && request.method() === "POST",
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  const request = await historyRequest;
  const oldHistoryRequest = request.postDataJSON();
  await expect(page.getByText(/Large fixture message 2799/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".message-row").count()).toBeLessThan(60);

  const thinking = page.getByRole("button", { name: "thinking... (click to expand)" }).first();
  await expect(thinking).toBeVisible();
  const beforeHeight = await page
    .locator(".messages-viewport")
    .evaluate((element) => element.scrollHeight);
  await thinking.click();
  await expect
    .poll(() => page.locator(".messages-viewport").evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(beforeHeight);

  const readingOffset = await page.evaluate(() => window.scrollY);
  session.appendUserMessage("Live growth while reading older history");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(readingOffset);
  expect(await page.locator(".message-row").count()).toBeLessThan(60);

  const metrics = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __webUiMetrics?: { timings: Record<string, { count: number }> };
        }
      ).__webUiMetrics,
  );
  expect(metrics).toBeTruthy();
  for (const stage of ["jsonParse", "schemaValidation", "reducerApplication", "renderCommit"]) {
    expect(metrics!.timings[stage].count).toBeGreaterThan(0);
  }

  session.server.reset("same-runtime branch reset");
  const stale = await page.request.post(`${session.server.url}history`, {
    headers: { Origin: session.server.origin },
    data: oldHistoryRequest,
  });
  expect(stale.status()).toBe(409);
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
            arguments: { path: longPath },
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
    // An agentflow result with no readable run snapshot falls back to the tool's
    // own text, which must wrap like any other tool output.
    page.locator(".tool-execution", { hasText: "Review screenshots" }).locator(".tool-output"),
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
