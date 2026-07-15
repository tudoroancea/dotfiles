import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { RunEngine } from "../runtime/run-engine.ts";
import type { NodeSnapshot, RunSnapshot } from "../types.ts";

const MAX_INSPECT_CHARS = 20_000;

function statusIcon(status: RunSnapshot["status"] | NodeSnapshot["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "aborted") return "✗";
  if (status === "running") return "◆";
  return "·";
}

function bounded(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null");
  } catch {
    text = "[Value is not serializable]";
  }
  return text.length <= MAX_INSPECT_CHARS
    ? text
    : `${text.slice(0, MAX_INSPECT_CHARS)}\n\n[View truncated at ${MAX_INSPECT_CHARS} characters. See workflow artifacts for the persisted result.]`;
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

function transcript(snapshot: RunSnapshot): string {
  const lines = [
    `${snapshot.name ?? snapshot.kind} (${snapshot.runId})`,
    `Status: ${snapshot.status}`,
    snapshot.semanticRole ? `Role: ${snapshot.semanticRole}` : "",
    snapshot.originTool ? `Origin: ${snapshot.originTool}` : "",
    snapshot.artifactDir ? `Artifacts: ${snapshot.artifactDir}` : "",
    "",
  ];
  for (const node of snapshot.nodes) {
    lines.push(
      `${statusIcon(node.status)} ${node.label} (${node.id})`,
      `  status=${node.status} tools=${node.tools} tokens=${node.usage.total}${node.semanticRole ? ` role=${node.semanticRole}` : ""}${node.originTool ? ` origin=${node.originTool}` : ""}`,
    );
    if (node.sessionFile) lines.push(`  session=${node.sessionFile}`);
    if (node.error) lines.push(`  error=${node.error}`);
    if (node.resultPreview) lines.push(`  ${node.resultPreview}`);
    lines.push("");
  }
  if (snapshot.logs.length) lines.push("Logs:", ...snapshot.logs.map((line) => `  ${line}`));
  return bounded(lines.filter((line, index) => line || index > 0).join("\n"));
}

async function inspectTasks(ctx: ExtensionCommandContext, snapshot: RunSnapshot): Promise<void> {
  if (!snapshot.nodes.length) {
    ctx.ui.notify("This run has not scheduled any tasks yet.", "info");
    return;
  }
  const taskId = await select(
    ctx,
    `${snapshot.runId} · tasks`,
    snapshot.nodes.map((node) => ({
      value: node.id,
      label: `${statusIcon(node.status)} ${node.label}`,
      description: `${node.id} · ${node.status} · ${node.tools} tools · ${node.usage.total} tokens`,
    })),
  );
  if (!taskId) return;
  const node = snapshot.nodes.find((candidate) => candidate.id === taskId);
  if (node) await ctx.ui.editor(`Agentflow task · ${node.id}`, bounded(node));
}

async function steerRun(
  ctx: ExtensionCommandContext,
  engine: RunEngine,
  snapshot: RunSnapshot,
): Promise<void> {
  const running = snapshot.nodes.filter((node) => node.status === "running");
  if (!running.length) {
    ctx.ui.notify("No running task is available to steer.", "warning");
    return;
  }
  const nodeId =
    running.length === 1
      ? running[0].id
      : await select(
          ctx,
          `${snapshot.runId} · choose task to steer`,
          running.map((node) => ({ value: node.id, label: node.label, description: node.id })),
        );
  if (!nodeId) return;
  const message = await ctx.ui.input("Steer child task", "Additional instruction");
  if (!message?.trim()) return;
  await engine.steer(snapshot.runId, nodeId, message.trim());
  ctx.ui.notify(`Steering accepted for ${nodeId}.`, "info");
}

async function showRun(
  ctx: ExtensionCommandContext,
  engine: RunEngine,
  runId: string,
): Promise<void> {
  for (;;) {
    const snapshot = engine.getSnapshot(runId) as RunSnapshot;
    const active = snapshot.status === "running" || snapshot.status === "queued";
    const completed = snapshot.nodes.filter((node) => node.status === "completed").length;
    const items: SelectItem[] = [
      {
        value: "tasks",
        label: "Tasks",
        description: `${completed}/${snapshot.nodes.length} completed`,
      },
      { value: "transcript", label: "Transcript", description: "Bounded task output and run logs" },
      { value: "result", label: "Result", description: snapshot.resultPreview ?? "No result yet" },
    ];
    if (snapshot.artifactDir)
      items.push({ value: "artifact", label: "Artifact path", description: snapshot.artifactDir });
    if (active) {
      items.push({
        value: "steer",
        label: "Steer",
        description: "Send instructions to a live task",
      });
      items.push({
        value: "cancel",
        label: "Cancel run",
        description: "Abort queued and active tasks",
      });
      items.push({ value: "refresh", label: "Refresh", description: "Reload this run snapshot" });
    }
    items.push({ value: "back", label: "Back", description: "Return to recent runs" });

    const action = await select(
      ctx,
      `${statusIcon(snapshot.status)} ${snapshot.name ?? snapshot.kind} · ${snapshot.runId} · ${snapshot.status}`,
      items,
    );
    if (!action || action === "back") return;
    try {
      if (action === "tasks") await inspectTasks(ctx, snapshot);
      else if (action === "transcript")
        await ctx.ui.editor(`Agentflow transcript · ${runId}`, transcript(snapshot));
      else if (action === "result") {
        const result = engine.getResult(runId);
        await ctx.ui.editor(
          `Agentflow result · ${runId}`,
          bounded(result?.result ?? snapshot.resultPreview),
        );
      } else if (action === "artifact" && snapshot.artifactDir) {
        ctx.ui.setEditorText(snapshot.artifactDir);
        ctx.ui.notify("Artifact path copied to the input editor.", "info");
      } else if (action === "steer") await steerRun(ctx, engine, snapshot);
      else if (action === "cancel") {
        const confirmed = await ctx.ui.confirm(
          "Cancel Agentflow run?",
          `${runId} · ${snapshot.name ?? snapshot.kind}`,
        );
        if (confirmed) {
          await engine.cancel([runId]);
          ctx.ui.notify(`Cancellation requested for ${runId}.`, "info");
        }
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

async function showDashboard(
  ctx: ExtensionCommandContext,
  engine: RunEngine,
  initialRunId?: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "/agentflow requires interactive TUI mode; use agentflow_status in RPC mode.",
      "error",
    );
    return;
  }
  if (initialRunId) {
    await showRun(ctx, engine, initialRunId);
    return;
  }
  for (;;) {
    const snapshots = engine.getSnapshot() as RunSnapshot[];
    if (!snapshots.length) {
      ctx.ui.notify("No Agentflow runs yet.", "info");
      return;
    }
    const runId = await select(
      ctx,
      "Agentflow runs",
      snapshots.map((run) => {
        const completed = run.nodes.filter((node) => node.status === "completed").length;
        return {
          value: run.runId,
          label: `${statusIcon(run.status)} ${run.name ?? run.kind}`,
          description: `${run.runId} · ${run.status} · ${completed}/${run.nodes.length}${run.artifactDir ? " · artifacts" : ""}`,
        };
      }),
      "↑↓ navigate • enter inspect • esc close",
    );
    if (!runId) return;
    await showRun(ctx, engine, runId);
  }
}

export function registerDashboard(pi: ExtensionAPI, engine: RunEngine): void {
  pi.registerCommand("agentflow", {
    description: "Open the Agentflow run dashboard: /agentflow [runId]",
    handler: async (args, ctx) => showDashboard(ctx, engine, args.trim() || undefined),
  });
}
