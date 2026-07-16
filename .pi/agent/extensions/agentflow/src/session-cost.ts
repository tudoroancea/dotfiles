interface CostRecord {
  costId: string;
  cost: number;
}

function isCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addDetailsCost(
  details: unknown,
  unkeyed: { total: number },
  keyed: Map<string, number>,
): void {
  if (!details || typeof details !== "object") return;

  const value = details as {
    cost?: unknown;
    costId?: unknown;
    costs?: unknown;
  };
  if (isCost(value.cost)) {
    if (typeof value.costId === "string") {
      keyed.set(value.costId, Math.max(keyed.get(value.costId) ?? 0, value.cost));
    } else {
      unkeyed.total += value.cost;
    }
  }

  if (!Array.isArray(value.costs)) return;
  for (const candidate of value.costs) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Partial<CostRecord>;
    if (typeof record.costId !== "string" || !isCost(record.cost)) continue;
    keyed.set(record.costId, Math.max(keyed.get(record.costId) ?? 0, record.cost));
  }
}

export function getSessionCost(entries: readonly unknown[]): number {
  const unkeyed = { total: 0 };
  const keyed = new Map<string, number>();

  for (const candidate of entries) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
      details?: unknown;
      message?: {
        role?: unknown;
        usage?: { cost?: { total?: unknown } };
        details?: unknown;
      };
    };

    if (entry.type === "custom" && entry.customType === "agentflow-cost") {
      addDetailsCost(entry.data, unkeyed, keyed);
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "agentflow-result") {
      addDetailsCost(entry.details, unkeyed, keyed);
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;

    if (entry.message.role === "assistant") {
      const cost = entry.message.usage?.cost?.total;
      if (isCost(cost)) unkeyed.total += cost;
      continue;
    }
    if (entry.message.role === "toolResult" || entry.message.role === "custom") {
      addDetailsCost(entry.message.details, unkeyed, keyed);
    }
  }

  return unkeyed.total + [...keyed.values()].reduce((sum, cost) => sum + cost, 0);
}
