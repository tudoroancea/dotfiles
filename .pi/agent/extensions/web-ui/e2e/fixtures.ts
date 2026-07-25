import { fileURLToPath } from "node:url";
import { expect as playwrightExpect, test as base, type Page } from "@playwright/test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startWebUiServer, type WebUiRuntime } from "../src/server/server.js";

interface BranchState {
  branch: unknown[];
  leafId: string | null;
  sessionId: string;
}

export interface SessionController {
  runtime: WebUiRuntime;
  bootstrapUrl: string;
  /** Swaps the active branch and rotates history like a session-tree change. */
  resetBranch(branch: unknown[], leafId: string | null, sessionId: string): void;
  /** Persists a completed tool pair onto the current branch without rotating lineage. */
  persistTool(toolCallId: string): void;
  /** Delivers a live server event (e.g. a new finalized message). */
  broadcast: WebUiRuntime["broadcast"];
}

interface WebUiFixtures {
  runtime: WebUiRuntime;
  bootstrapUrl: string;
  largeSession: SessionController;
  cspGuard: void;
}

const generation = "e2e-generation-0001";
const BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);

function context(state: BranchState): ExtensionContext {
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
      getSessionId: () => state.sessionId,
      getBranch: () => state.branch,
      getLeafId: () => state.leafId,
    },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 256, contextWindow: 16_384, percent: 2 }),
    abort: () => undefined,
  } as unknown as ExtensionContext;
}

function smokeBranch(): BranchState {
  return {
    sessionId: "e2e-session-12345678",
    leafId: "entry-e2e-1",
    branch: [
      {
        id: "entry-e2e-1",
        parentId: null,
        timestamp: new Date(BASE_TIME).toISOString(),
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Deterministic browser fixture" }],
          timestamp: BASE_TIME,
        },
      },
    ],
  };
}

/**
 * A deterministic, mixed-height branch: short user turns, tall assistant prose,
 * and bash tool call/result pairs with variable output lengths.
 */
