import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { RunSnapshot } from "./types.ts";

export interface RunCostDetails {
  costId: string;
  cost: number;
}

export function formatUsd(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function runCostDetails(snapshot: RunSnapshot): RunCostDetails | undefined {
  if (snapshot.status === "queued" || snapshot.status === "running") return undefined;
  return {
    costId: `agentflow:${snapshot.runId}`,
    cost: snapshot.nodes.reduce((total, node) => total + node.usage.cost, 0),
  };
}

export function runCostRecords(snapshots: readonly RunSnapshot[]): RunCostDetails[] {
  return snapshots
    .map(runCostDetails)
    .filter((details): details is RunCostDetails => details !== undefined);
}

export function truncateToolText(text: string): string {
  const truncated = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncated.truncated) return truncated.content;
  return `${truncated.content}\n\n[Output truncated to ${truncated.outputLines}/${truncated.totalLines} lines and ${truncated.outputBytes}/${truncated.totalBytes} bytes. Full result is preserved in tool details.]`;
}
