import { execFileSync } from "node:child_process";
import { expect as playwrightExpect, test as base, type Page } from "@playwright/test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import {
  fallbackFileCompletions,
  mentionCompletions,
  startServer,
  type Snapshot,
  type WebUiServer,
} from "../index.js";

const BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);

interface SubmittedInput {
  content: string;
  delivery: "immediate" | "steer" | "followUp";
}

interface SessionFixture {
  server: WebUiServer;
  snapshot: Snapshot;
  bootstrapUrl: string;
  submitted: SubmittedInput[];
  appendUserMessage(text: string): void;
  setSubmissionDelay(delayMs: number): void;
  useFallbackCompletion(): void;
  deliverPending(): void;
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
    pendingInputs: [],
    metadata: {
      cwd: "/Users/tester/project",
      home: "/Users/tester",
      contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
      sessionCost: 0.0123,
      model: { provider: "test", id: "fixture-model", name: "Fixture Model" },
      thinkingLevel: "high",
    },
    entries,
  };
}

export const test = base.extend<Fixtures>({
  // Playwright requires fixture dependencies to use an object destructuring pattern.
  // oxlint-disable-next-line no-empty-pattern
  session: async ({}, use) => {
    const snapshot = initialSnapshot();
    const submitted: SubmittedInput[] = [];
    let appendSubmittedMessage: (text: string) => void = () => undefined;
    let submissionDelayMs = 0;
    let forceFallbackCompletion = false;
    let fdPath: string | undefined;
    try {
      fdPath = execFileSync("which", ["fd"], { encoding: "utf8" }).trim();
    } catch {
      fdPath = undefined;
    }
    const completionProvider = new CombinedAutocompleteProvider([], process.cwd(), fdPath);
    const server = await startServer(() => snapshot, {
      submitInput: async (content, delivery) => {
        if (submissionDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, submissionDelayMs));
        }
        if (delivery === "immediate" && snapshot.isRunning) {
          return { accepted: false, error: "Pi is busy; choose Steer or Queue" };
        }
        if (delivery !== "immediate" && !snapshot.isRunning) {
          return { accepted: false, error: "Pi is idle; send a prompt instead" };
        }
        submitted.push({ content, delivery });
        if (delivery === "immediate") {
          appendSubmittedMessage(content);
          snapshot.isRunning = true;
        } else {
          snapshot.pendingInputs.push({
            id: `pending-${submitted.length}`,
            content,
            delivery,
          });
        }
        server.broadcast();
        return { accepted: true };
      },
      completeMention: (query, signal) =>
        query.startsWith('@"dir name/child')
          ? Promise.resolve([
              {
                value: '@"dir name/child.txt"',
                label: "child.txt",
                description: "fixture",
              },
            ])
          : query.startsWith('@"dir')
            ? Promise.resolve([
                { value: '@"dir name/"', label: "dir name/", description: "fixture" },
              ])
            : query.startsWith("@many")
              ? Promise.resolve(
                  Array.from({ length: 20 }, (_, index) => ({
                    value: `@fixture/file-${String(index).padStart(2, "0")}.txt`,
                    label: `file-${String(index).padStart(2, "0")}.txt`,
                    description: "fixture",
                  })),
                )
              : query.startsWith('@"space')
                ? Promise.resolve([
                    {
                      value: '@"space file.txt"',
                      label: "space file.txt",
                      description: "fixture",
                    },
                  ])
                : fdPath && !forceFallbackCompletion
                  ? mentionCompletions(completionProvider, query, signal)
                  : fallbackFileCompletions(process.cwd(), query, signal),
    });
    let nextIndex = snapshot.entries.length;
    const fixture: SessionFixture = {
      server,
      snapshot,
      bootstrapUrl: server.bootstrapUrl(),
      submitted,
      setSubmissionDelay(delayMs) {
        submissionDelayMs = delayMs;
      },
      useFallbackCompletion() {
        forceFallbackCompletion = true;
      },
      deliverPending() {
        for (const pending of snapshot.pendingInputs) appendSubmittedMessage(pending.content);
        snapshot.pendingInputs = [];
        server.broadcast();
      },
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
    appendSubmittedMessage = fixture.appendUserMessage;
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
