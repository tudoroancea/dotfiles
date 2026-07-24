import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { withHerdrBlocked, type ExtensionEventBus } from "../../../lib/herdr-blocked.ts";
import type { ProcessRuntime } from "../runtime/process-runtime.ts";
import type { JobRecord } from "../runtime/types.ts";
import {
  boundText,
  formatCommand,
  formatCwd,
  formatDuration,
  formatStatus,
  sanitizeRenderedValue,
} from "./formatters.ts";

const MAX_DETAIL_COMMAND = 4_000;
const MAX_DETAIL_OUTPUT = 20_000;
const DETAIL_OUTPUT_HEIGHT = 10;
const UPDATE_COALESCE_MS = 50;
const ELAPSED_TICK_MS = 1_000;

export { formatDuration };

export function jobDuration(job: JobRecord, now = Date.now()): string {
  const started = Date.parse(job.createdAt);
  const ended = job.completedAt ? Date.parse(job.completedAt) : now;
  return formatDuration(
    Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
  );
}

function kindLabel(job: JobRecord): string {
  return job.kind === "background_event_stream" ? "event stream" : "background command";
}

function hasWarning(job: JobRecord): boolean {
  return Boolean(
    job.deliveryError ||
    job.deliveryPersistenceError ||
    job.monitor?.deliveryError ||
    job.monitorDeliveryPersistenceError,
  );
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
      const status = formatStatus(job.status);
      return `${status.icon} ${job.id} ${status.label} ${jobDuration(job)}${hasWarning(job) ? " ! delivery-error" : ""}`;
    })
    .join(" · ");
  return `${running} running, ${jobs.length} recent · ${recent}`;
}

/** Plain, width-sensitive list rows in dashboard information priority order. */
export function renderJobList(
  jobs: JobRecord[],
  selectedJobId: string | undefined,
  width: number,
  now = Date.now(),
): string[] {
  const lines: string[] = [];
  for (const job of jobs) {
    const status = formatStatus(job.status);
    const marker = job.id === selectedJobId ? ">" : " ";
    lines.push(
      truncateToWidth(`${marker} ${status.icon} ${status.label} · ${formatCwd(job.cwd)}`, width),
    );

    const elapsed = jobDuration(job, now);
    const optional = [
      width >= 72 ? kindLabel(job) : "",
      width >= 88 && hasWarning(job) ? "! delivery warning" : "",
      width >= 112 ? job.id : "",
    ].filter(Boolean);
    const suffix = ` · ${elapsed}${optional.length ? ` · ${optional.join(" · ")}` : ""}`;
    const commandWidth = Math.max(1, width - 4 - suffix.length);
    const command = formatCommand(job.command, { maximum: commandWidth, singleLine: true });
    lines.push(truncateToWidth(`  $ ${command}${suffix}`, width));
  }
  return lines;
}

