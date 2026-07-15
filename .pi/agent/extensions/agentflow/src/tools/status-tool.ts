import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import { truncateToolText } from "../utils.ts";
function compactStatus(snapshot: ReturnType<RunEngine["getSnapshot"]>): string {
  const runs = Array.isArray(snapshot) ? snapshot : [snapshot];
  if (runs.length === 0) return "No Agentflow runs yet.";
  return runs
    .slice(0, 10)
    .map((run) => {
      const completed = run.nodes.filter((node) => node.status === "completed").length;
      const active = run.nodes.filter(
        (node) => node.status === "running" || node.status === "queued",
      );
      const activeLabels = active.map((node) => node.label).join(", ");
      return `${run.status === "completed" ? "✓" : run.status === "failed" || run.status === "aborted" ? "✗" : "◆"} ${run.runId} · ${run.name ?? run.kind} · ${completed}/${run.nodes.length}${activeLabels ? ` · ${activeLabels}` : ""}${run.artifactDir ? `\n  ${run.artifactDir}` : ""}`;
    })
    .join("\n");
}

export function registerStatusTool(pi: ExtensionAPI, engine: RunEngine): void {
  pi.registerTool({
    name: "agentflow_status",
    label: "Agentflow Status",
    description:
      "List recent runs or inspect one serializable run snapshot, including artifact paths.",
    parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const snapshot = engine.getSnapshot(p.runId);
      return {
        content: [{ type: "text", text: truncateToolText(JSON.stringify(snapshot, null, 2)) }],
        details: { snapshot },
      };
    },
  });
  pi.registerCommand("agentflow-status", {
    description: "List recent Agentflow runs or inspect one: /agentflow-status [runId]",
    handler: async (args, ctx) => {
      try {
        const runId = args.trim() || undefined;
        ctx.ui.notify(compactStatus(engine.getSnapshot(runId)), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "agentflow_wait",
    label: "Agentflow Wait",
    description:
      "Wait for one or more background runs. Waiting consumes automatic result delivery so results are not delivered twice.",
    parameters: Type.Object({ runIds: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, p, signal) {
      const results = await engine.wait(p.runIds, signal);
      return {
        content: [
          {
            type: "text",
            text: truncateToolText(
              JSON.stringify(
                results.map((r) => ({
                  runId: r.runId,
                  status: r.status,
                  result: r.result,
                  error: r.error,
                  artifactDir: r.snapshot.artifactDir,
                })),
                null,
                2,
              ),
            ),
          },
        ],
        details: { results },
      };
    },
  });
  pi.registerTool({
    name: "agentflow_cancel",
    label: "Agentflow Cancel",
    description: "Cancel one or more active runs and consume pending automatic delivery.",
    parameters: Type.Object({ runIds: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, p) {
      const snapshots = await engine.cancel(p.runIds);
      return {
        content: [{ type: "text", text: `Cancellation requested for ${p.runIds.join(", ")}.` }],
        details: { snapshots },
      };
    },
  });
}
