import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import type { AgentNodeSpec, RunSnapshot } from "../types.ts";
import { formatPrompt } from "../ui/formatters.ts";
import { renderSemanticSnapshot } from "../ui/semantic-renderer.ts";
import { formatRunFailure, runCostDetails, truncateToolText } from "../utils.ts";
const Thinking = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const SessionMode = StringEnum(["memory", "file", "existing"] as const);
const Mode = StringEnum(["foreground", "background"] as const);
export function registerAgentTool(pi: ExtensionAPI, engine: RunEngine): void {
  pi.registerTool({
    name: "agentflow_agent",
    label: "Agentflow Agent",
    description:
      "Launch one isolated configurable child agent in foreground or background. Background returns immediately and can be inspected, steered, waited for, or cancelled.",
    promptSnippet: "Launch one foreground/background child agent",
    parameters: Type.Object({
      prompt: Type.String(),
      label: Type.Optional(Type.String()),
      mode: Type.Optional(Mode),
      systemPrompt: Type.Optional(Type.String()),
      appendSystemPrompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Thinking),
      tools: Type.Optional(Type.Any()),
      skills: Type.Optional(Type.Any()),
      extensions: Type.Optional(Type.Any()),
      cwd: Type.Optional(Type.String()),
      session: Type.Optional(
        Type.Object({
          mode: Type.Optional(SessionMode),
          file: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          inheritParentContext: Type.Optional(Type.Boolean()),
        }),
      ),
      outputSchema: Type.Optional(Type.Any()),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
      toolTimeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
      trustProject: Type.Optional(
        Type.Boolean({
          description: "Explicitly trust project resources when cwd differs from the parent",
        }),
      ),
    }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const node: AgentNodeSpec = {
        id: "agent",
        label: p.label ?? "agent",
        prompt: p.prompt,
        originTool: "agentflow_agent",
        config: {
          systemPrompt: p.systemPrompt,
          appendSystemPrompt: p.appendSystemPrompt,
          model: p.model,
          thinking: p.thinking,
          tools: p.tools,
          skills: p.skills,
          extensions: p.extensions,
          cwd: p.cwd,
          session: p.session,
          outputSchema: p.outputSchema,
          timeoutMs: p.timeoutMs,
          toolTimeoutMs: p.toolTimeoutMs,
          trustProject: p.trustProject,
        },
      };
      const background = p.mode === "background";
      const result = await engine.launchAgent(node, ctx, {
        background,
        signal,
        onUpdate: (s) =>
          onUpdate?.({
            content: [{ type: "text", text: s.nodes[0]?.resultPreview ?? `${s.status}…` }],
            details: { snapshot: s },
          }),
      });
      if (background)
        return {
          content: [
            {
              type: "text",
              text: `Background agent started: ${result.runId}. Use agentflow_status, agentflow_wait, agentflow_steer, or agentflow_cancel.`,
            },
          ],
          details: result,
        };
      if ("status" in result && result.status !== "completed")
        throw new Error(formatRunFailure(result, `Run ${result.status}`));
      const value = "result" in result ? result.result : undefined;
      return {
        content: [
          {
            type: "text",
            text: truncateToolText(
              typeof value === "string" ? value : JSON.stringify(value) || "(no output)",
            ),
          },
        ],
        details: { ...result, ...runCostDetails(result.snapshot) },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("agentflow "))}${theme.fg("accent", args.label ?? "agent")}${args.mode === "background" ? theme.fg("dim", " · background") : ""}\n${theme.fg("dim", formatPrompt(args.prompt).slice(0, 100))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const snapshot = (result.details as any)?.snapshot as RunSnapshot | undefined;
      if (!snapshot)
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      return renderSemanticSnapshot(
        snapshot,
        { role: "agent", expanded: options.expanded, collapsedPrompt: true },
        theme,
      );
    },
  });
}
