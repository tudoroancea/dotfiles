export const canonicalSessionCostEntries: readonly unknown[] = [
  { type: "session", timestamp: "2026-02-01T12:00:00.000Z" },
  {
    type: "message",
    id: "assistant-main",
    message: {
      role: "assistant",
      provider: "provider-a",
      model: "model-a",
      usage: { cost: { total: 1 } },
      retainedTail: [{ role: "assistant", usage: { cost: { total: 100 } } }],
    },
  },
  {
    type: "message",
    parentId: "assistant-main",
    message: {
      role: "toolResult",
      toolName: "agentflow_delegate",
      usage: { cost: { total: 0.2 } },
      details: {
        costId: "agentflow:run-a",
        cost: 0.3,
        snapshot: { usage: { cost: { total: 100 } }, costId: "agentflow:nested", cost: 100 },
      },
    },
  },
  { type: "compaction", usage: { cost: { total: 0.4 } }, retainedTail: { cost: 100 } },
  {
    type: "branch_summary",
    parentId: "assistant-main",
    usage: { cost: { total: 0.5 } },
    summary: { usage: { cost: { total: 100 } } },
  },
  {
    type: "custom",
    customType: "agentflow-cost",
    data: { costId: "agentflow:run-a", cost: 0.6, snapshot: { cost: 100 } },
  },
  {
    type: "custom_message",
    customType: "agentflow-result",
    details: {
      costs: [
        { costId: "agentflow:run-a", cost: 0.55 },
        { costId: "agentflow:run-b", cost: 0.7 },
        { costId: "other:run", cost: 100 },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "agentflow_status",
      details: { costs: [{ costId: "agentflow:run-b", cost: 0.9 }] },
    },
  },
  { type: "message", message: { role: "toolResult", details: { cost: 50 } } },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "unrelated_tool",
      details: { costId: "agentflow:unrelated-tool", cost: 50 },
    },
  },
  {
    type: "custom_message",
    customType: "unrelated",
    details: { costId: "agentflow:unrelated", cost: 50 },
  },
  { type: "message", message: { role: "assistant", usage: { cost: { total: "5" } } } },
  { type: "compaction", usage: { cost: { total: Number.NaN } } },
  {
    type: "custom",
    customType: "agentflow-cost",
    data: { costId: "agentflow: ", cost: 5 },
  },
  {
    type: "custom",
    customType: "agentflow-cost",
    data: { costId: "agentflow:negative", cost: -1 },
  },
];

export const canonicalSessionCostExpected = {
  usage: 2.1,
  agentflow: 1.5,
  total: 3.6,
} as const;
