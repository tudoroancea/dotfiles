import { CodeBlock } from "../components/CodeBlock.js";
import { Facts } from "../components/Facts.js";
import { JsonView } from "../components/JsonView.js";
import { Markdown } from "../components/Markdown.js";
import { asArray, asRecord, num, str, type ToolView } from "../lib/tool-model.js";
import { pluralize } from "../lib/text.js";
import type { ToolAdapter } from "./types.js";

const ROLE_GLYPH: Record<string, string> = {
  finder: "⚲",
  oracle: "◈",
  librarian: "❦",
  look_at: "◉",
  delegate: "⇛",
  review: "❑",
  claude: "✦",
  workflow: "⌘",
  agent: "❖",
};

function roleGlyph(role: string | undefined): string {
  return (role && ROLE_GLYPH[role]) || "❖";
}

function truncate(value: string | undefined, max = 80): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function snapshotLabel(snapshot: Record<string, unknown>): string {
  return (
    str(snapshot.name) ??
    str(snapshot.semanticRole) ??
    str(snapshot.originTool)?.replace(/^agentflow_/, "") ??
    str(snapshot.kind) ??
    "run"
  );
}

function usageFact(node: Record<string, unknown>) {
  const usage = asRecord(node.usage);
  const total = num(usage.total);
  const cost = num(usage.cost);
  if (total === undefined && cost === undefined) return null;
  const parts: string[] = [];
  if (total !== undefined) parts.push(`${total.toLocaleString()} tok`);
  if (cost !== undefined) parts.push(`$${cost.toFixed(4)}`);
  return parts.join(" · ");
}

function ToolCallRow({ call }: { call: Record<string, unknown> }) {
  return (
    <li class="run-node__tool">
      <span class="run-node__tool-name">{str(call.name) ?? "tool"}</span>
      {str(call.argumentSummary) ? (
        <span class="run-node__tool-arg">{str(call.argumentSummary)}</span>
      ) : null}
      {str(call.resultPreview) ? (
        <span class="run-node__tool-result">{truncate(str(call.resultPreview), 60)}</span>
      ) : null}
      {str(call.error) ? (
        <span class="run-node__tool-error">{truncate(str(call.error), 120)}</span>
      ) : null}
      <span class={`run-node__tool-status run-node__tool-status--${str(call.status) ?? "unknown"}`}>
        {str(call.status)}
      </span>
    </li>
  );
}

