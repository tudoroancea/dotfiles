import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ProcessRuntime } from "../runtime/process-runtime.ts";
import { sanitizeMonitorText } from "../runtime/monitor.ts";
import type { JobRecord, JobStatus } from "../runtime/types.ts";

const MAX_INSPECT_CHARS = 20_000;

function safe(value: string | undefined): string {
  return sanitizeMonitorText(value ?? "").trim();
}

function safeMultiline(value: string): string {
  return value.split("\n").map(sanitizeMonitorText).join("\n").trim();
}

function bounded(value: string): string {
  if (value.length <= MAX_INSPECT_CHARS) return value;
  return `${value.slice(0, MAX_INSPECT_CHARS)}\n\n[View truncated at ${MAX_INSPECT_CHARS} characters. Inspect the output artifact for the complete content.]`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function jobDuration(job: JobRecord, now = Date.now()): string {
  const started = Date.parse(job.createdAt);
  const ended = job.completedAt ? Date.parse(job.completedAt) : now;
  return formatDuration(
    Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
  );
}

function statusIcon(status: JobStatus): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "cleanup_failed") return "✗";
  if (status === "running") return "◆";
  return "◇";
}

function boundedTail(value: string): string {
  if (value.length <= MAX_INSPECT_CHARS) return value;
  return `[Earlier output omitted]\n${value.slice(-MAX_INSPECT_CHARS)}`;
}

function jobName(job: JobRecord): string {
  const label = safe(job.description || job.command).replace(/\s+/g, " ");
  if (!label) return job.id;
  return label.length <= 80 ? label : `${label.slice(0, 79)}…`;
}

