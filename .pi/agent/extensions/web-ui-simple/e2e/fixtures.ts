import { expect as playwrightExpect, test as base, type Page } from "@playwright/test";
import { startServer, type Snapshot, type WebUiServer } from "../index.js";

const BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);

interface SessionFixture {
  server: WebUiServer;
  snapshot: Snapshot;
  bootstrapUrl: string;
  appendUserMessage(text: string): void;
}

interface Fixtures {
  session: SessionFixture;
}

function entry(id: string, message: unknown, index: number): unknown {
  return {
    id,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(BASE_TIME + index * 1_000).toISOString(),
    type: "message",
    message,
  };
}

function initialSnapshot(): Snapshot {
  const entries: unknown[] = [
    entry(
      "entry-0",
      {
        role: "user",
        content: [{ type: "text", text: "Deterministic browser fixture" }],
        timestamp: BASE_TIME,
      },
      0,
    ),
    entry(
      "entry-1",
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "A private line of reasoning" },
          { type: "text", text: "A visible assistant response" },
        ],
        timestamp: BASE_TIME + 1_000,
      },
      1,
    ),
    {
      id: "entry-2",
      parentId: "entry-1",
      timestamp: new Date(BASE_TIME + 2_000).toISOString(),
      type: "compaction",
      summary: "Earlier work was summarized here.",
      tokensBefore: 12_345,
    },
  ];

  for (let index = 3; index < 55; index += 1) {
    entries.push(
      entry(
        `entry-${index}`,
        {
          role: "user",
          content: [{ type: "text", text: `Scrollable fixture message ${index}` }],
          timestamp: BASE_TIME + index * 1_000,
        },
        index,
      ),
    );
  }

  return {
    header: { id: "e2e-session-12345678" },
    leafId: "entry-54",
    sessionName: "Playwright fixture",
    isRunning: false,
    workingWord: undefined,
    theme: undefined,
    systemPrompt: "You are the deterministic test assistant.",
    entries,
  };
}

export const test = base.extend<Fixtures>({
  // Playwright requires fixture dependencies to use an object destructuring pattern.
  // oxlint-disable-next-line no-empty-pattern
  session: async ({}, use) => {
    const snapshot = initialSnapshot();
    const server = await startServer(() => snapshot);
    let nextIndex = snapshot.entries.length;
    const fixture: SessionFixture = {
      server,
      snapshot,
      bootstrapUrl: server.bootstrapUrl(),
      appendUserMessage(text) {
        const id = `entry-${nextIndex}`;
        snapshot.entries.push(
          entry(
            id,
            {
              role: "user",
              content: [{ type: "text", text }],
              timestamp: BASE_TIME + nextIndex * 1_000,
            },
            nextIndex,
          ),
        );
        snapshot.leafId = id;
        nextIndex += 1;
        server.broadcast();
      },
    };
    try {
      await use(fixture);
    } finally {
      await server.close();
    }
  },
});

export async function openSession(page: Page, bootstrapUrl: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(bootstrapUrl);
  await page.getByText("Deterministic browser fixture", { exact: true }).waitFor();
  await playwrightExpect(page).toHaveTitle("π – Playwright fixture");
}

export { expect } from "@playwright/test";
