import { fileURLToPath } from "node:url";
import { test as base, type Page } from "@playwright/test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startWebUiServer, type WebUiRuntime } from "../src/server/server.js";

interface WebUiFixtures {
  runtime: WebUiRuntime;
  bootstrapUrl: string;
}

const generation = "e2e-generation-0001";

function extensionContext(): ExtensionContext {
  const branch = [
    {
      id: "entry-e2e-1",
      parentId: null,
      timestamp: "2026-01-02T03:04:05.000Z",
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Deterministic browser fixture" }],
        timestamp: 1_767_323_045_000,
      },
    },
  ];

  return {
    mode: "tui",
    cwd: "/home/e2e/project",
    model: {
      provider: "fixture-provider",
      id: "fixture-model",
      name: "Fixture Model",
    },
    thinkingLevel: "medium",
    sessionManager: {
      getSessionId: () => "e2e-session-12345678",
      getBranch: () => branch,
      getLeafId: () => "entry-e2e-1",
    },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 256, contextWindow: 16_384, percent: 2 }),
    abort: () => undefined,
  } as unknown as ExtensionContext;
}

export const test = base.extend<WebUiFixtures>({
  // Playwright requires fixture dependencies to use an object destructuring pattern.
  // oxlint-disable-next-line no-empty-pattern
  runtime: async ({}, use) => {
    const runtime = await startWebUiServer({
      pi: {
        sendUserMessage: () => undefined,
        getActiveTools: () => ["read", "bash"],
        getCommands: () => [],
      },
      context: extensionContext(),
      config: {
        bindHost: "127.0.0.1",
        port: 0,
        basePath: "/",
        authenticationMode: "standalone",
        allowedOrigins: new Set(),
        framing: { frameAncestors: ["'none'"] },
      },
      assetRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)),
      generation,
    });

    try {
      await use(runtime);
    } finally {
      await runtime.close();
    }
  },
  bootstrapUrl: async ({ runtime }, use) => {
    await use(runtime.createBootstrapUrl());
  },
});

export async function openAuthenticatedSession(page: Page, bootstrapUrl: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const websocket = page.waitForEvent("websocket");
  await page.goto(bootstrapUrl);
  const socket = await websocket;
  await page.getByRole("status").getByText("Connected", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Session details" }).waitFor();
  return socket;
}

export { expect } from "@playwright/test";
