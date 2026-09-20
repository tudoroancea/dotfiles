export interface SessionCostSummary {
  /** Recorded provider spend from top-level usage records. */
  usage: number;
  /** Globally deduplicated Agentflow child spend. */
  agentflow: number;
  total: number;
}

export interface SessionCostDelta extends SessionCostSummary {}

const AGENTFLOW_COST_ID_PREFIX = "agentflow:";

function recordedCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageCost(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cost = (value as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object") return undefined;
  return recordedCost((cost as { total?: unknown }).total);
}

function agentflowCostId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.startsWith(AGENTFLOW_COST_ID_PREFIX) &&
    id.slice(AGENTFLOW_COST_ID_PREFIX.length).trim().length > 0
    ? id
    : undefined;
}

function directAgentflowRecords(value: unknown): Array<{ costId: string; cost: number }> {
  if (!value || typeof value !== "object") return [];
  const details = value as { costId?: unknown; cost?: unknown; costs?: unknown };
  const records: Array<{ costId: string; cost: number }> = [];
  const costId = agentflowCostId(details.costId);
  const cost = recordedCost(details.cost);
  if (costId !== undefined && cost !== undefined) records.push({ costId, cost });

  if (!Array.isArray(details.costs)) return records;
  for (const candidate of details.costs) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as { costId?: unknown; cost?: unknown };
    const itemCostId = agentflowCostId(item.costId);
    const itemCost = recordedCost(item.cost);
    if (itemCostId !== undefined && itemCost !== undefined) {
      records.push({ costId: itemCostId, cost: itemCost });
    }
  }
  return records;
}

/**
 * Incrementally accounts recorded spend without importing Pi or Node APIs.
 * Only the supplied top-level entry is inspected; nested snapshots and retained
 * transcript tails are deliberately ignored.
 */
export class SessionCostAccumulator {
  private usage = 0;
  private readonly agentflowCosts = new Map<string, number>();

  addEntry(candidate: unknown): SessionCostDelta {
    if (!candidate || typeof candidate !== "object") return { usage: 0, agentflow: 0, total: 0 };
    const entry = candidate as Record<string, unknown>;
    let usageDelta = 0;
    let details: unknown;

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      usageDelta = usageCost(entry.usage) ?? 0;
    } else if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message as Record<string, unknown>;
      if (message.role === "assistant" || message.role === "toolResult") {
        usageDelta = usageCost(message.usage) ?? 0;
      }
      if (
        message.role === "toolResult" &&
        typeof message.toolName === "string" &&
        message.toolName.startsWith("agentflow_")
      ) {
        details = message.details;
      }
    } else if (entry.type === "custom" && entry.customType === "agentflow-cost") {
      details = entry.data;
    } else if (entry.type === "custom_message" && entry.customType === "agentflow-result") {
      details = entry.details;
    }

    this.usage += usageDelta;
    let agentflowDelta = 0;
    for (const record of directAgentflowRecords(details)) {
      const previous = this.agentflowCosts.get(record.costId) ?? 0;
      if (record.cost <= previous) continue;
      this.agentflowCosts.set(record.costId, record.cost);
      agentflowDelta += record.cost - previous;
    }
    return { usage: usageDelta, agentflow: agentflowDelta, total: usageDelta + agentflowDelta };
  }

  agentflowCostRecords(): ReadonlyMap<string, number> {
    return new Map(this.agentflowCosts);
  }

  summary(): SessionCostSummary {
    const agentflow = [...this.agentflowCosts.values()].reduce((sum, cost) => sum + cost, 0);
    return { usage: this.usage, agentflow, total: this.usage + agentflow };
  }
}

export function summarizeSessionCost(entries: Iterable<unknown>): SessionCostSummary {
  const accumulator = new SessionCostAccumulator();
  for (const entry of entries) accumulator.addEntry(entry);
  return accumulator.summary();
}
