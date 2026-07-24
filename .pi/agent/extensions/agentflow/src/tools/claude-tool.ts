import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import type { AgentNodeSpec, RunSnapshot } from "../types.ts";
import { formatPrompt } from "../ui/formatters.ts";
import { renderSemanticSnapshot } from "../ui/semantic-renderer.ts";
import { formatRunFailure, runCostDetails, truncateToolText } from "../utils.ts";

const ClaudeModel = StringEnum(["fable", "opus", "sonnet"] as const);
const Mode = StringEnum(["foreground", "background"] as const);

export function registerClaudeTool(pi: ExtensionAPI, engine: RunEngine): void {
  pi.registerTool({
    name: "agentflow_claude",
    label: "Agentflow Claude",
    description:
      "Launch a controlled Claude coding child for exceptional advice or taste-sensitive implementation. State clearly whether the child should advise only or edit files.",
    promptSnippet: "Launch a controlled Claude child with Fable, Opus, or Sonnet",
    parameters: Type.Object(
      {
        task: Type.String(),
        model: Type.Optional(ClaudeModel),
        mode: Type.Optional(Mode),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, onUpdate, ctx) {
      const model = params.model ?? "opus";
      const node: AgentNodeSpec = {
        id: "claude",
        label: `claude/${model}`,
        prompt: params.task,
        claude: true,
        originTool: "agentflow_claude",
        config: { model },
      };
      const background = params.mode === "background";
      const result = await engine.launchAgent(node, ctx, {
        background,
        signal,
        onUpdate: background
          ? undefined
          : (snapshot) =>
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: snapshot.nodes[0]?.resultPreview ?? `${snapshot.status}…`,
                  },
                ],
                details: { snapshot },
              }),
      });
      if (background)
        return {
          content: [
            {
              type: "text",
              text: `Background Claude run started: ${result.runId}. Use agentflow_status, agentflow_wait, or agentflow_cancel.`,
            },
          ],
          details: result,
        };
      if ("status" in result && result.status !== "completed")
        throw new Error(formatRunFailure(result, `Claude ${result.status}`));
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
      const model = args.model ?? "opus";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("claude "))}${theme.fg("accent", model)}${args.mode === "background" ? theme.fg("dim", " · background") : ""}\n${theme.fg("dim", formatPrompt(args.task).slice(0, 100))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const snapshot = (result.details as { snapshot?: RunSnapshot } | undefined)?.snapshot;
      if (!snapshot)
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      return renderSemanticSnapshot(snapshot, { role: "agent", expanded: options.expanded }, theme);
    },
  });
}
