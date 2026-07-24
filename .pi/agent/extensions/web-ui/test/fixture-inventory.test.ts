import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url));
const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(`${fixtureDirectory}${name}`, "utf8")) as T;

const EXPECTED_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "find",
  "ls",
  "agentflow_finder",
  "agentflow_oracle",
  "agentflow_librarian",
  "agentflow_look_at",
  "agentflow_delegate",
  "agentflow_review",
  "agentflow_claude",
  "agentflow_workflow",
  "agentflow_status",
  "agentflow_wait",
  "agentflow_cancel",
  "agentflow_steer",
  "background_run",
  "background_event_stream",
  "background_status",
  "background_wait",
  "background_stop",
  "questionnaire",
] as const;

type ToolFixture = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  partial?: Record<string, unknown>;
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
    isError: boolean;
  };
};

type SessionEvent = {
  type: string;
  toolCallId?: string;
  partialResult?: { content: Array<{ type: string; text?: string }> };
  result?: { content: Array<{ type: string; text?: string }> };
  isError?: boolean;
};

type PersistedEntry = {
  type: string;
  customType?: string;
  content?: string;
  details?: Record<string, unknown>;
  message?: {
    role: string;
    content: Array<{ type: string; data?: string; mimeType?: string }>;
    isError?: boolean;
    toolName?: string;
  };
};

describe("fixture inventory", () => {
  const inventory = readFixture<{ toolNames: string[]; scenarioPaths: Record<string, string> }>(
    "inventory.json",
  );
  const tools = readFixture<ToolFixture[]>("tool-calls.json");
  const sessionEvents = readFixture<{
    persistedBranch: PersistedEntry[];
    liveEvents: SessionEvent[];
  }>("session-events.json");

  it("has one representative final result for every enabled target tool", () => {
    expect(inventory.toolNames).toEqual(EXPECTED_TOOLS);
    expect(tools.map((fixture) => fixture.name)).toEqual(EXPECTED_TOOLS);
    expect(new Set(tools.map((fixture) => fixture.id)).size).toBe(tools.length);
    expect(tools.every((fixture) => fixture.result.content.length > 0)).toBe(true);

    for (const name of ["bash", "grep", "find"] as const) {
      expect(tools.find((fixture) => fixture.name === name)?.result.details).toEqual({});
    }
    for (const fixture of tools.filter((tool) =>
      /^agentflow_(finder|oracle|librarian|look_at|delegate|review|claude|workflow)$/.test(
        tool.name,
      ),
    )) {
      expect(fixture.result.details).toMatchObject({
        runId: expect.any(String),
        status: expect.any(String),
        snapshot: expect.any(Object),
      });
    }
    expect(tools.find((fixture) => fixture.name === "questionnaire")?.result).toMatchObject({
      content: [{ text: "Scope: user selected: 1. Small" }],
      details: { answers: [{ index: 1 }] },
    });

    for (const name of ["agentflow_status", "agentflow_wait"] as const) {
      const fixture = tools.find((tool) => tool.name === name)!;
      expect(() => JSON.parse(fixture.result.content[0]!.text!)).not.toThrow();
      expect(fixture.result.details).toMatchObject({
        observedAt: expect.any(Number),
        costs: expect.any(Array),
      });
    }
  });

  it("uses the public background projection rather than runtime-only records", () => {
    for (const fixture of tools.filter((tool) => tool.name.startsWith("background_"))) {
      const details = fixture.result.details as {
        text?: string;
        jobs?: Array<Record<string, unknown>>;
      };
      expect(details.text).toEqual(expect.any(String));
      const { text, ...wire } = details;
      expect(JSON.parse(text!)).toEqual(wire);
      expect(fixture.result.content[0]?.text).toBe(text);
      for (const job of details.jobs ?? []) {
        expect(job).not.toHaveProperty("verification");
        expect(job).toHaveProperty("outputPath");
        expect(job).toHaveProperty("metadataPath");
        if (job.monitor) {
          expect(job.monitor).not.toHaveProperty("deliveredBytes");
          expect(job.monitor).not.toHaveProperty("deliveredLines");
          expect(job.monitor).not.toHaveProperty("throttled");
        }
      }
    }
  });

  it("captures image, custom-message, unknown-tool, and error semantics", () => {
    const imageEntry = sessionEvents.persistedBranch[0]!;
    expect(imageEntry.message?.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    );

    const customEntry = sessionEvents.persistedBranch[1]!;
    expect(customEntry.content).toContain("monitor job-stream (Server readiness)");
    expect(customEntry.content).toContain("source sequences: 1-1");
    expect(customEntry).toMatchObject({
      type: "custom_message",
      customType: "background-monitor-event",
      details: {
        outputPath: expect.any(String),
        lines: ["ready on port 3000"],
        captureOnly: false,
        captureBatches: 0,
      },
    });

    expect(sessionEvents.persistedBranch[2]?.message).toMatchObject({
      role: "toolResult",
      toolName: "unknown_tool",
      isError: true,
    });
    expect(sessionEvents.persistedBranch[3]).toMatchObject({
      type: "custom_message",
      customType: "agentflow-result",
      details: { snapshot: { runId: "run-background-finder", status: "completed" } },
    });
    const completion = sessionEvents.persistedBranch[4]!;
    expect(completion).toMatchObject({
      type: "custom_message",
      customType: "background-process-completion",
    });
    expect(completion.content).toBe(completion.details?.text);
    expect(sessionEvents.liveEvents.at(-1)).toMatchObject({
      type: "tool_execution_end",
      isError: true,
      result: { content: [{ text: "half complete\nfailed: assertion" }] },
    });
  });

  it("captures accumulated replacement updates interleaved with a parallel tool", () => {
    const updates = sessionEvents.liveEvents.filter(
      (event) => event.type === "tool_execution_update" && event.toolCallId === "parallel-b",
    );
    expect(updates).toHaveLength(2);
    const first = updates[0]?.partialResult?.content[0]?.text;
    const replacement = updates[1]?.partialResult?.content[0]?.text;
    expect(replacement).toContain(first);
    expect(replacement).toBe("half complete\nfailed: assertion");

    const between = sessionEvents.liveEvents.slice(
      sessionEvents.liveEvents.indexOf(updates[1]!),
      -1,
    );
    expect(between.some((event) => event.toolCallId === "parallel-a")).toBe(true);
    expect(Object.keys(inventory.scenarioPaths)).toHaveLength(10);
  });
});
