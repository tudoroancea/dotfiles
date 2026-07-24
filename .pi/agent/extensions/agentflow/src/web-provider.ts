import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunEngine } from "./runtime/run-engine.ts";

const DISCOVER = "web-ui:provider-discover";
const REGISTER = "web-ui:provider-register";

export function registerAgentflowWebProvider(pi: ExtensionAPI, engine: RunEngine): void {
  if (typeof pi.events?.on !== "function" || typeof pi.events?.emit !== "function") return;
  const webSnapshot = () => {
    const snapshots = engine.getSnapshot();
    const list = Array.isArray(snapshots) ? snapshots : [snapshots];
    return list.map((snapshot) => {
      const steerable = new Set(engine.getSteerableNodeIds(snapshot.runId));
      return {
        ...snapshot,
        nodes: snapshot.nodes.map((node) => ({ ...node, steerable: steerable.has(node.id) })),
      };
    });
  };
  pi.events.on(DISCOVER, () => {
    pi.events.emit(REGISTER, {
      id: "agentflow",
      getSnapshot: webSnapshot,
      subscribe: (listener: () => void) => engine.subscribe(() => listener()),
      async action(action: string, payload: unknown) {
        const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (action === "cancel") {
          const runId = typeof input.runId === "string" ? input.runId : "";
          if (!runId) throw new Error("runId is required");
          const current = engine.getSnapshot(runId);
          if (Array.isArray(current) || (current.status !== "running" && current.status !== "queued")) {
            throw new Error(`Run is not cancellable: ${runId}`);
          }
          await engine.cancel([runId]);
          return webSnapshot();
        }
        if (action === "steer") {
          const runId = typeof input.runId === "string" ? input.runId : "";
          const nodeId = typeof input.nodeId === "string" ? input.nodeId : undefined;
          const message = typeof input.message === "string" ? input.message.slice(0, 16_384) : "";
          if (!runId || !message) throw new Error("runId and message are required");
          await engine.steer(runId, nodeId, message);
          return webSnapshot();
        }
        throw new Error(`Unsupported Agentflow dashboard action: ${action}`);
      },
    });
  });
}
