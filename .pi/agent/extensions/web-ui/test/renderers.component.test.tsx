// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionState } from "../src/shared/wire.js";
import { Timeline } from "../src/web/components/Timeline.js";
import { ToolCall } from "../src/web/components/ToolCall.js";
import { normalizeTool } from "../src/web/lib/tool-model.js";
import { hasAdapter } from "../src/web/render/registry.js";

interface ToolFixture {
  name: string;
  args: Record<string, unknown>;
  result: {
    content: unknown[];
    details?: Record<string, unknown>;
    isError: boolean;
  };
}

const fixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), "test/fixtures/tool-calls.json"), "utf8"),
) as ToolFixture[];

const fixture = (name: string) => fixtures.find((candidate) => candidate.name === name)!;
const view = (name: string) => {
  const item = fixture(name);
  return normalizeTool({
    toolName: item.name,
    args: item.args,
    result: { content: item.result.content, details: item.result.details },
    status: item.result.isError ? "error" : "completed",
    isError: item.result.isError,
  });
};

afterEach(cleanup);

describe("tool renderer registry", () => {
  it("has and renders a dedicated adapter for every enabled Phase 3 tool", () => {
    expect(fixtures.map((item) => item.name).filter((name) => !hasAdapter(name))).toEqual([]);
    for (const item of fixtures) {
      const rendered = render(<ToolCall view={view(item.name)} />);
      expect(rendered.container.querySelector(`[data-tool="${item.name}"]`)).toBeTruthy();
      expect(rendered.container.querySelector(".tool__title")?.textContent?.trim()).not.toBe("");
      rendered.unmount();
    }
  });

  it("matches compact bash, edit, and write information hierarchy", () => {
    const { rerender, container } = render(<ToolCall view={view("bash")} />);
    // The bar shows a compacted, single-line command; the multi-line original
    // is revealed in the expandable body alongside the output.
    expect(container.querySelector(".tool__command")?.textContent).toContain("nub test");
    expect(container.querySelector(".tool__command")?.textContent).not.toContain("\n");
    const bashCode = [...container.querySelectorAll(".tool__body code")].map((c) => c.textContent);
    expect(bashCode.some((text) => text?.includes("printf"))).toBe(true);
    expect(bashCode.some((text) => text?.includes("12 tests passed"))).toBe(true);
    expect(screen.getByText("2 output lines")).toBeTruthy();

    rerender(<ToolCall view={view("edit")} />);
    expect(container.querySelector(".tool__command")?.textContent).toContain("src/app.ts");
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
    expect(screen.getByText("+new", { exact: false })).toBeTruthy();

    rerender(<ToolCall view={view("write")} />);
    expect(screen.getByText(/src\/new\.ts/)).toBeTruthy();
    expect(screen.getByText(/2 lines/)).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toContain("export const answer = 42;");
  });

  it("supports externally keyed expansion across unmount and remount", () => {
    let expanded = false;
    const first = render(
      <ToolCall
        view={view("bash")}
        expanded={expanded}
        onExpandedChange={(next) => {
          expanded = next;
        }}
      />,
    );
    fireEvent.click(first.container.querySelector("summary")!);
    expect(expanded).toBe(true);
    first.unmount();

    const second = render(<ToolCall view={view("bash")} expanded={expanded} />);
    expect(second.container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("expands a long single-line bash command without colliding with status chrome", () => {
    const command = `printf '%s' ${"long-argument ".repeat(12)}`;
    const { container } = render(
      <ToolCall
        view={normalizeTool({
          toolName: "bash",
          args: { command },
          result: { content: [{ type: "text", text: "finished" }] },
          status: "completed",
        })}
      />,
    );
    const disclosure = container.querySelector("details")!;
    const compact = container.querySelector(".tool__command")?.textContent ?? "";
    expect(compact.length).toBeLessThan(command.length);
    expect(compact.endsWith("...")).toBe(true);
    expect(disclosure.hasAttribute("open")).toBe(false);

    const barChildren = [...container.querySelector(".tool__bar")!.children];
    expect(barChildren.at(-2)?.classList.contains("tool__status")).toBe(true);
    expect(barChildren.at(-1)?.classList.contains("tool__toggle")).toBe(true);
    fireEvent.click(container.querySelector("summary")!);
    expect(disclosure.hasAttribute("open")).toBe(true);
    expect(container.querySelector(".tool__body code")?.textContent).toContain(command);
  });

  it("renders Agentflow, background, and questionnaire semantic details", () => {
    const { rerender, container } = render(<ToolCall view={view("agentflow_finder")} />);
    expect(container.querySelector(".tool__command")?.textContent).toContain("finder");
    expect(screen.getByText("run-finder")).toBeTruthy();
    expect(screen.getByText("src/index.ts: lifecycle")).toBeTruthy();

    rerender(<ToolCall view={view("background_run")} />);
    expect(container.querySelector(".tool__command")?.textContent).toContain("nub test");
    expect(container.querySelector(".tool__phase")?.textContent).toBe("running");
    expect(screen.getByText("job-bg1")).toBeTruthy();

    rerender(<ToolCall view={view("questionnaire")} />);
    expect(screen.getByText("1 question")).toBeTruthy();
    expect(screen.getByText("1 answer")).toBeTruthy();
    expect(screen.getByText(/1\. Small/)).toBeTruthy();
  });

  it("renders read images and explicit omission states without duplicating text", () => {
    const { container } = render(
      <ToolCall
        view={normalizeTool({
          toolName: "read",
          args: { path: "image.png" },
          result: {
            content: [
              { type: "text", text: "Image Size: 1x1" },
              { type: "image", mimeType: "image/png", data: "eA==" },
              { type: "image", mimeType: "image/png", omitted: true },
              { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
            ],
          },
          status: "completed",
        })}
      />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getAllByText(/Image omitted/)).toHaveLength(2);
    expect(container.querySelectorAll("code")[0]?.textContent).toContain("Image Size: 1x1");
  });

  it("handles list, error, empty, and running custom-tool shapes", () => {
    const run = (fixture("agentflow_finder").result.details?.snapshot ?? {}) as Record<
      string,
      unknown
    >;
    const { rerender, container } = render(
      <ToolCall
        view={normalizeTool({
          toolName: "agentflow_status",
          args: {},
          result: { content: [], details: { snapshot: [run, { ...run, runId: "run-2" }] } },
          status: "completed",
        })}
      />,
    );
    expect(container.querySelector(".tool__summary")?.textContent).toBe("2 runs");
    expect(screen.getByText("run-2")).toBeTruthy();

    rerender(
      <ToolCall
        view={normalizeTool({
          toolName: "background_wait",
          args: { jobIds: ["missing"] },
          result: { content: [{ type: "text", text: "Unknown job: missing" }] },
          status: "error",
          isError: true,
        })}
      />,
    );
    expect(container.querySelector(".tool__summary")?.textContent).toContain(
      "failed · Unknown job",
    );
    expect(container.querySelector("code")?.textContent).toContain("Unknown job: missing");

    rerender(
      <ToolCall
        view={normalizeTool({
          toolName: "background_status",
          args: {},
          result: {
            content: [],
            details: {
              jobs: [
                {
                  jobId: "failed-job",
                  command: "bad command",
                  status: "cleanup_failed",
                  error: "process cleanup failed",
                  deliveryError: "delivery failed",
                  tail: "partial tail",
                  tailTruncated: true,
                },
              ],
              truncated: true,
              omittedCount: 0,
            },
          },
          status: "completed",
        })}
      />,
    );
    expect(screen.getByText("process cleanup failed")).toBeTruthy();
    expect(screen.getByText("delivery failed")).toBeTruthy();
    expect(screen.getByText("Output tail truncated")).toBeTruthy();
    expect(screen.getByText("Result payload or output tail truncated")).toBeTruthy();
    expect(screen.queryByText("0 jobs omitted")).toBeNull();

    rerender(
      <ToolCall
        view={normalizeTool({
          toolName: "agentflow_wait",
          args: { runIds: ["failed-run"] },
          result: {
            content: [],
            details: {
              results: [
                {
                  error: "child failed clearly",
                  snapshot: {
                    runId: "failed-run",
                    kind: "agent",
                    status: "failed",
                    error: "run failed clearly",
                    phases: [],
                    nodes: [{ id: "node", label: "node", status: "failed", error: "node failed" }],
                    logs: [],
                  },
                },
              ],
            },
          },
          status: "completed",
        })}
      />,
    );
    expect(screen.getByText("child failed clearly")).toBeTruthy();
    expect(screen.getByText("run failed clearly")).toBeTruthy();
    expect(screen.getByText("node failed")).toBeTruthy();

    rerender(
      <ToolCall
        view={normalizeTool({
          toolName: "agentflow_status",
          args: { runId: "missing" },
          result: { content: [{ type: "text", text: "Unknown run: missing" }] },
          status: "error",
          isError: true,
        })}
      />,
    );
    expect(container.querySelector(".tool__summary")?.textContent).toContain(
      "failed · Unknown run: missing",
    );
    expect(container.querySelector("code")?.textContent).toContain("Unknown run: missing");

    rerender(
      <ToolCall
        view={normalizeTool({
          toolName: "questionnaire",
          args: fixture("questionnaire").args,
          status: "running",
        })}
      />,
    );
    expect(container.querySelector(".tool__command")?.textContent).toContain("1 question");
    expect(container.querySelector(".tool__summary")?.textContent).toBe("waiting for response…");

    rerender(
      <ToolCall
        view={normalizeTool({
          toolName: "questionnaire",
          args: { questions: [] },
          result: {
            content: [{ type: "text", text: "Error: No questions provided" }],
            details: { questions: [], answers: [], cancelled: true },
          },
          status: "completed",
        })}
      />,
    );
    expect(container.querySelector("[data-tool='questionnaire']")?.className).toContain(
      "tool--error",
    );
    expect(container.querySelector(".answer--error")?.textContent).toBe(
      "Error: No questions provided",
    );
  });

  it("uses the safe generic fallback for unknown tools", () => {
    const { container } = render(
      <ToolCall
        view={normalizeTool({
          toolName: "unknown_tool",
          args: { path: "</summary><script>bad()</script>" },
          result: {
            content: [{ type: "text", text: "\u001b[31mfailed safely\u001b[0m" }],
            details: { nested: true },
          },
          status: "error",
          isError: true,
        })}
      />,
    );
    expect(screen.getByText("unknown_tool")).toBeTruthy();
    expect(container.querySelector(".tool__summary")?.textContent).toContain("failed safely");
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders mixed generic text once in detail plus once in its summary", () => {
    const { container } = render(
      <ToolCall
        view={normalizeTool({
          toolName: "mixed_unknown",
          args: {},
          result: {
            content: [
              { type: "text", text: "mixed output" },
              { type: "image", mimeType: "image/png", data: "eA==" },
            ],
          },
          status: "completed",
        })}
      />,
    );
    expect(container.textContent?.match(/mixed output/g) ?? []).toHaveLength(2);
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});

describe("timeline rendering", () => {
  it("orders sequential live rounds and suppresses matching tool-result overlays", () => {
    const assistant = (timestamp: number, calls: Array<Record<string, unknown>>) => ({
      role: "assistant",
      timestamp,
      content: calls,
    });
    const result = (timestamp: number, id: string, name: string) => ({
      role: "toolResult",
      timestamp,
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: `${name} done` }],
      isError: false,
    });
    const state = {
      persisted: {
        sessionId: "session",
        leafId: null,
        historyGeneration: "history-1",
        entries: [],
        hasOlder: false,
      },
      live: {
        isRunning: true,
        finalizedMessages: [
          assistant(1, [{ type: "toolCall", id: "a", name: "bash", arguments: {} }]),
          result(2, "a", "bash"),
          assistant(3, [
            { type: "toolCall", id: "b", name: "read", arguments: {} },
            { type: "toolCall", id: "c", name: "write", arguments: {} },
          ]),
          result(4, "b", "read"),
          result(5, "c", "write"),
        ],
        tools: [
          {
            toolCallId: "a",
            toolName: "bash",
            ordinal: 0,
            status: "completed",
            args: { command: "first" },
            result: { content: [{ type: "text", text: "bash done" }] },
            isError: false,
          },
          {
            toolCallId: "b",
            toolName: "read",
            ordinal: 1,
            status: "completed",
            args: { path: "second.ts" },
            result: { content: [{ type: "text", text: "read done" }] },
            isError: false,
          },
          {
            toolCallId: "c",
            toolName: "write",
            ordinal: 2,
            status: "completed",
            args: { path: "third.ts", content: "done" },
            result: { content: [{ type: "text", text: "write done" }] },
            isError: false,
          },
        ],
      },
      metadata: { cwd: "/repo", isIdle: false, activeTools: [] },
    } as SessionState;
    const { container } = render(<Timeline state={state} />);
    const sequence = [...container.querySelectorAll(".timeline > .message, .timeline > .tool")].map(
      (element) => element.getAttribute("data-tool") ?? element.getAttribute("data-role"),
    );
    expect(sequence).toEqual(["assistant", "bash", "assistant", "read", "write"]);
    expect(container.querySelectorAll("[data-tool]")).toHaveLength(3);
  });

  it("correlates persisted tool results with assistant arguments", () => {
    const state = {
      persisted: {
        sessionId: "session",
        leafId: "result",
        historyGeneration: "history-1",
        hasOlder: false,
        entries: [
          {
            id: "assistant",
            parentId: null,
            timestamp: "2026-07-24T00:00:00.000Z",
            entryType: "message",
            payload: {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "call-1",
                    name: "bash",
                    arguments: { command: "nub test" },
                  },
                ],
              },
            },
          },
          {
            id: "result",
            parentId: "assistant",
            timestamp: "2026-07-24T00:00:01.000Z",
            entryType: "message",
            payload: {
              message: {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "bash",
                content: [{ type: "text", text: "passed" }],
                isError: false,
              },
            },
          },
        ],
      },
      live: {
        isRunning: true,
        finalizedMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: { command: "nub test" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "passed" }],
            isError: false,
          },
        ],
        tools: [
          {
            toolCallId: "call-1",
            toolName: "bash",
            ordinal: 0,
            status: "completed",
            args: { command: "nub test" },
            result: { content: [{ type: "text", text: "passed" }] },
            isError: false,
          },
          {
            toolCallId: "parallel-read",
            toolName: "read",
            ordinal: 1,
            status: "running",
            args: { path: "a.ts" },
            isError: false,
          },
          {
            toolCallId: "parallel-bash",
            toolName: "bash",
            ordinal: 2,
            status: "running",
            args: { command: "nub lint" },
            isError: false,
          },
        ],
      },
      metadata: { cwd: "/repo", isIdle: false, activeTools: [] },
    } as SessionState;
    render(<Timeline state={state} />);
    expect(screen.getByText("nub test")).toBeTruthy();
    const liveTools = [...document.querySelectorAll("[data-tool]")].slice(-2);
    expect(liveTools.map((element) => element.getAttribute("data-tool"))).toEqual(["read", "bash"]);
    expect(liveTools[0]?.textContent).toContain("a.ts");
    expect(liveTools[1]?.textContent).toContain("nub lint");
    expect(document.querySelectorAll("[data-tool]")).toHaveLength(3);
  });
});