export function buildBranch(count: number, prefix: string, label: string): BranchState {
  const branch: unknown[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${index}`;
    const timestamp = new Date(BASE_TIME + index * 1_000).toISOString();
    const ts = BASE_TIME + index * 1_000;
    const kind = index % 4;
    let message: Record<string, unknown>;
    if (kind === 0) {
      message = {
        role: "user",
        content: [{ type: "text", text: `${label} request ${index}` }],
        timestamp: ts,
      };
    } else if (kind === 1) {
      const body = Array.from({ length: (index % 6) + 2 }, (_, line) => `paragraph ${line}`).join(
        "\n\n",
      );
      message = {
        role: "assistant",
        content: [{ type: "text", text: `${label} reply ${index}\n\n${body}` }],
        timestamp: ts,
      };
    } else if (kind === 2) {
      message = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `tc-${prefix}-${index}`,
            name: "bash",
            arguments: { command: `echo run ${index}` },
          },
        ],
        timestamp: ts,
      };
    } else {
      const lines = Array.from(
        { length: (index % 7) + 1 },
        (_, line) => `output line ${line} for ${index}`,
      ).join("\n");
      message = {
        role: "toolResult",
        toolCallId: `tc-${prefix}-${index - 1}`,
        toolName: "bash",
        content: [{ type: "text", text: lines }],
        isError: false,
      };
    }
    branch.push({ id, parentId, timestamp, type: "message", message });
    parentId = id;
  }
  return { branch, leafId: parentId, sessionId: `${prefix}-session-abcdef12` };
}

async function startRuntime(state: BranchState): Promise<WebUiRuntime> {
  return startWebUiServer({
    pi: {
      sendUserMessage: () => undefined,
      getActiveTools: () => ["read", "bash"],
      getCommands: () => [],
    },
    context: context(state),
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
}

export const test = base.extend<WebUiFixtures>({
  cspGuard: [
    async ({ page }, use) => {
      const consoleRefusals: string[] = [];
      page.on("console", (message) => {
        const text = message.text();
        if (
          /content security policy|refused to apply.*style|violat(?:es|ed).*style-src/i.test(text)
        ) {
          consoleRefusals.push(text);
        }
      });
      await page.addInitScript(() => {
        const target = window as Window & { __styleCspViolations?: string[] };
        target.__styleCspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          if (event.effectiveDirective.startsWith("style-src")) {
            target.__styleCspViolations!.push(
              `${event.effectiveDirective}: ${event.blockedURI || "inline"}`,
            );
          }
        });
      });
      await use();
      const violations = page.isClosed()
        ? ["Page closed before CSP assertions"]
        : await page.evaluate(
            () =>
              (window as Window & { __styleCspViolations?: string[] }).__styleCspViolations ?? [],
          );
      playwrightExpect(violations, "securitypolicyviolation events").toEqual([]);
      playwrightExpect(consoleRefusals, "console CSP style refusals").toEqual([]);
    },
    { auto: true },
  ],
  // Playwright requires fixture dependencies to use an object destructuring pattern.
  // oxlint-disable-next-line no-empty-pattern
  runtime: async ({}, use) => {
    const runtime = await startRuntime(smokeBranch());
    try {
      await use(runtime);
    } finally {
      await runtime.close();
    }
  },
  bootstrapUrl: async ({ runtime }, use) => {
    await use(runtime.createBootstrapUrl());
  },
  // oxlint-disable-next-line no-empty-pattern
  largeSession: async ({}, use) => {
    const state = buildBranch(2400, "big", "User");
    const runtime = await startRuntime(state);
    const controller: SessionController = {
      runtime,
      bootstrapUrl: runtime.createBootstrapUrl(),
      resetBranch(branch, leafId, sessionId) {
        state.branch = branch;
        state.leafId = leafId;
        state.sessionId = sessionId;
        runtime.broadcast("session_tree", {});
      },
      persistTool(toolCallId) {
        const parentId = state.leafId;
        const callId = `persisted-call-${toolCallId}`;
        const resultId = `persisted-result-${toolCallId}`;
        state.branch = [
          ...state.branch,
          {
            id: callId,
            parentId,
            timestamp: new Date(BASE_TIME + state.branch.length * 1_000).toISOString(),
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "bash",
                  arguments: { command: "echo live" },
                },
              ],
              timestamp: BASE_TIME + state.branch.length * 1_000,
            },
          },
          {
            id: resultId,
            parentId: callId,
            timestamp: new Date(BASE_TIME + (state.branch.length + 1) * 1_000).toISOString(),
            type: "message",
            message: {
              role: "toolResult",
              toolCallId,
              toolName: "bash",
              content: [{ type: "text", text: "persisted live result" }],
              isError: false,
            },
          },
        ];
        state.leafId = resultId;
        runtime.broadcast("agent_settled", {});
      },
      broadcast: runtime.broadcast.bind(runtime),
    };
    try {
      await use(controller);
    } finally {
      await runtime.close();
    }
  },
});

export async function openAuthenticatedSession(page: Page, bootstrapUrl: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const websocket = page.waitForEvent("websocket");
  const response = await page.goto(bootstrapUrl);
  assertProductionStylePolicy(response?.headers()["content-security-policy"] ?? "");
  const socket = await websocket;
  await page.getByRole("status").getByText("Connected", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Session details" }).waitFor();
  return socket;
}

/**
 * Opens a large paged session where the history head is a loader, not the
 * intro. Waits on connection and a non-empty measured transcript.
 */
export async function openLargeSession(page: Page, bootstrapUrl: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const websocket = page.waitForEvent("websocket");
  const response = await page.goto(bootstrapUrl);
  assertProductionStylePolicy(response?.headers()["content-security-policy"] ?? "");
  const socket = await websocket;
  await page.getByRole("status").getByText("Connected", { exact: true }).waitFor();
  await page.locator(".timeline-region").waitFor();
  await page.locator("[data-row-key]").first().waitFor();
  return socket;
}

function assertProductionStylePolicy(policy: string): void {
  playwrightExpect(policy).toContain("style-src 'self'");
  playwrightExpect(policy).not.toContain("'unsafe-inline'");
  playwrightExpect(policy).not.toMatch(/style-src[^;]*'nonce-/);
}

export { expect } from "@playwright/test";
