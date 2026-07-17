import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { renderSemanticSnapshot } from "./ui/semantic-renderer.ts";
import { runCostDetails } from "./utils.ts";

function expandHint(): string | undefined {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return undefined;
  }
}

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
    const active = (engine.getSnapshot() as RunSnapshot[]).filter(
      (run) => run.status === "running" || run.status === "queued",
    );
    const completedTasks = active.reduce(
      (count, run) => count + run.nodes.filter((node) => node.status === "completed").length,
      0,
    );
    const totalTasks = active.reduce((count, run) => count + run.nodes.length, 0);
    lastContext.ui.setStatus(
      "agentflow",
      active.length
        ? `◆ /agentflow ${active.length} · ${completedTasks}/${totalTasks} tasks`
        : undefined,
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
          details: { snapshot: result.snapshot, ...runCostDetails(result.snapshot) },
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
  if (process.env.PI_AGENTFLOW_CONFIG_SMOKE === "1") {
    pi.registerCommand("agentflow-config-smoke", {
      description: "Report Agentflow registration for the installed-configuration smoke test",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `AGENTFLOW_CONFIG_SMOKE ${JSON.stringify({
            all: pi
              .getAllTools()
              .map((tool) => tool.name)
              .filter((name) => name.startsWith("agentflow_"))
              .sort(),
            active: pi
              .getActiveTools()
              .filter((name) => name.startsWith("agentflow_"))
              .sort(),
          })}`,
        );
      },
    });
    pi.registerCommand("agentflow-config-reload", {
      description: "Reload Pi for the installed-configuration smoke test",
      handler: async (_args, ctx) => {
        await ctx.reload();
      },
    });
  }
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
  pi.registerMessageRenderer("agentflow-result", (message, options, theme) => {
    const snapshot = (message.details as { snapshot?: RunSnapshot } | undefined)?.snapshot;
    if (snapshot)
      return renderSemanticSnapshot(
        snapshot,
        { expanded: options.expanded, role: snapshot.semanticRole ?? "agent" },
        theme,
      );
    const configuredHint = expandHint();
    const hint = !options.expanded && configuredHint ? ` · ${configuredHint}` : "";
    return new Text(
      `${theme.fg("accent", "Agentflow result")}${theme.fg("dim", hint)}\n${message.content}`,
      0,
      0,
    );
  });
  pi.on("session_start", async (_event, ctx) => {
    lastContext?.ui.setStatus("agentflow", undefined);
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
