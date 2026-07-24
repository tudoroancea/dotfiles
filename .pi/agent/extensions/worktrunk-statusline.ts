import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";

const MARKERS = {
  working: "🤖",
  waiting: "💬",
} as const;

const STATUSLINE_REFRESH_MS = 15_000;
const WT_TIMEOUT_MS = 4_000;

type AgentState = keyof typeof MARKERS;

type StatuslineSnapshot = {
  cwd: string;
  hasUI: boolean;
  modelDisplayName?: string;
  contextPercent?: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
};

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/g, "");
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; stdin?: string; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;
    let timedOut = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(forceKillId);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        code: -1,
        error,
        timedOut,
      });
    });

    child.on("close", (code) => {
      finish({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        code: code ?? -1,
        timedOut,
      });
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? WT_TIMEOUT_MS);

    const forceKillId = setTimeout(
      () => {
        if (!settled) child.kill("SIGKILL");
      },
      (options.timeoutMs ?? WT_TIMEOUT_MS) + 250,
    );

    if (options.stdin) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

function getModelDisplayName(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { name?: string; id?: string } | undefined;
  return model?.name ?? model?.id;
}

function getContextPercent(ctx: ExtensionContext): number | undefined {
  const usage = ctx.getContextUsage();
  if (!usage || usage.percent == null || !Number.isFinite(usage.percent)) return undefined;
  return Number(usage.percent.toFixed(1));
}

function takeStatuslineSnapshot(ctx: ExtensionContext): StatuslineSnapshot {
  return {
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    modelDisplayName: getModelDisplayName(ctx),
    contextPercent: getContextPercent(ctx),
  };
}

function buildStatuslineContext(snapshot: StatuslineSnapshot): string {
  const payload: Record<string, unknown> = {
    workspace: { current_dir: snapshot.cwd },
  };

  if (snapshot.modelDisplayName) payload.model = { display_name: snapshot.modelDisplayName };

  if (snapshot.contextPercent != null) {
    payload.context_window = { used_percentage: snapshot.contextPercent };
  }

  return JSON.stringify(payload);
}

export default function (pi: ExtensionAPI) {
  let agentState: AgentState = "waiting";
  let lastSnapshot: StatuslineSnapshot | undefined;
  let statusline = "";
  let statuslineError: string | undefined;
  let requestRender: (() => void) | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let refreshPending = false;
  let currentBranch: string | null = null;
  let lastMarkerKey: string | undefined;
  let worktrunkMissing = false;
  let shuttingDown = false;
  let disposeFooterResources: (() => void) | undefined;

  const rememberContext = (ctx: ExtensionContext) => {
    const snapshot = takeStatuslineSnapshot(ctx);
    lastSnapshot = snapshot;
    return snapshot;
  };

  const queueRefresh = (snapshot: StatuslineSnapshot, delayMs = 0) => {
    if (shuttingDown || worktrunkMissing || !snapshot.hasUI) return;
    lastSnapshot = snapshot;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refreshStatusline();
    }, delayMs);
  };

  const refreshStatusline = async () => {
    const snapshot = lastSnapshot;
    if (!snapshot || shuttingDown || worktrunkMissing) return;
    if (refreshInFlight) {
      refreshPending = true;
      return;
    }

    refreshInFlight = (async () => {
      const result = await runCommand(
        "wt",
        ["-C", snapshot.cwd, "list", "statusline", "--format=claude-code"],
        {
          cwd: snapshot.cwd,
          stdin: buildStatuslineContext(snapshot),
          timeoutMs: WT_TIMEOUT_MS,
        },
      );

      if (shuttingDown) return;

      if (result.error?.code === "ENOENT") {
        worktrunkMissing = true;
        statuslineError = "worktrunk not installed";
        requestRender?.();
        return;
      }

      if (result.timedOut) {
        statuslineError = "worktrunk status timed out";
        requestRender?.();
        return;
      }

      if (result.code !== 0) {
        statuslineError = stripTrailingNewlines(result.stderr) || "worktrunk status unavailable";
        requestRender?.();
        return;
      }

      const nextLine = stripTrailingNewlines(result.stdout);
      if (!nextLine) {
        statuslineError = "worktrunk returned an empty status line";
        requestRender?.();
        return;
      }

      statusline = nextLine;
      statuslineError = undefined;
      requestRender?.();
    })().finally(() => {
      refreshInFlight = undefined;
      if (refreshPending && !shuttingDown) {
        refreshPending = false;
        void refreshStatusline();
      } else {
        refreshPending = false;
      }
    });

    await refreshInFlight;
  };

  const runMarkerCommand = async (cwd: string, args: string[]) => {
    if (worktrunkMissing) return false;

    const result = await runCommand("wt", args, {
      cwd,
      timeoutMs: WT_TIMEOUT_MS,
    });

    if (result.error?.code === "ENOENT") {
      worktrunkMissing = true;
      return false;
    }

    return result.code === 0;
  };

  const setMarker = async (
    snapshot: StatuslineSnapshot,
    marker: string | undefined,
    branch?: string | null,
  ) => {
    const args = ["-C", snapshot.cwd, "config", "state", "marker", marker ? "set" : "clear"];
    if (marker) args.push(marker);
    if (branch) args.push("--branch", branch);
    return runMarkerCommand(snapshot.cwd, args);
  };

  const applyMarkerState = async (snapshot: StatuslineSnapshot) => {
    if (shuttingDown) return;

    const marker = MARKERS[agentState];
    const markerKey = `${currentBranch ?? ""}:${marker}`;
    if (lastMarkerKey === markerKey) return;

    const ok = await setMarker(snapshot, marker, currentBranch);
    if (!ok || shuttingDown) return;

    lastMarkerKey = markerKey;
    queueRefresh(snapshot, 0);
  };

  const clearMarker = async (
    snapshot: StatuslineSnapshot,
    branch?: string | null,
    options: { refresh?: boolean } = {},
  ) => {
    const markerKey = `${branch ?? currentBranch ?? ""}:clear`;
    if (lastMarkerKey === markerKey) return;

    const ok = await setMarker(snapshot, undefined, branch ?? currentBranch);
    if (!ok) return;

    lastMarkerKey = markerKey;
    if (options.refresh ?? true) queueRefresh(snapshot, 0);
  };

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    const snapshot = rememberContext(ctx);
    agentState = "waiting";
    statusline = "";
    statuslineError = undefined;
    currentBranch = null;
    lastMarkerKey = undefined;
    refreshPending = false;

    if (snapshot.hasUI) {
      ctx.ui.setFooter((tui, theme, footerData) => {
        disposeFooterResources?.();

        requestRender = () => tui.requestRender();
        currentBranch = footerData.getGitBranch();

        const intervalId = setInterval(() => {
          void refreshStatusline();
        }, STATUSLINE_REFRESH_MS);

        const unsubscribeBranch = footerData.onBranchChange(() => {
          const previousBranch = currentBranch;
          currentBranch = footerData.getGitBranch();
          tui.requestRender();

          const snapshot = lastSnapshot;
          if (!snapshot || shuttingDown) return;

          if (previousBranch && previousBranch !== currentBranch) {
            void clearMarker(snapshot, previousBranch).then(() => {
              const latestSnapshot = lastSnapshot;
              if (latestSnapshot && !shuttingDown) void applyMarkerState(latestSnapshot);
            });
          } else {
            void applyMarkerState(snapshot);
          }

          queueRefresh(snapshot, 0);
        });

        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          clearInterval(intervalId);
          unsubscribeBranch();
          if (disposeFooterResources === dispose) disposeFooterResources = undefined;
          requestRender = undefined;
        };

        disposeFooterResources = dispose;
        queueRefresh(snapshot, 0);

        return {
          dispose,
          invalidate() {},
          render(width: number): string[] {
            const primaryLine = statusline
              ? statusline
              : theme.fg("dim", sanitizeStatusText(statuslineError ?? "Loading worktrunk status…"));

            const lines = [truncateToWidth(primaryLine, width, theme.fg("dim", "..."))];
            const extensionStatuses = Array.from(footerData.getExtensionStatuses().entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatusText(text))
              .filter(Boolean);

            if (extensionStatuses.length > 0) {
              lines.push(
                truncateToWidth(extensionStatuses.join(" "), width, theme.fg("dim", "...")),
              );
            }

            return lines;
          },
        };
      });
    }

    void applyMarkerState(snapshot);
  });

  pi.on("session_switch", async (_event, ctx) => {
    const snapshot = rememberContext(ctx);
    agentState = "waiting";
    void applyMarkerState(snapshot);
    queueRefresh(snapshot, 0);
  });

  pi.on("session_fork", async (_event, ctx) => {
    const snapshot = rememberContext(ctx);
    agentState = "waiting";
    void applyMarkerState(snapshot);
    queueRefresh(snapshot, 0);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const snapshot = rememberContext(ctx);
    agentState = "working";
    void applyMarkerState(snapshot);
    queueRefresh(snapshot, 0);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const snapshot = rememberContext(ctx);
    agentState = "waiting";
    void applyMarkerState(snapshot);
    queueRefresh(snapshot, 0);
  });

  pi.on("model_select", async (_event, ctx) => {
    const snapshot = rememberContext(ctx);
    queueRefresh(snapshot, 0);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const snapshot = takeStatuslineSnapshot(ctx);
    shuttingDown = true;
    lastSnapshot = undefined;
    refreshPending = false;

    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }

    disposeFooterResources?.();
    disposeFooterResources = undefined;

    await clearMarker(snapshot, undefined, { refresh: false });
  });
}
