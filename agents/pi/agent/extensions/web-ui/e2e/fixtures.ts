import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect as playwrightExpect, test as base, type Page } from "@playwright/test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import {
  fallbackFileCompletions,
  mentionCompletions,
  startServer,
  type Snapshot,
  type WebUiServer,
} from "../src/index.js";
import type { CommandAcceptance, ModelControlCommand } from "@dotfiles/pi-web-ui-client/wire";

const BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);
const EXTENSION_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface SubmittedInput {
  content: string;
  delivery: "immediate" | "steer" | "followUp";
}

interface SessionFixture {
  server: WebUiServer;
  snapshot: Snapshot;
  bootstrapUrl: string;
  submitted: SubmittedInput[];
  modelControls: ModelControlCommand[];
  readonly modelControlMaxConcurrency: number;
  appendUserMessage(text: string): void;
  populateLarge(count: number): void;
  setSubmissionDelay(delayMs: number): void;
  setModelControlDelay(delayMs: number): void;
  setModelControlAcceptance(acceptance: unknown): void;
  enableModelControl(): void;
  useFallbackCompletion(): void;
  deliverPending(): void;
  completeLast(status: "completed" | "failed", error?: string): void;
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
    const modelControls: ModelControlCommand[] = [];
    let appendSubmittedMessage: (text: string) => void = () => undefined;
    let submissionDelayMs = 0;
    let modelControlDelayMs = 0;
    let activeModelControls = 0;
    let maxModelControlConcurrency = 0;
    let modelControlAcceptance: unknown;
    let forceFallbackCompletion = false;
    let lastCommand: { id: string; epoch: string } | undefined;
    let fdPath: string | undefined;
    try {
      fdPath = execFileSync("which", ["fd"], { encoding: "utf8" }).trim();
    } catch {
      fdPath = undefined;
    }
    const completionProvider = new CombinedAutocompleteProvider([], EXTENSION_ROOT, fdPath);
    const server = await startServer(() => snapshot, {
      submitInput: async ({ commandId, commandEpoch, content, delivery }, signal) => {
        if (submissionDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, submissionDelayMs));
        }
        if (signal.aborted) return { accepted: false, error: "Session changed" };
        if (delivery === "immediate" && snapshot.isRunning) {
          return { accepted: false, error: "Pi is busy; choose Steer or Queue" };
        }
        if (delivery !== "immediate" && !snapshot.isRunning) {
          return { accepted: false, error: "Pi is idle; send a prompt instead" };
        }
        submitted.push({ content, delivery });
        lastCommand = { id: commandId, epoch: commandEpoch };
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
      modelControl: async (command, signal, tryHandoff) => {
        activeModelControls += 1;
        maxModelControlConcurrency = Math.max(maxModelControlConcurrency, activeModelControls);
        try {
          if (modelControlDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, modelControlDelayMs));
          }
          if (modelControlAcceptance !== undefined) {
            return modelControlAcceptance as CommandAcceptance;
          }
          if (signal.aborted || !tryHandoff()) {
            return { accepted: false, error: "Session changed" };
          }
          modelControls.push(command);
          if (command.type === "set-thinking") {
            snapshot.metadata!.thinkingLevel = command.thinkingLevel;
            server.broadcast();
          } else {
            const selected = snapshot.modelControl!.models.find(
              (model) => model.provider === command.provider && model.id === command.modelId,
            );
            if (!selected) return { accepted: false, error: "Model is unavailable" };
            snapshot.metadata!.model = selected;
            server.reset("model changed");
          }
          return { accepted: true };
        } finally {
          activeModelControls -= 1;
        }
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
                  : fallbackFileCompletions(EXTENSION_ROOT, query, signal),
    });
    let nextIndex = snapshot.entries.length;
    const fixture: SessionFixture = {
      server,
      snapshot,
      bootstrapUrl: server.bootstrapUrl(),
      submitted,
      modelControls,
      get modelControlMaxConcurrency() {
        return maxModelControlConcurrency;
      },
      setSubmissionDelay(delayMs) {
        submissionDelayMs = delayMs;
      },
      setModelControlDelay(delayMs) {
        modelControlDelayMs = delayMs;
      },
      setModelControlAcceptance(acceptance) {
        modelControlAcceptance = acceptance;
      },
      enableModelControl() {
        snapshot.modelControl = {
          models: [
            { provider: "test", id: "fixture-model", name: "Fixture Model" },
            { provider: "test", id: "alternate-model", name: "Alternate Model" },
          ],
          thinkingLevels: ["off", "low", "medium", "high"],
        };
        server.broadcast();
      },
      useFallbackCompletion() {
        forceFallbackCompletion = true;
      },
      deliverPending() {
        for (const pending of snapshot.pendingInputs) appendSubmittedMessage(pending.content);
        snapshot.pendingInputs = [];
        server.broadcast();
      },
      completeLast(status, error) {
        if (!lastCommand) throw new Error("No admitted command to complete");
        server.completeCommand(lastCommand.id, lastCommand.epoch, status, error);
      },
      populateLarge(count) {
        snapshot.entries = Array.from({ length: count }, (_, index) =>
          entry(
            `entry-${index}`,
            index % 17 === 0
              ? {
                  role: "assistant",
                  content: [
                    {
                      type: "thinking",
                      thinking: `Variable thinking ${index}\n${"detail ".repeat(index % 11)}`,
                    },
                    {
                      type: "text",
                      text: `Variable assistant message ${index}\n${"line\n".repeat(index % 7)}`,
                    },
                  ],
                  timestamp: BASE_TIME + index * 1_000,
                }
              : {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Large fixture message ${index} ${"wide ".repeat(index % 9)}`,
                    },
                  ],
                  timestamp: BASE_TIME + index * 1_000,
                },
            index,
          ),
        );
        snapshot.leafId = count > 0 ? `entry-${count - 1}` : null;
        nextIndex = count;
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
  await playwrightExpect(page).toHaveTitle("π – Playwright fixture");
  await playwrightExpect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
}

export { expect } from "@playwright/test";
