import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";

export function registerSteerTool(pi: ExtensionAPI, engine: RunEngine): void {
  pi.registerTool({
    name: "agentflow_steer",
    label: "Agentflow Steer",
    description:
      "Send a steering message to a live child agent. nodeId is optional only when exactly one node is running.",
    parameters: Type.Object({
      runId: Type.String(),
      nodeId: Type.Optional(Type.String()),
      message: Type.String(),
    }),
    async execute(_id, params) {
      const result = await engine.steer(params.runId, params.nodeId, params.message);
      return {
        content: [{ type: "text", text: `Steering accepted for ${result.nodeId}.` }],
        details: result,
      };
    },
  });

  pi.registerCommand("agentflow-steer", {
    description: "Steer a child: /agentflow-steer <runId> [nodeId] -- <message>",
    handler: async (args, ctx) => {
      const match = args.match(/^\s*(\S+)(?:\s+(\S+))?\s+--\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("Usage: /agentflow-steer <runId> [nodeId] -- <message>", "error");
        return;
      }
      try {
        const result = await engine.steer(match[1], match[2], match[3]);
        ctx.ui.notify(`Steering accepted for ${result.nodeId}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