function wrapped(value: string, width: number): string[] {
  return value.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

function outputTail(job: JobRecord): string {
  const content = job.terminalTail?.content;
  if (!content)
    return job.outputBytes
      ? `${job.outputBytes} bytes captured; no tail available`
      : "(no output captured yet)";
  const safe = sanitizeRenderedValue(content).trim();
  if (safe.length <= MAX_DETAIL_OUTPUT) return safe;
  return `[Earlier output omitted]\n${safe.slice(-MAX_DETAIL_OUTPUT)}`;
}

interface DetailRenderOptions {
  outputHeight?: number;
  outputOffset?: number;
  wrappedOutput?: string[];
}

function outputViewport(lines: string[], height: number, offset: number): string[] {
  const boundedHeight = Math.max(1, height);
  const maximumOffset = Math.max(0, lines.length - boundedHeight);
  const boundedOffset = Math.max(0, Math.min(maximumOffset, offset));
  const end = lines.length - boundedOffset;
  const visible = lines.slice(Math.max(0, end - boundedHeight), end);
  return [...visible, ...Array.from({ length: boundedHeight - visible.length }, () => "")];
}

/** Plain detail view in the required information hierarchy. */
export function renderJobDetail(
  job: JobRecord,
  width: number,
  now = Date.now(),
  options: DetailRenderOptions = {},
): string[] {
  const status = formatStatus(job.status);
  const command = formatCommand(job.command, { maximum: MAX_DETAIL_COMMAND });
  const monitor = job.monitor;
  const terminal = [
    job.requestedTerminalCause
      ? `Terminal cause: ${sanitizeRenderedValue(job.requestedTerminalCause)}`
      : "",
    job.exitCode !== undefined ? `Exit: ${job.exitCode ?? "signal"}` : "",
    job.error ? `Error: ${sanitizeRenderedValue(job.error)}` : "",
  ].filter(Boolean);
  const delivery = [
    `Completion: ${job.deliveryState}`,
    job.deliveryError ? `Send error: ${sanitizeRenderedValue(job.deliveryError)}` : "",
    job.deliveryPersistenceError
      ? `Checkpoint error: ${sanitizeRenderedValue(job.deliveryPersistenceError)}`
      : "",
    monitor
      ? `Event stream: ${monitor.deliveries} deliveries · ${monitor.deliveredLines} lines · ${monitor.droppedLines} dropped${monitor.captureOnly ? " · capture-only" : ""}`
      : "",
    monitor?.deliveryError
      ? `Event send error: ${sanitizeRenderedValue(monitor.deliveryError)}`
      : "",
    job.monitorDeliveryPersistenceError
      ? `Event checkpoint error: ${sanitizeRenderedValue(job.monitorDeliveryPersistenceError)}`
      : "",
  ].filter(Boolean);
  const outputLines = options.wrappedOutput ?? wrapped(outputTail(job), width);
  const output = outputViewport(
    outputLines,
    options.outputHeight ?? DETAIL_OUTPUT_HEIGHT,
    options.outputOffset ?? 0,
  );
  const lines = [
    `${status.icon} ${status.label} · ${jobDuration(job, now)} · ${kindLabel(job)}`,
    "",
    "Working directory",
    formatCwd(job.cwd),
    "",
    "Command",
    ...wrapped(`$ ${command}`, width),
    "",
    "Terminal",
    ...(terminal.length ? terminal : ["(still running)"]),
    "",
    "Output tail",
    ...output,
    "",
    "Delivery health",
    ...delivery,
    "",
    "Artifacts",
    job.outputPath ? `Output: ${sanitizeRenderedValue(job.outputPath)}` : "Output: unavailable",
    job.metadataPath
      ? `Metadata: ${sanitizeRenderedValue(job.metadataPath)}`
      : "Metadata: unavailable",
  ];
  return lines.map((line) => truncateToWidth(line, width));
}

interface DashboardOptions {
  initialJobId?: string;
  onClose: () => void;
  onStop: (jobId: string) => void;
  loadTail: (jobId: string) => JobRecord;
  requestRender: () => void;
  subscribe?: (listener: (jobs: JobRecord[]) => void) => () => void;
  now?: () => number;
}

interface OutputCache {
  jobId: string;
  outputBytes: number;
  content: string | undefined;
  width: number;
  lines: string[];
}

export class BackgroundDashboard {
  private selectedJobId: string | undefined;
  private detailJobId: string | undefined;
  private outputOffset = 0;
  private maximumOutputOffset = 0;
  private outputCache?: OutputCache;
  private pendingJobs?: JobRecord[];
  private repaintTimer?: NodeJS.Timeout;
  private elapsedTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(
    private jobs: JobRecord[],
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: DashboardOptions,
  ) {
    this.selectedJobId = jobs.find((job) => job.id === options.initialJobId)?.id ?? jobs[0]?.id;
    this.detailJobId = options.initialJobId ? this.selectedJobId : undefined;
    if (options.subscribe) {
      this.unsubscribe = options.subscribe((freshJobs) => this.queueJobs(freshJobs));
      this.elapsedTimer = setInterval(() => this.options.requestRender(), ELAPSED_TICK_MS);
    }
  }

  replaceJobs(jobs: JobRecord[]): void {
    this.jobs = jobs;
    if (!jobs.some((job) => job.id === this.selectedJobId)) {
      this.selectedJobId = jobs[0]?.id;
    }
    if (!jobs.some((job) => job.id === this.detailJobId)) {
      this.detailJobId = undefined;
      this.outputOffset = 0;
    }
    this.options.requestRender();
  }

  replaceJob(job: JobRecord): void {
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id);
    if (index >= 0) this.jobs[index] = job;
    else this.jobs.push(job);
    this.options.requestRender();
  }

  private queueJobs(jobs: JobRecord[]): void {
    if (this.disposed) return;
    this.pendingJobs = jobs;
    if (this.repaintTimer) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined;
      const pending = this.pendingJobs;
      this.pendingJobs = undefined;
      if (pending && !this.disposed) this.replaceJobs(pending);
    }, UPDATE_COALESCE_MS);
  }

  private move(delta: number): void {
    if (!this.jobs.length) return;
    if (this.detailJobId) {
      this.outputOffset = Math.max(
        0,
        Math.min(this.maximumOutputOffset, this.outputOffset + delta),
      );
      return;
    }
    const current = this.jobs.findIndex((job) => job.id === this.selectedJobId);
    const index = Math.max(0, Math.min(this.jobs.length - 1, current + delta));
    this.selectedJobId = this.jobs[index]?.id;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.detailJobId) {
        this.detailJobId = undefined;
        this.outputOffset = 0;
      } else this.options.onClose();
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (!this.detailJobId && this.selectedJobId) {
        const job = this.options.loadTail(this.selectedJobId);
        this.replaceJob(job);
        this.detailJobId = this.selectedJobId;
        this.outputOffset = 0;
      }
    } else if (matchesKey(data, "k")) {
      this.move(this.detailJobId ? 1 : -1);
    } else if (matchesKey(data, "j")) {
      this.move(this.detailJobId ? -1 : 1);
    } else if (this.detailJobId && this.keybindings.matches(data, "tui.select.pageUp")) {
      this.move(DETAIL_OUTPUT_HEIGHT - 1);
    } else if (this.detailJobId && this.keybindings.matches(data, "tui.select.pageDown")) {
      this.move(-(DETAIL_OUTPUT_HEIGHT - 1));
    } else if (this.detailJobId && matchesKey(data, "g")) {
      this.outputOffset = this.maximumOutputOffset;
    } else if (this.detailJobId && data === "G") {
      this.outputOffset = 0;
    } else if (matchesKey(data, "x")) {
      const jobId = this.detailJobId ?? this.selectedJobId;
      if (jobId) this.options.onStop(jobId);
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const detail = this.jobs.find((job) => job.id === this.detailJobId);
    const title = detail ? "Background task" : `Background tasks · ${this.jobs.length}`;
    let content: string[];
    if (detail) {
      const output = outputTail(detail);
      if (
        !this.outputCache ||
        this.outputCache.jobId !== detail.id ||
        this.outputCache.outputBytes !== detail.outputBytes ||
        this.outputCache.content !== detail.terminalTail?.content ||
        this.outputCache.width !== contentWidth
      ) {
        this.outputCache = {
          jobId: detail.id,
          outputBytes: detail.outputBytes,
          content: detail.terminalTail?.content,
          width: contentWidth,
          lines: wrapped(output, contentWidth),
        };
      }
      this.maximumOutputOffset = Math.max(0, this.outputCache.lines.length - DETAIL_OUTPUT_HEIGHT);
      this.outputOffset = Math.min(this.outputOffset, this.maximumOutputOffset);
      content = renderJobDetail(detail, contentWidth, this.options.now?.() ?? Date.now(), {
        outputHeight: DETAIL_OUTPUT_HEIGHT,
        outputOffset: this.outputOffset,
        wrappedOutput: this.outputCache.lines,
      });
    } else {
      content = renderJobList(
        this.jobs,
        this.selectedJobId,
        contentWidth,
        this.options.now?.() ?? Date.now(),
      );
    }
    const key = (
      binding:
        | "tui.select.pageUp"
        | "tui.select.pageDown"
        | "tui.select.confirm"
        | "tui.select.cancel",
    ) => this.keybindings.getKeys(binding).join("/") || "unbound";
    const help = detail
      ? `j/k scroll · ${key("tui.select.pageUp")}/${key("tui.select.pageDown")} page · g/G ends · ${key("tui.select.cancel")} back · x stop`
      : `j/k navigate · ${key("tui.select.confirm")} inspect · ${key("tui.select.cancel")} close · x stop`;
    if (width < 6) {
      return [
        truncateToWidth(this.theme.fg("accent", this.theme.bold(title)), width),
        ...content.map((line) => truncateToWidth(line, width)),
        truncateToWidth(this.theme.fg("dim", help), width),
      ];
    }

    const topLabel = truncateToWidth(` ${title} `, width - 4, "…");
    const topFill = "─".repeat(Math.max(0, width - visibleWidth(topLabel) - 4));
    const helpLabel = truncateToWidth(` ${help} `, width - 4, "…");
    const helpFill = "─".repeat(Math.max(0, width - visibleWidth(helpLabel) - 4));
    const lines = [
      `${this.theme.fg("dim", "╭─")}${this.theme.fg("accent", this.theme.bold(topLabel))}${this.theme.fg("dim", `${topFill}─╮`)}`,
    ];
    for (const line of content) {
      const bounded = truncateToWidth(line, contentWidth, "…");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(bounded)));
      lines.push(`${this.theme.fg("dim", "│ ")}${bounded}${padding}${this.theme.fg("dim", " │")}`);
    }
    lines.push(
      `${this.theme.fg("dim", `╰─${helpFill}`)}${this.theme.fg("dim", helpLabel)}${this.theme.fg("dim", "─╯")}`,
    );
    return lines;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.repaintTimer = undefined;
    this.elapsedTimer = undefined;
    this.pendingJobs = undefined;
  }

  invalidate(): void {
    this.outputCache = undefined;
  }
}

