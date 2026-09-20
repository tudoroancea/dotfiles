import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import type { AgentNodeSpec } from "../types.ts";
import { slots } from "../ui/tool-renderers.ts";
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
    ...slots("agentflow_claude"),
  });
}