function sortedJobs(runtime: ProcessRuntime): JobRecord[] {
  return runtime.list().sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (right.status === "running" && left.status !== "running") return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

export function compactTaskSummary(runtime: ProcessRuntime): string {
  const jobs = sortedJobs(runtime);
  if (!jobs.length) return "No background tasks yet.";
  const running = jobs.filter((job) => job.status === "running").length;
  const recent = jobs
    .slice(0, 3)
    .map((job) => {
      const warning =
        job.deliveryError ||
        job.deliveryPersistenceError ||
        job.monitor?.deliveryError ||
        job.monitorDeliveryPersistenceError
          ? " ! delivery-error"
          : "";
      return `${statusIcon(job.status)} ${job.id} ${job.status} ${jobDuration(job)}${warning}`;
    })
    .join(" · ");
  return `${running} running, ${jobs.length} recent · ${recent}`;
}

async function select(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  help = "↑↓ navigate • enter select • esc back",
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), 14), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", help), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function overview(job: JobRecord): string {
  const monitor = job.monitor;
  return bounded(
    [
      `${statusIcon(job.status)} ${jobName(job)}`,
      `ID: ${safe(job.id)}`,
      `Type: ${job.kind === "background_event_stream" ? "event stream" : "background command"}`,
      `Status: ${job.status}`,
      `Runtime: ${jobDuration(job)}`,
      `Started: ${safe(job.createdAt)}`,
      job.completedAt ? `Finished: ${safe(job.completedAt)}` : "",
      job.exitCode !== undefined ? `Exit code: ${job.exitCode ?? "signal"}` : "",
      job.requestedTerminalCause ? `Terminal cause: ${job.requestedTerminalCause}` : "",
      `Working directory: ${safe(job.cwd)}`,
      `Output: ${job.outputBytes} bytes`,
      job.outputPath ? `Output artifact: ${safe(job.outputPath)}` : "",
      job.metadataPath ? `Metadata artifact: ${safe(job.metadataPath)}` : "",
      `Completion delivery: ${job.deliveryState}`,
      monitor
        ? `Event stream: ${monitor.deliveries} deliveries · ${monitor.deliveredLines} lines delivered · ${monitor.droppedLines} dropped${monitor.captureOnly ? " · capture-only" : ""}`
        : "",
      job.error ? `Error: ${safe(job.error)}` : "",
      job.deliveryError ? `Delivery error: ${safe(job.deliveryError)}` : "",
      job.deliveryPersistenceError
        ? `Delivery checkpoint error: ${safe(job.deliveryPersistenceError)}`
        : "",
      monitor?.deliveryError ? `Event stream send error: ${safe(monitor.deliveryError)}` : "",
      job.monitorDeliveryPersistenceError
        ? `Event stream checkpoint error: ${safe(job.monitorDeliveryPersistenceError)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function showJob(
  ctx: ExtensionCommandContext,
  runtime: ProcessRuntime,
  jobId: string,
): Promise<void> {
  for (;;) {
    const job = runtime.resolve([jobId])[0]!;
    const items: SelectItem[] = [
      { value: "overview", label: "Overview", description: `${job.status} · ${jobDuration(job)}` },
      { value: "command", label: "Command", description: safe(job.command).split("\n")[0] },
      { value: "tail", label: "Recent output", description: `${job.outputBytes} bytes captured` },
      {
        value: "artifacts",
        label: "Artifacts",
        description: job.outputPath ? safe(job.outputPath) : "Paths unavailable",
      },
    ];
    if (job.outputPath)
      items.push({
        value: "copy-output",
        label: "Copy output path",
        description: "Place the path in the input editor",
      });
    if (job.status === "running") {
      items.push({ value: "stop", label: "Stop task", description: "Terminate its process tree" });
      items.push({ value: "refresh", label: "Refresh", description: "Reload status and runtime" });
    }
    items.push({ value: "back", label: "Back", description: "Return to recent tasks" });

    const action = await select(
      ctx,
      `${statusIcon(job.status)} ${jobName(job)} · ${job.id}`,
      items,
    );
    if (!action || action === "back") return;
    if (action === "overview") await ctx.ui.editor(`Background task · ${job.id}`, overview(job));
    else if (action === "command")
      await ctx.ui.editor(`Command · ${job.id}`, bounded(safeMultiline(job.command)));
    else if (action === "tail") {
      const tail = runtime.tail(job.id);
      const content = tail?.content ? safeMultiline(tail.content) : "(no output captured yet)";
      await ctx.ui.editor(`Recent output · ${job.id}`, boundedTail(content));
    } else if (action === "artifacts") {
      await ctx.ui.editor(
        `Artifacts · ${job.id}`,
        [
          `Output: ${safe(job.outputPath) || "unavailable"}`,
          `Metadata: ${safe(job.metadataPath) || "unavailable"}`,
        ].join("\n"),
      );
    } else if (action === "copy-output" && job.outputPath) {
      ctx.ui.setEditorText(job.outputPath);
      ctx.ui.notify("Output path copied to the input editor.", "info");
    } else if (action === "stop") {
      const confirmed = await ctx.ui.confirm(
        "Stop background task?",
        `${job.id} · ${jobName(job)}`,
      );
      if (confirmed) {
        const stopped = (await runtime.stopManyResult([job.id])).jobs[0];
        ctx.ui.notify(
          stopped ? `${stopped.jobId} is ${stopped.status}.` : `Stop requested for ${job.id}.`,
          "info",
        );
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return bounded(safe(error instanceof Error ? error.message : String(error)));
}

export async function showBackgroundTasks(
  ctx: ExtensionCommandContext,
  runtime: ProcessRuntime,
  initialJobId?: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    try {
      ctx.ui.notify(
        initialJobId ? overview(runtime.resolve([initialJobId])[0]!) : compactTaskSummary(runtime),
        "info",
      );
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
    return;
  }
  if (initialJobId) {
    try {
      await showJob(ctx, runtime, initialJobId);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
    return;
  }
  for (;;) {
    const jobs = sortedJobs(runtime);
    if (!jobs.length) {
      ctx.ui.notify("No background tasks yet.", "info");
      return;
    }
    const jobId = await select(
      ctx,
      "Background tasks",
      jobs.map((job) => ({
        value: job.id,
        label: `${statusIcon(job.status)} ${jobName(job)}`,
        description: `${job.id} · ${job.kind === "background_event_stream" ? "event stream" : "command"} · ${job.status} · ${jobDuration(job)}`,
      })),
      "↑↓ navigate • enter inspect • esc close",
    );
    if (!jobId) return;
    try {
      await showJob(ctx, runtime, jobId);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  }
}
