import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import type { SemanticAgentService } from "../semantic/semantic-agent-service.ts";
import { executeWorkflow } from "../runtime/workflow-runtime.ts";
import { formatRunFailure, runCostDetails, truncateToolText } from "../utils.ts";
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
      'Run an inline JavaScript workflow in a permission-restricted subprocess. The script must start with static `export const meta = { name: "snake_case", description: "...", phases?: [{ title: "..." }] }`. Call bare helpers agent, finder, oracle, librarian, look_at, delegate, and review; never use agent.delegate. Helpers return normalized envelopes. Also available: parallel, pipeline, phase, log, args, cwd, and budget. Omit limits by default; set them only when the user explicitly requests caps. Supports foreground/background.',
    promptSnippet: "Run a sandboxed dynamic multi-agent workflow with a static meta header",
    promptGuidelines: [
      'For agentflow_workflow scripts, begin with static `export const meta = { name: "snake_case", description: "..." }` and call child helpers as bare functions such as `delegate({...})`, never `agent.delegate({...})`.',
      "Omit agentflow_workflow limits by default. Set maxAgents, concurrency, timeoutMs, or tokenBudget only when the user explicitly requests that limit.",
      "Check normalized child envelopes in agentflow_workflow scripts and throw on `!result.ok` when later phases require that child to succeed.",
    ],
    parameters: Type.Object({
      script: Type.String({
        description:
          'JavaScript beginning with `export const meta = { name: "snake_case", description: "..." }`; use bare child helpers and top-level await/return.',
      }),
      args: Type.Optional(Type.Any()),
      mode: Type.Optional(Mode),
      limits: Type.Optional(
        Type.Object(
          {
            maxAgents: Type.Optional(Type.Number({ minimum: 1, maximum: 256 })),
            concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 32 })),
            timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
            tokenBudget: Type.Optional(Type.Number({ minimum: 1 })),
          },
          {
            description:
              "Optional user-requested safety caps. Omit this object by default; workflows otherwise have no agent-count, concurrency, or token budget cap.",
          },
        ),
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
        throw new Error(formatRunFailure(result, `Workflow ${result.status}`));
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
