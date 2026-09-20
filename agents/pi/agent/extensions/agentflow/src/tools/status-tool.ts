import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import { slots } from "../ui/tool-renderers.ts";
import { runCostRecords, truncateToolText } from "../utils.ts";

export function registerStatusTool(pi: ExtensionAPI, engine: RunEngine): void {
  pi.registerTool({
    name: "agentflow_status",
    label: "Agentflow Status",
    description:
      "List recent runs of the current session or inspect one serializable run snapshot (any session), including artifact paths.",
    parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const snapshot = engine.getSnapshot(p.runId);
      const observedAt = Date.now();
      return {
        content: [{ type: "text", text: truncateToolText(JSON.stringify(snapshot, null, 2)) }],
        details: {
          snapshot,
          observedAt,
          costs: runCostRecords(Array.isArray(snapshot) ? snapshot : [snapshot]),
        },
      };
    },
    ...slots("agentflow_status"),
  });
  pi.registerTool({
    name: "agentflow_wait",
    label: "Agentflow Wait",
    description:
      "Wait for one or more background runs. Waiting consumes automatic result delivery so results are not delivered twice.",
    parameters: Type.Object({ runIds: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, p, signal) {
      const results = await engine.wait(p.runIds, signal);
      const observedAt = Date.now();
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
        details: {
          results,
          observedAt,
          costs: runCostRecords(results.map((result) => result.snapshot)),
        },
      };
    },
    ...slots("agentflow_wait"),
  });
  pi.registerTool({
    name: "agentflow_cancel",
    label: "Agentflow Cancel",
    description: "Cancel one or more active runs and consume pending automatic delivery.",
    parameters: Type.Object({ runIds: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, p) {
      const snapshots = await engine.cancel(p.runIds);
      const observedAt = Date.now();
      return {
        content: [{ type: "text", text: `Cancellation requested for ${p.runIds.join(", ")}.` }],
        details: { snapshots, observedAt, costs: runCostRecords(snapshots) },
      };
    },
    ...slots("agentflow_cancel"),
  });
}
