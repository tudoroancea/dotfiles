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
}
