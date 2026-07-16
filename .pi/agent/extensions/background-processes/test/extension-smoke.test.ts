import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import backgroundProcessesExtension from "../src/index.ts";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("registered extension SDK smoke", () => {
  it("executes all registered tools in RPC/TUI-compatible contexts and exits cleanly", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "pi-background-sdk-smoke-"));
    roots.push(agentDirectory);
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const renderers = new Map<string, (...args: never[]) => unknown>();
    const messages: Array<{ message: Record<string, unknown>; options: unknown }> = [];
    const pi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      registerTool: (tool: { name: string; execute: (...args: never[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      registerMessageRenderer: (name: string, renderer: (...args: never[]) => unknown) =>
        renderers.set(name, renderer),
      sendMessage: (message: Record<string, unknown>, options: unknown) =>
        messages.push({ message, options }),
    };
    backgroundProcessesExtension(pi as never);
    const context = {
      mode: "rpc",
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      sessionManager: { getSessionId: () => "sdk-smoke" },
      ui: {
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    };
    const execute = async (name: string, params: unknown, mode = "rpc") =>
      tools
        .get(name)!
        .execute(
          "smoke-call" as never,
          params as never,
          undefined as never,
          undefined as never,
          { ...context, mode } as never,
        );

    let started = false;
    try {
      await handlers.get("session_start")!({}, context);
      started = true;
      expect([...tools.keys()]).toEqual([
        "background_bash",
        "monitor",
        "background_status",
        "background_wait",
        "background_stop",
      ]);
      expect(renderers.size).toBe(2);

      await expect(execute("background_bash", { command: "true" }, "print")).rejects.toThrow(
        "unsupported",
      );
      await expect(
        execute("monitor", { command: "true", description: "json" }, "json"),
      ).rejects.toThrow("unsupported");
      const emptyStatus = (await execute("background_status", {})) as {
        details: { jobs: unknown[] };
      };
      expect(emptyStatus.details.jobs).toEqual([]);

      const launched = (await execute("background_bash", {
        command: "printf 'sdk-background-output\\n'",
        description: "SDK background smoke",
      })) as { details: { jobs: Array<{ jobId: string; outputPath: string }> } };
      const background = launched.details.jobs[0]!;
      const inspected = (await execute("background_status", { jobId: background.jobId })) as {
        details: { jobs: Array<{ deliveryState: string }> };
      };
      expect(inspected.details.jobs[0]!.deliveryState).toBe("pending");
      const waited = (await execute("background_wait", {
        jobIds: [background.jobId],
        timeout: 5,
      })) as { details: { jobs: Array<{ status: string; deliveryState: string }> } };
      expect(waited.details.jobs[0]).toMatchObject({
        status: "completed",
        deliveryState: "consumed",
      });
      expect(await readFile(background.outputPath, "utf8")).toBe("sdk-background-output\n");

      const monitorLaunch = (await execute("monitor", {
        command: "printf 'event-one\\nevent-two\\n'; sleep 1",
        description: "SDK monitor smoke",
      })) as { details: { jobs: Array<{ jobId: string; outputPath: string }> } };
      const monitorJob = monitorLaunch.details.jobs[0]!;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await handlers.get("agent_settled")!({}, context);
      const monitorMessage = messages.find(
        ({ message }) => message.customType === "background-monitor-event",
      )!;
      expect(monitorMessage.message).toMatchObject({
        customType: "background-monitor-event",
        display: true,
        content: expect.stringContaining("event-one\nevent-two"),
        details: {
          jobId: monitorJob.jobId,
          outputPath: monitorJob.outputPath,
          delivery: 1,
          firstSequence: 1,
          lastSequence: 2,
          lines: ["event-one", "event-two"],
          captureOnly: false,
        },
      });
      expect(monitorMessage.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(Buffer.byteLength(monitorMessage.message.content as string)).toBeLessThanOrEqual(
        50 * 1024,
      );
      const monitorWait = (await execute("background_wait", {
        jobIds: [monitorJob.jobId],
        timeout: 5,
      })) as { details: { jobs: Array<{ status: string }> } };
      expect(monitorWait.details.jobs[0]!.status).toBe("completed");

      const completionLaunch = (await execute("background_bash", {
        command: "printf 'completion-smoke\\n'",
        description: "SDK completion smoke",
      })) as { details: { jobs: Array<{ jobId: string; outputPath: string }> } };
      await new Promise((resolve) => setTimeout(resolve, 100));
      await handlers.get("agent_settled")!({}, context);
      const completionJob = completionLaunch.details.jobs[0]!;
      const completionMessage = messages.find(
        ({ message }) =>
          message.customType === "background-process-completion" &&
          (message.details as { jobs: Array<{ jobId: string }> }).jobs.some(
            (job) => job.jobId === completionJob.jobId,
          ),
      )!;
      expect(completionMessage.message).toMatchObject({
        customType: "background-process-completion",
        display: true,
        details: {
          omittedCount: 0,
          jobs: [
            {
              jobId: completionJob.jobId,
              outputPath: completionJob.outputPath,
              status: "completed",
              deliveryState: "sending",
            },
          ],
        },
      });
      expect(completionMessage.options).toEqual({ deliverAs: "followUp", triggerTurn: true });

      const stoppableLaunch = (await execute("background_bash", {
        command: "sleep 300",
        description: "SDK stop smoke",
      })) as { details: { jobs: Array<{ jobId: string }> } };
      const stopped = (await execute("background_stop", {
        jobIds: [stoppableLaunch.details.jobs[0]!.jobId],
      })) as { details: { jobs: Array<{ status: string; deliveryState: string }> } };
      expect(stopped.details.jobs[0]).toMatchObject({
        status: "cancelled",
        deliveryState: "consumed",
      });

      const theme = { fg: (_color: string, text: string) => text };
      const monitorRendered = renderers.get("background-monitor-event")!(
        monitorMessage.message as never,
        { expanded: false } as never,
        theme as never,
      ) as { render: (width: number) => string[] };
      const completionRendered = renderers.get("background-process-completion")!(
        completionMessage.message as never,
        { expanded: false } as never,
        theme as never,
      ) as { render: (width: number) => string[] };
      expect(monitorRendered.render(200).join("\n").trimEnd()).toBe(`◆ ${monitorJob.jobId} #1 1-2`);
      expect(completionRendered.render(200).join("\n").trimEnd()).toBe(
        `✓ ${completionJob.jobId} completed`,
      );

      await handlers.get("session_shutdown")!({ reason: "quit" }, context);
      started = false;
      console.log(
        "SDK harness boundary: Pi RPC has no direct tool-execute request; real registered execute handlers covered background_bash/status/wait/stop/monitor plus message renderers.",
      );
    } finally {
      if (started) await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
      if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
  }, 15_000);
});
