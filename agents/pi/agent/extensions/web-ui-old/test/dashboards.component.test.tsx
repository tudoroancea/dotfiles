// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentflowDashboard } from "../src/web/components/AgentflowDashboard.js";
import { BackgroundDashboard } from "../src/web/components/BackgroundDashboard.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("native dashboards", () => {
  it("renders Agentflow detail and emits targeted steer/cancel", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const action = vi.fn();
    render(
      <AgentflowDashboard
        data={[
          {
            runId: "run-1",
            kind: "agent",
            status: "running",
            phases: ["build"],
            currentPhase: "build",
            nodes: [
              {
                id: "n",
                label: "worker",
                status: "running",
                steerable: true,
                toolCalls: [],
                usage: { total: 10, cost: 0.1 },
              },
              {
                id: "n2",
                label: "reviewer",
                status: "running",
                steerable: true,
                toolCalls: [],
                usage: { total: 5, cost: 0.05 },
              },
            ],
            logs: [],
            artifactDir: "/tmp/run",
          },
        ]}
        connected
        onAction={action}
      />,
    );
    expect(screen.getAllByText("run-1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("/tmp/run")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Target node"), { target: { value: "n2" } });
    fireEvent.input(screen.getByLabelText("Steering message"), { target: { value: "focus" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(action).toHaveBeenCalledWith("steer", {
      runId: "run-1",
      nodeId: "n2",
      message: "focus",
    });
    expect((screen.getByLabelText("Steering message") as HTMLInputElement).value).toBe("focus");
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(action).toHaveBeenCalledWith("cancel", { runId: "run-1" });
  });

  it("disables autonomous controls while disconnected", () => {
    render(
      <AgentflowDashboard
        data={[{ runId: "run", status: "completed", nodes: [], phases: [], logs: [] }]}
        connected={false}
        onAction={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Cancel run" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("renders background delivery/monitor state and emits tail/stop", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const action = vi.fn();
    render(
      <BackgroundDashboard
        data={{
          jobs: [
            {
              jobId: "job-1",
              description: "watch",
              command: "cmd",
              status: "running",
              durationMs: 1200,
              outputBytes: 10,
              requestedTerminalCause: "stop",
              deliveryState: "pending",
              outputPath: "/tmp/out",
              metadataPath: "/tmp/meta",
              tail: "ready",
              monitor: { deliveries: 2, droppedLines: 1 },
            },
          ],
        }}
        connected
        onAction={action}
      />,
    );
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("/tmp/out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh tail" }));
    expect(action).toHaveBeenCalledWith("tail", { jobId: "job-1", tailLines: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Stop job" }));
    expect(action).toHaveBeenCalledWith("stop", { jobId: "job-1" });
  });
});