function RunNode({ node }: { node: Record<string, unknown> }) {
  const toolCalls = asArray(node.toolCalls);
  const usage = usageFact(node);
  return (
    <li class="run-node">
      <div class="run-node__head">
        <span class="run-node__label">{str(node.label) ?? str(node.id) ?? "node"}</span>
        <span class={`run-node__status run-node__status--${str(node.status) ?? "unknown"}`}>
          {str(node.status)}
        </span>
      </div>
      {str(node.resultPreview) ? (
        <p class="run-node__preview">{truncate(str(node.resultPreview), 160)}</p>
      ) : null}
      {str(node.error) ? <p class="run-node__error">{truncate(str(node.error), 240)}</p> : null}
      {usage ? <p class="run-node__usage">{usage}</p> : null}
      {toolCalls.length > 0 ? (
        <ul class="run-node__tools">
          {toolCalls.map((call, index) => (
            // eslint-disable-next-line react/no-array-index-key -- positional
            <ToolCallRow key={index} call={asRecord(call)} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Semantic presentation of an Agentflow run snapshot. */
export function AgentflowSnapshot({ snapshot }: { snapshot: Record<string, unknown> }) {
  const nodes = asArray(snapshot.nodes);
  const phases = asArray(snapshot.phases)
    .map((phase) => str(phase))
    .filter(Boolean)
    .join(" → ");
  const logs = asArray(snapshot.logs)
    .map((entry) => str(entry))
    .filter((entry): entry is string => Boolean(entry));
  return (
    <div class="run">
      <Facts
        items={[
          { label: "Run", value: str(snapshot.runId) ?? "—" },
          { label: "Kind", value: snapshotLabel(snapshot) },
          {
            label: "Status",
            value: str(snapshot.status) ?? "—",
            tone:
              str(snapshot.status) === "error" ||
              str(snapshot.status) === "failed" ||
              str(snapshot.status) === "aborted"
                ? "error"
                : "default",
          },
          phases ? { label: "Phases", value: phases } : null,
          str(snapshot.currentPhase) ? { label: "Phase", value: str(snapshot.currentPhase) } : null,
          str(snapshot.completedAt)
            ? { label: "Completed", value: str(snapshot.completedAt), tone: "muted" }
            : null,
          str(snapshot.artifactDir)
            ? { label: "Artifacts", value: str(snapshot.artifactDir), tone: "muted" }
            : null,
        ]}
      />
      {str(snapshot.error) ? <p class="run__error">{truncate(str(snapshot.error), 320)}</p> : null}
      {nodes.length > 0 ? (
        <ul class="run__nodes">
          {nodes.map((node, index) => (
            // eslint-disable-next-line react/no-array-index-key -- positional
            <RunNode key={index} node={asRecord(node)} />
          ))}
        </ul>
      ) : null}
      {logs.length > 0 ? (
        <details class="run__logs">
          <summary>{pluralize(logs.length, "log line")}</summary>
          <ul>
            {logs.map((entry, index) => (
              // eslint-disable-next-line react/no-array-index-key -- positional
              <li key={index}>{entry}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function resultText(view: ToolView): string {
  return str(view.details.result) ?? view.text;
}

function agentflowAdapter(config: { label: string; argKeys: readonly string[] }): ToolAdapter {
  return {
    glyph: "❖",
    label: config.label,
    title: (view) => {
      const snapshot = asRecord(view.details.snapshot);
      const glyph = roleGlyph(str(snapshot.semanticRole) ?? config.label);
      const arg = config.argKeys.map((key) => str(view.args[key])).find(Boolean);
      return (
        <span class="tool__command">
          <span class="tool__role" aria-hidden="true">
            {glyph}
          </span>
          {config.label}
          {arg ? <span class="tool__hint"> · {truncate(arg, 72)}</span> : null}
        </span>
      );
    },
    summary: (view) => {
      const snapshot = asRecord(view.details.snapshot);
      const status = str(view.details.status) ?? str(snapshot.status) ?? view.status;
      const preview = str(snapshot.resultPreview) ?? truncate(resultText(view), 80);
      return (
        <span>
          <span class="tool__phase">{status}</span>
          {preview ? <span class="tool__preview"> — {truncate(preview, 96)}</span> : null}
        </span>
      );
    },
    detail: (view) => {
      const snapshot = asRecord(view.details.snapshot);
      const result = resultText(view);
      return (
        <>
          {result ? <Markdown source={result} /> : null}
          {Object.keys(snapshot).length > 0 ? <AgentflowSnapshot snapshot={snapshot} /> : null}
        </>
      );
    },
  };
}

/** Renders a list of run results/snapshots for status/wait/cancel tools. */
function RunResultList({ items }: { items: readonly Record<string, unknown>[] }) {
  return (
    <div class="run-list">
      {items.map((item, index) => {
        const snapshot = asRecord(item.snapshot ?? item);
        return (
          <div key={index} class="run-list__item">
            {str(item.result) ? (
              <p class="run-list__result">{truncate(str(item.result), 200)}</p>
            ) : null}
            {str(item.error) ? (
              <p class="run-list__error">{truncate(str(item.error), 240)}</p>
            ) : null}
            <AgentflowSnapshot snapshot={snapshot} />
          </div>
        );
      })}
    </div>
  );
}

export const agentflowAdapters: Record<string, ToolAdapter> = {
  agentflow_finder: agentflowAdapter({ label: "finder", argKeys: ["task"] }),
  agentflow_oracle: agentflowAdapter({ label: "oracle", argKeys: ["question"] }),
  agentflow_librarian: agentflowAdapter({ label: "librarian", argKeys: ["question"] }),
  agentflow_look_at: agentflowAdapter({ label: "look at", argKeys: ["objective", "path"] }),
  agentflow_delegate: agentflowAdapter({ label: "delegate", argKeys: ["task"] }),
  agentflow_review: agentflowAdapter({ label: "review", argKeys: ["task"] }),
  agentflow_claude: agentflowAdapter({ label: "claude", argKeys: ["task"] }),
  agentflow_workflow: agentflowAdapter({ label: "workflow", argKeys: ["script"] }),
  agentflow_agent: agentflowAdapter({ label: "agent", argKeys: ["prompt", "task"] }),
  agentflow_status: {
    glyph: "❖",
    label: "status",
    title: (view) => <span class="tool__command">status · {str(view.args.runId) ?? "all"}</span>,
    summary: (view) => {
      if (view.isError) return `failed · ${view.text.split("\n")[0] || "error"}`;
      const snapshots = asArray(view.details.snapshot);
      if (Array.isArray(view.details.snapshot)) return pluralize(snapshots.length, "run");
      return str(asRecord(view.details.snapshot).status) ?? "queried";
    },
    detail: (view) => {
      if (view.isError)
        return <CodeBlock code={view.text || "Agentflow status failed"} variant="output" />;
      if (Array.isArray(view.details.snapshot)) {
        const snapshots = asArray(view.details.snapshot).map(asRecord);
        return snapshots.length > 0 ? (
          <RunResultList items={snapshots} />
        ) : (
          <p class="run-list__empty">No Agentflow runs</p>
        );
      }
      return <AgentflowSnapshot snapshot={asRecord(view.details.snapshot)} />;
    },
  },
  agentflow_wait: {
    glyph: "❖",
    label: "wait",
    title: (view) => (
      <span class="tool__command">wait · {asArray(view.args.runIds).length || ""} run(s)</span>
    ),
    summary: (view) => {
      if (view.isError) return `failed · ${view.text.split("\n")[0] || "error"}`;
      const results = asArray(view.details.results);
      return pluralize(results.length, "run").concat(" settled");
    },
    detail: (view) =>
      view.isError ? (
        <CodeBlock code={view.text || "Agentflow wait failed"} variant="output" />
      ) : (
        <RunResultList items={asArray(view.details.results).map(asRecord)} />
      ),
  },
  agentflow_cancel: {
    glyph: "❖",
    label: "cancel",
    title: (view) => (
      <span class="tool__command">cancel · {asArray(view.args.runIds).length || ""} run(s)</span>
    ),
    summary: (view) => view.text || "cancellation requested",
    detail: (view) => {
      const snapshots = asArray(view.details.snapshots).map(asRecord);
      return snapshots.length > 0 ? (
        <RunResultList items={snapshots} />
      ) : (
        <JsonView value={view.details} />
      );
    },
  },
  agentflow_steer: {
    glyph: "❖",
    label: "steer",
    title: (view) => (
      <span class="tool__command">
        steer · {str(view.args.nodeId) ?? str(view.args.runId) ?? ""}
      </span>
    ),
    summary: (view) => view.text || "steering accepted",
  },
};
