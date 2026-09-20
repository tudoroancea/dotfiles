// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
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

  it("matches exporter bash, edit, and write information hierarchy", () => {
    const { rerender, container } = render(<ToolCall view={view("bash")} />);
    expect(container.querySelector(".tool__command")?.textContent).toContain("nub test\nprintf");
    expect(container.querySelector(".tool__status")).toBeNull();
    expect(container.querySelector(".tool__summary")).toBeNull();
    expect(container.querySelector(".tool__body .ansi-output")).toBeTruthy();
    expect(container.querySelector(".ansi-output")?.textContent).toContain("12 tests passed");

    rerender(<ToolCall view={view("edit")} />);
    expect(container.querySelector(".tool__command")?.textContent).toContain("src/app.ts");
    expect(screen.getByText("+new", { exact: false })).toBeTruthy();
    expect(container.querySelector(".tool__body")?.textContent).not.toContain("Updated src/app.ts");

    rerender(<ToolCall view={view("write")} />);
    expect(container.querySelector(".tool__path")?.textContent).toBe("src/new.ts");
    expect(container.querySelector(".tool__hint")).toBeNull();
    expect(container.querySelector(".ansi-output")?.textContent).toContain(
      "export const answer = 42;",
    );
  });

  it("supports controlled long-output expansion across unmount and remount", () => {
    let expanded = false;
    const longView = normalizeTool({
      toolName: "bash",
      args: { command: "printf output" },
      result: { content: [{ type: "text", text: "1\n2\n3\n4\n5\n6" }] },
      status: "completed",
    });
    const first = render(
      <ToolCall
        view={longView}
        expanded={expanded}
        onExpandedChange={(next) => {
          expanded = next;
        }}
      />,
    );
    expect(first.container.querySelector(".ansi-output__hint")?.textContent).toBe(
      "... (1 more lines)",
    );
    fireEvent.click(first.container.querySelector(".exporter-output")!);
    expect(expanded).toBe(true);
    first.unmount();

    const second = render(<ToolCall view={longView} expanded={expanded} />);
    expect(second.container.querySelector(".exporter-output")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(second.container.querySelectorAll(".ansi-line")).toHaveLength(6);
  });

  it("shows the full wrapped bash command and no timeout/status chrome", () => {
    const command = `printf '%s' ${"long-argument ".repeat(12)}`;
    const { container } = render(
      <ToolCall
        view={normalizeTool({
          toolName: "bash",
          args: { command, timeout: 30 },
          result: { content: [{ type: "text", text: "finished" }] },
          status: "completed",
        })}
      />,
    );
    expect(container.querySelector(".tool__command")?.textContent).toBe(command);
    expect(container.textContent).not.toContain("timeout");
    expect(container.querySelector(".tool__status")).toBeNull();
    expect(container.querySelector(".tool__summary")).toBeNull();
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
    expect(container.querySelector(".ansi-output")?.textContent).toContain("Image Size: 1x1");
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
    expect(container.querySelector(".tool__summary")).toBeNull();
    expect(container.querySelector('[aria-label="unknown_tool output"]')?.textContent).toContain(
      "failed safely",
    );
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
    expect(container.textContent?.match(/mixed output/g) ?? []).toHaveLength(1);
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});