function errorMessage(error: unknown): string {
  return boundText(
    sanitizeRenderedValue(error instanceof Error ? error.message : String(error)).trim(),
    MAX_DETAIL_OUTPUT,
  );
}

function withTail(runtime: ProcessRuntime, jobId: string): JobRecord {
  const job = runtime.resolve([jobId])[0]!;
  const tail = runtime.tail(jobId);
  return tail ? { ...job, terminalTail: tail } : job;
}

export async function showBackgroundTasks(
  events: ExtensionEventBus,
  ctx: ExtensionCommandContext,
  runtime: ProcessRuntime,
  initialJobId?: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    try {
      const message = initialJobId
        ? renderJobDetail(withTail(runtime, initialJobId), 240).join("\n")
        : compactTaskSummary(runtime);
      ctx.ui.notify(message, "info");
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
    return;
  }

  let jobs: JobRecord[];
  try {
    jobs = sortedJobs(runtime);
    if (!jobs.length) {
      ctx.ui.notify("No background tasks yet.", "info");
      return;
    }
    if (initialJobId) {
      if (!jobs.some((job) => job.id === initialJobId)) runtime.resolve([initialJobId]);
      jobs = jobs.map((job) => (job.id === initialJobId ? withTail(runtime, job.id) : job));
    }
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return;
  }

  let dashboard: BackgroundDashboard | undefined;
  try {
    await withHerdrBlocked(events, "Waiting for background task dashboard input", () =>
      ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        let activeDashboard: BackgroundDashboard;
        const stop = async (jobId: string): Promise<void> => {
          try {
            const fresh = runtime.resolve([jobId])[0]!;
            activeDashboard.replaceJob(fresh);
            if (fresh.status !== "running") {
              ctx.ui.notify(`${jobId} is no longer running.`, "info");
              return;
            }
            const confirmed = await ctx.ui.confirm(
              "Stop background task?",
              `${jobId} · ${formatCommand(fresh.command, { maximum: 120, singleLine: true })}`,
            );
            if (!confirmed) return;
            await runtime.stopManyResult([jobId]);
            activeDashboard.replaceJob(withTail(runtime, jobId));
            ctx.ui.notify(`Stop requested for ${jobId}.`, "info");
          } catch (error) {
            ctx.ui.notify(errorMessage(error), "error");
          }
        };
        activeDashboard = new BackgroundDashboard(jobs, theme, keybindings, {
          initialJobId,
          onClose: () => done(undefined),
          onStop: (jobId) => void stop(jobId),
          loadTail: (jobId) => withTail(runtime, jobId),
          requestRender: () => tui.requestRender(),
          subscribe:
            typeof runtime.subscribe === "function"
              ? (listener) => runtime.subscribe(() => listener(sortedJobs(runtime)))
              : undefined,
        });
        dashboard = activeDashboard;
        return activeDashboard;
      }),
    );
  } finally {
    dashboard?.dispose();
  }
}
