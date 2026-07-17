import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import { boundedLines, sanitizeRenderedValue } from "../ui/formatters.ts";

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
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("agentflow_steer"));
      const target = `${sanitizeRenderedValue(args.runId)}${args.nodeId ? ` / ${sanitizeRenderedValue(args.nodeId)}` : ""}`;
      if (!context.expanded) return new Text(`${title} ${theme.fg("muted", target)}`, 0, 0);
      const message = boundedLines(sanitizeRenderedValue(args.message), 6).join("\n");
      return new Text(
        `${title}\n${theme.fg("dim", `Target: ${target}`)}\n${theme.fg("muted", `Message: ${message}`)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const nodeId = result.details?.nodeId;
      const text = nodeId
        ? `✓ Steering accepted for ${sanitizeRenderedValue(nodeId)}`
        : "✓ Steering accepted";
      return new Text(theme.fg("success", text), 0, 0);
    },
  });
}
