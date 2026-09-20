import { useState } from "preact/hooks";
import { asArray, asRecord, str } from "../lib/tool-model.js";
import { AgentflowSnapshot } from "../render/agentflow.js";
import { JsonView } from "./JsonView.js";

export function AgentflowDashboard({
  data,
  onAction,
  connected,
}: {
  data: unknown;
  connected: boolean;
  onAction: (action: string, payload: unknown) => void;
}) {
  const runs = (Array.isArray(data) ? data : asArray(asRecord(data).runs)).map(asRecord);
  const [selected, setSelected] = useState<string>();
  const [message, setMessage] = useState("");
  const [selectedNode, setSelectedNode] = useState("");
  const active = runs.find((run) => str(run.runId) === selected) ?? runs[0];
  if (!active) return <p class="dashboard__empty">No Agentflow runs.</p>;
  const runId = str(active.runId) ?? "";
  const runningNodes = asArray(active.nodes)
    .map(asRecord)
    .filter((node) => str(node.status) === "running" && node.steerable === true);
  const nodeId =
    runningNodes.find((node) => str(node.id) === selectedNode)?.id ?? runningNodes[0]?.id;
  const cancellable = str(active.status) === "running" || str(active.status) === "queued";
  return (
    <section class="dashboard" aria-label="Agentflow dashboard">
      <aside class="dashboard__list">
        {runs.map((run) => (
          <button key={str(run.runId)} type="button" onClick={() => setSelected(str(run.runId))}>
            <span>{str(run.name) ?? str(run.semanticRole) ?? str(run.runId)}</span>
            <small>{str(run.status)}</small>
          </button>
        ))}
      </aside>
      <div class="dashboard__detail">
        <AgentflowSnapshot snapshot={active} />
        <details>
          <summary>Full run details</summary>
          <JsonView value={active} />
        </details>
        <div class="dashboard__controls">
          {runningNodes.length > 1 ? (
            <label>
              Target node
              <select
                aria-label="Target node"
                value={typeof nodeId === "string" ? nodeId : ""}
                onChange={(event) => setSelectedNode(event.currentTarget.value)}
              >
                {runningNodes.map((node) => (
                  <option key={str(node.id)} value={str(node.id)}>
                    {str(node.label) ?? str(node.id)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <input
            aria-label="Steering message"
            value={message}
            onInput={(e) => setMessage(e.currentTarget.value)}
          />
          <button
            type="button"
            disabled={!connected || !message.trim() || typeof nodeId !== "string"}
            onClick={() => {
              onAction("steer", { runId, nodeId, message });
            }}
          >
            Steer
          </button>
          <button
            type="button"
            class="btn--danger"
            disabled={!connected || !cancellable}
            onClick={() => {
              if (window.confirm(`Cancel ${runId}?`)) onAction("cancel", { runId });
            }}
          >
            Cancel run
          </button>
        </div>
      </div>
    </section>
  );
}
