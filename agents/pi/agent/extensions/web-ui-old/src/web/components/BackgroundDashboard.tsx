import { useState } from "preact/hooks";
import { asArray, asRecord, str } from "../lib/tool-model.js";
import { formatBytes, formatDuration } from "../lib/text.js";
import { CodeBlock } from "./CodeBlock.js";
import { Facts } from "./Facts.js";
import { JsonView } from "./JsonView.js";

export function BackgroundDashboard({
  data,
  onAction,
  connected,
}: {
  data: unknown;
  connected: boolean;
  onAction: (action: string, payload: unknown) => void;
}) {
  const root = asRecord(data);
  const jobs = asArray(root.jobs).map(asRecord);
  const [selected, setSelected] = useState<string>();
  const active = jobs.find((job) => str(job.jobId) === selected) ?? jobs[0];
  if (!active) return <p class="dashboard__empty">No background jobs.</p>;
  const jobId = str(active.jobId) ?? "";
  const monitor = asRecord(active.monitor);
  return (
    <section class="dashboard" aria-label="Background jobs dashboard">
      <aside class="dashboard__list">
        {jobs.map((job) => (
          <button key={str(job.jobId)} type="button" onClick={() => setSelected(str(job.jobId))}>
            <span>{str(job.description) ?? str(job.command) ?? str(job.jobId)}</span>
            <small>{str(job.status)}</small>
          </button>
        ))}
      </aside>
      <div class="dashboard__detail">
        <h2>{str(active.description) ?? str(active.command) ?? jobId}</h2>
        <Facts
          items={[
            { label: "Job", value: jobId },
            { label: "Status", value: str(active.status) ?? "unknown" },
            { label: "Elapsed", value: formatDuration(active.durationMs) ?? "—" },
            { label: "Terminal cause", value: str(active.requestedTerminalCause) ?? "—" },
            { label: "Output", value: formatBytes(active.outputBytes) ?? "—" },
            { label: "Delivery", value: str(active.deliveryState) ?? "—" },
            { label: "Deliveries", value: String(monitor.deliveries ?? 0) },
            { label: "Dropped lines", value: String(monitor.droppedLines ?? 0) },
            { label: "Output log", value: str(active.outputPath) ?? "—" },
            { label: "Metadata", value: str(active.metadataPath) ?? "—" },
          ]}
        />
        {str(active.error) ? <p class="dashboard__error">{str(active.error)}</p> : null}
        {str(active.tail) ? <CodeBlock code={str(active.tail)!} variant="output" /> : null}
        <details>
          <summary>Full job details</summary>
          <JsonView value={active} />
        </details>
        <div class="dashboard__controls">
          <button
            type="button"
            disabled={!connected}
            onClick={() => onAction("tail", { jobId, tailLines: 100 })}
          >
            Refresh tail
          </button>
          <button
            type="button"
            class="btn--danger"
            disabled={!connected || str(active.status) !== "running"}
            onClick={() => {
              if (window.confirm(`Stop ${jobId}?`)) onAction("stop", { jobId });
            }}
          >
            Stop job
          </button>
        </div>
      </div>
    </section>
  );
}
