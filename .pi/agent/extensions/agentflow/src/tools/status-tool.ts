import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RunEngine } from "../runtime/run-engine.ts";
import {
  formatRunIds,
  renderCancellation,
  renderRunSnapshots,
  renderWaitResults,
} from "../ui/control-renderer.ts";
import { sanitizeRenderedValue } from "../ui/formatters.ts";
import { runCostRecords, truncateToolText } from "../utils.ts";

function snapshotTime(
  details: { observedAt?: number } | undefined,
  state: Record<string, unknown>,
): number {
  const observedAt =
    details?.observedAt ?? (typeof state.observedAt === "number" ? state.observedAt : Date.now());
  state.observedAt = observedAt;
  return observedAt;
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
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("agentflow_status"))}${args.runId ? ` ${theme.fg("muted", sanitizeRenderedValue(args.runId))}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const snapshot = result.details?.snapshot;
      if (!snapshot)
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      return renderRunSnapshots(
        Array.isArray(snapshot) ? snapshot : [snapshot],
        expanded,
        theme,
        snapshotTime(result.details, context.state),
      );
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
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("agentflow_wait"))} ${theme.fg("muted", formatRunIds(args.runIds))}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const results = result.details?.results;
      if (!results)
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      return renderWaitResults(
        results,
        expanded,
        theme,
        snapshotTime(result.details, context.state),
      );
    },
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
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("agentflow_cancel"))} ${theme.fg("muted", formatRunIds(args.runIds))}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const snapshots = result.details?.snapshots;
      if (!snapshots)
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      return renderCancellation(
        snapshots,
        expanded,
        theme,
        snapshotTime(result.details, context.state),
      );
    },
  });
}
