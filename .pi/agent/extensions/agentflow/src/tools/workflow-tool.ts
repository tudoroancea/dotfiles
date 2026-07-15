import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import type { SemanticAgentService } from "../semantic/semantic-agent-service.ts";
import { executeWorkflow } from "../runtime/workflow-runtime.ts";
import { runCostDetails, truncateToolText } from "../utils.ts";
const Mode = StringEnum(["foreground", "background"] as const);
export function registerWorkflowTool(
  pi: ExtensionAPI,
  engine: RunEngine,
  semanticService: SemanticAgentService,
): void {
  pi.registerTool({
    name: "agentflow_workflow",
    label: "Agentflow Workflow",
    description:
      "Run an inline JavaScript workflow in a permission-restricted subprocess. APIs: agent, finder, oracle, librarian, look_at, delegate, review (all return normalized envelopes), parallel, pipeline, phase, log, args, cwd, budget. Supports foreground/background.",
    promptSnippet: "Run a sandboxed dynamic multi-agent workflow",
    parameters: Type.Object({
      script: Type.String(),
      args: Type.Optional(Type.Any()),
      mode: Type.Optional(Mode),
      limits: Type.Optional(
        Type.Object({
          maxAgents: Type.Optional(Type.Number({ minimum: 1, maximum: 256 })),
          concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 32 })),
          timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
          tokenBudget: Type.Optional(Type.Number({ minimum: 1 })),
        }),
      ),
    }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const background = p.mode === "background";
      const result = await executeWorkflow({
        script: p.script,
        args: p.args,
        limits: p.limits,
        background,
        ctx,
        signal,
        engine,
        semanticService,
        onUpdate: (s) =>
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `${s.name}: ${s.status} (${s.nodes.filter((n: any) => n.status === "completed").length}/${s.nodes.length})`,
              },
            ],
            details: { snapshot: s },
          }),
      });
      if (background)
        return {
          content: [
            {
              type: "text",
              text: `Background workflow started: ${result.runId}. Artifacts: ${(result as any).snapshot.artifactDir}`,
            },
          ],
          details: result,
        };
      if ("status" in result && result.status !== "completed")
        throw new Error(result.error ?? `Workflow ${result.status}`);
      return {
        content: [
          {
            type: "text",
            text: truncateToolText(JSON.stringify((result as any).result, null, 2) ?? "null"),
          },
        ],
        details: { ...result, ...runCostDetails(result.snapshot) },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("agentflow workflow"))}${args.mode === "background" ? " · background" : ""}`,
        0,
        0,
      );
    },
    renderResult(result, _o, theme) {
      const s = (result.details as any)?.snapshot;
      if (!s)
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      return new Text(
        [
          `${s.status === "completed" ? theme.fg("success", "✓") : s.status === "failed" || s.status === "aborted" ? theme.fg("error", "✗") : theme.fg("dim", "◆")} ${theme.fg("accent", s.name ?? "workflow")} · ${theme.fg("dim", s.runId)}`,
          ...s.nodes
            .slice(-8)
            .map(
              (n: any) =>
                `  ${n.status === "completed" ? "✓" : n.status === "running" ? "◆" : n.status === "queued" ? "·" : "✗"} ${n.label}`,
            ),
        ].join("\n"),
        0,
        0,
      );
    },
  });
}
