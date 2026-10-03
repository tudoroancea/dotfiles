import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sessionBreakdownExtension, {
  deduplicateHistoricalAgentflowCosts,
  parseSessionFile,
} from "../session-breakdown.ts";
import { canonicalSessionCostEntries } from "../lib/test/fixtures/session-cost.ts";

function commandHarness(extension: (pi: never) => void) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const events = { emit: vi.fn() };
  const pi = {
    registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    }),
    on: vi.fn(),
    events,
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  extension(pi as never);
  return { handler: handler!, events, pi };
}

describe("interactive command lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("leaves the session analysis loader unblocked", async () => {
    const { handler, events } = commandHarness(sessionBreakdownExtension as never);
    const custom = vi.fn(async () => null);
    await handler("", { mode: "tui", hasUI: true, ui: { custom, notify: vi.fn() } });
    expect(custom).toHaveBeenCalledOnce();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("does not block for the user-initiated post-analysis breakdown viewer", async () => {
    for (const rejectViewer of [false, true]) {
      const { handler, events } = commandHarness(sessionBreakdownExtension as never);
      const data = { ranges: new Map(), palette: {}, generatedAt: new Date() };
      const custom = vi
        .fn()
        .mockResolvedValueOnce(data)
        .mockImplementationOnce(async () => {
          if (rejectViewer) throw new Error("viewer failed");
        });
      const operation = handler("", { mode: "tui", hasUI: true, ui: { custom, notify: vi.fn() } });
      if (rejectViewer) await expect(operation).rejects.toThrow("viewer failed");
      else await operation;
      expect(events.emit).not.toHaveBeenCalled();
    }
  });
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("session cost consumers", () => {
  it("streams every top-level historical JSONL entry through canonical accounting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-cost-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "2026-02-01T12-00-00-000Z_fixture.jsonl");
    await writeFile(
      filePath,
      canonicalSessionCostEntries.map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8",
    );

    const session = await parseSessionFile(filePath);
    // Historical parsing preserves support for legacy numeric-string costs that
    // the live canonical producer contract deliberately rejects.
    expect(session?.totalCost).toBeCloseTo(8.6);
    expect(session?.costByModel.get("agentflow/child-runs")).toBeCloseTo(1.5);
    expect([...session!.costByModel.values()].reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(
      8.6,
    );
  });

  it("deduplicates Agentflow cost IDs across historical files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-cost-cross-file-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "2026-02-01T12-00-00-000Z_first.jsonl");
    const secondPath = join(directory, "2026-02-02T12-00-00-000Z_second.jsonl");
    await writeFile(
      firstPath,
      JSON.stringify({
        type: "custom",
        customType: "agentflow-cost",
        data: { costId: "agentflow:shared", cost: 0.4 },
      }),
      "utf8",
    );
    await writeFile(
      secondPath,
      JSON.stringify({
        type: "custom_message",
        customType: "agentflow-result",
        details: { costId: "agentflow:shared", cost: 0.7 },
      }),
      "utf8",
    );

    const first = await parseSessionFile(firstPath);
    const second = await parseSessionFile(secondPath);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const sessions = [first!, second!];
    deduplicateHistoricalAgentflowCosts(sessions);

    expect(sessions.reduce((sum, session) => sum + session.totalCost, 0)).toBeCloseTo(0.7);
    expect(first?.costByModel.has("agentflow/child-runs")).toBe(false);
    expect(second?.costByModel.get("agentflow/child-runs")).toBeCloseTo(0.7);
  });

  it("does not recount propagated Agentflow cost when the persisted child is included", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-cost-child-"));
    temporaryDirectories.push(directory);
    const parentPath = join(directory, "2026-02-01T12-00-00-000Z_parent.jsonl");
    const childPath = join(directory, "2026-02-01T12-01-00-000Z_child.jsonl");
    await writeFile(
      parentPath,
      JSON.stringify({
        type: "custom_message",
        customType: "agentflow-result",
        details: {
          costId: "agentflow:run-with-child",
          cost: 0.7,
          snapshot: {
            runId: "run-with-child",
            nodes: [{ sessionFile: childPath, usage: { cost: 0.7 } }],
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      childPath,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          provider: "provider",
          model: "child-model",
          usage: { cost: { total: 0.7 } },
        },
      }),
      "utf8",
    );

    const parent = await parseSessionFile(parentPath);
    const child = await parseSessionFile(childPath);
    expect(parent).not.toBeNull();
    expect(child).not.toBeNull();
    const sessions = [parent!, child!];
    deduplicateHistoricalAgentflowCosts(sessions);

    expect(sessions.reduce((sum, session) => sum + session.totalCost, 0)).toBeCloseTo(0.7);
    expect(parent?.costByModel.has("agentflow/child-runs")).toBe(false);
    expect(child?.costByModel.get("provider/child-model")).toBeCloseTo(0.7);
  });

  it("normalizes legacy wrapper usage, scalar costs, and model attribution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-cost-legacy-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "2026-02-01T12-00-00-000Z_legacy.jsonl");
    await writeFile(
      filePath,
      [
        {
          type: "message",
          provider: "legacy-provider",
          model: "legacy-model",
          usage: { cost: "0.25" },
          message: { role: "assistant", content: [] },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            provider: "legacy-provider",
            modelId: "tool-model",
            usage: { cost: { total: "0.5" } },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );

    const session = await parseSessionFile(filePath);
    expect(session?.totalCost).toBeCloseTo(0.75);
    expect(session?.costByModel.get("legacy-provider/legacy-model")).toBeCloseTo(0.25);
    expect(session?.costByModel.get("legacy-provider/tool-model")).toBeCloseTo(0.5);
  });
});
