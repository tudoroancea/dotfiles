import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { RunEngine } from "./runtime/run-engine.ts";
import { SemanticAgentService } from "./semantic/semantic-agent-service.ts";
import { registerAgentTool } from "./tools/agent-tool.ts";
import { registerStatusTool } from "./tools/status-tool.ts";
import { registerSemanticTools } from "./tools/semantic-tools.ts";
import { registerSteerTool } from "./tools/steer-tool.ts";
import { registerWorkflowTool } from "./tools/workflow-tool.ts";
import type { RunSnapshot } from "./types.ts";
import { registerDashboard } from "./ui/dashboard.ts";
import { runCostDetails } from "./utils.ts";

export default function agentflowExtension(pi: ExtensionAPI): void {
  pi.registerFlag("agentflow-raw", {
    description: "Enable raw agentflow_agent and agentflow_workflow tools",
    type: "boolean",
    default: false,
  });
  let lastContext: ExtensionContext | undefined;
  let engine!: RunEngine;
  const refreshUi = () => {
    if (!lastContext) return;
    const active = (engine.getSnapshot() as any[]).filter(
      (run) =>
        (run.status === "running" || run.status === "queued") &&
        (run.background || run.kind === "workflow"),
    );
    // Worktrunk's custom footer renders extension statuses after its primary
    // status line, matching Claude Code's placement without a second widget.
    const summaries = active.slice(0, 2).map((run) => {
      const done = run.nodes.filter((node: any) => node.status === "completed").length;
      return `${run.name ?? run.kind} ${run.runId} ${done}/${run.nodes.length}`;
    });
    const overflow =
      active.length > summaries.length ? ` +${active.length - summaries.length}` : "";
    lastContext.ui.setStatus(
      "agentflow",
      active.length ? `agentflow ◆ ${summaries.join(" · ")}${overflow}` : undefined,
    );
  };
  engine = new RunEngine(
    (name, payload) => {
      pi.events.emit(name, payload);
      if (
        name === "agentflow:run.completed" ||
        name === "agentflow:run.failed" ||
        name === "agentflow:run.aborted"
      ) {
        const cost = runCostDetails(payload as RunSnapshot);
        if (cost) pi.appendEntry("agentflow-cost", cost);
      }
      refreshUi();
    },
    () => pi.getActiveTools(),
    (message, result) =>
      pi.sendMessage(
        {
          customType: "agentflow-result",
          content: message,
          display: true,
          details: runCostDetails(result.snapshot),
        },
        { triggerTurn: true, deliverAs: "followUp" },
      ),
    () => pi.getThinkingLevel(),
    undefined,
    4,
    () => lastContext?.isIdle() ?? true,
  );
  const semanticService = new SemanticAgentService(engine, () => pi.getAllTools());
  registerSemanticTools(pi, semanticService);
  let rawToolsRegistered = false;
  pi.on("session_start", () => {
    if (!rawToolsRegistered && pi.getFlag("agentflow-raw")) {
      registerAgentTool(pi, engine);
      registerWorkflowTool(pi, engine, semanticService);
      rawToolsRegistered = true;
    }
  });
  registerStatusTool(pi, engine);
  registerSteerTool(pi, engine);
  registerDashboard(pi, engine);
  pi.registerMessageRenderer(
    "agentflow-result",
    (message, _options, theme) =>
      new Text(`${theme.fg("accent", "Agentflow result")}\n${message.content}`, 0, 0),
  );
  pi.on("session_start", async (_event, ctx) => {
    lastContext = ctx;
    await engine.recover();
    refreshUi();
  });
  pi.on("agent_settled", () => {
    engine.flushBackgroundDeliveries();
  });
  pi.on("session_shutdown", async () => {
    lastContext?.ui.setStatus("agentflow", undefined);
    await engine.shutdown();
    lastContext = undefined;
  });
}
