import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  AGENTFLOW_LIMITS,
  AgentflowRunViewSchema,
  decodeAgentflowObservedAt,
  decodeAgentflowRunViews,
} from "../src/wire/agentflow.ts";

const NOW = Date.parse("2026-08-03T09:00:30.000Z");

const node = (overrides = {}) => ({
  status: "completed",
  prompt: "Find the auth boundary",
  cwd: "/work/project",
  tools: 2,
  usage: { total: 12_345, cost: 0.0421 },
  resultPreview: JSON.stringify({ findings: [{ title: "one" }, { title: "two" }] }),
  toolCalls: [
    { id: "c1", name: "read", status: "completed", argumentSummary: "auth.ts" },
    { id: "c2", name: "grep", status: "running", argumentSummary: "session" },
  ],
  ...overrides,
});

const snapshot = (overrides = {}) => ({
  runId: "af_1",
  kind: "agent",
  semanticRole: "finder",
  status: "completed",
  createdAt: "2026-08-03T09:00:00.000Z",
  completedAt: "2026-08-03T09:00:12.000Z",
  phases: ["explore", "report"],
  nodes: [node()],
  logs: ["log line"],
  ...overrides,
});

test("every agentflow tool shape decodes to the same schema-valid run views", () => {
  const runs = decodeAgentflowRunViews("agentflow_finder", { details: { snapshot: snapshot() } });
  assert.equal(runs.length, 1);
  assert.ok(Check(AgentflowRunViewSchema, runs[0]));
  assert.deepEqual(
    { role: runs[0].role, outcome: runs[0].outcome, elapsedMs: runs[0].elapsedMs },
    { role: "finder", outcome: "2 findings", elapsedMs: 12_000 },
  );
  assert.equal(runs[0].toolCalls.length, 2);
  assert.deepEqual(runs[0].logs, ["log line"]);
  assert.equal(runs[0].phases, "explore → report");

  // `agentflow_status` may report several runs at once, `wait` wraps each snapshot
  // in a RunResult, and `cancel` uses its own key. All three land on one shape.
  const many = decodeAgentflowRunViews("agentflow_status", {
    details: { snapshot: [snapshot(), snapshot({ runId: "af_2" })] },
  });
  assert.deepEqual(
    many.map((run) => run.runId),
    ["af_1", "af_2"],
  );
  const waited = decodeAgentflowRunViews("agentflow_wait", {
    details: { results: [{ snapshot: snapshot({ runId: "af_3" }), error: "child failed" }] },
  });
  assert.deepEqual(
    waited.map((run) => [run.runId, run.output, run.outputIsError]),
    [["af_3", "child failed", true]],
  );
  // The node's own status wins over the run's, matching the TUI renderer.
  const cancelled = decodeAgentflowRunViews("agentflow_cancel", {
    details: {
      snapshots: [
        snapshot({ runId: "af_4", status: "aborted", nodes: [node({ status: "aborted" })] }),
      ],
    },
  });
  assert.deepEqual(
    cancelled.map((run) => [run.runId, run.status, run.live]),
    [["af_4", "aborted", false]],
  );
});

test("run views stay total and bounded for malformed, hostile, and partial details", () => {
  for (const value of [
    undefined,
    null,
    "text",
    42,
    { details: null },
    { details: { snapshot: "nope" } },
    { details: { snapshot: {} } },
    { details: { results: "nope" } },
  ])
    assert.deepEqual(decodeAgentflowRunViews("agentflow_status", value), []);

  const hostile = decodeAgentflowRunViews("agentflow_agent", {
    details: {
      snapshot: {
        runId: `${"r".repeat(AGENTFLOW_LIMITS.maxIdChars * 2)}\0`,
        status: "not-a-status",
        prompt: 12,
        nodes: [
          {
            status: 5,
            prompt: "x".repeat(AGENTFLOW_LIMITS.maxPromptChars * 2),
            cwd: null,
            tools: -3,
            usage: { total: Number.NaN, cost: Number.POSITIVE_INFINITY, costKnown: false },
            resultPreview: '{"findings": [',
            toolCalls: Array.from({ length: AGENTFLOW_LIMITS.maxToolCalls + 5 }, (_, index) => ({
              name: `tool-${index}`,
              status: "queued",
            })),
            logs: "nope",
          },
        ],
        logs: Array.from({ length: AGENTFLOW_LIMITS.maxLogLines + 10 }, (_, i) => `line ${i}`),
      },
    },
  })[0];
  assert.ok(hostile);
  assert.ok(Check(AgentflowRunViewSchema, hostile));
  assert.equal(hostile.runId.length, AGENTFLOW_LIMITS.maxIdChars);
  assert.doesNotMatch(hostile.runId, /\0/);
  assert.equal(hostile.status, "queued", "unknown statuses normalize instead of leaking through");
  assert.equal(hostile.prompt.length, AGENTFLOW_LIMITS.maxPromptChars);
  assert.deepEqual(
    { tools: hostile.tools, tokens: hostile.tokens, cost: hostile.cost },
    { tools: 0, tokens: 0, cost: 0 },
  );
  assert.equal(hostile.costKnown, false);
  assert.equal(hostile.outcome, "", "incomplete streamed JSON yields no outcome");
  assert.equal(hostile.toolCalls.length, AGENTFLOW_LIMITS.maxToolCalls);
  assert.equal(hostile.omittedToolCalls, 5);
  assert.equal(hostile.logs.length, AGENTFLOW_LIMITS.maxLogLines);
  assert.equal(
    decodeAgentflowRunViews("agentflow_status", {
      details: { snapshot: Array.from({ length: AGENTFLOW_LIMITS.maxRuns + 4 }, () => snapshot()) },
    }).length,
    AGENTFLOW_LIMITS.maxRuns,
  );
});

test("run and workflow-node backend/model facts stay separate and bounded", () => {
  const longBackend = "b".repeat(AGENTFLOW_LIMITS.maxLabelChars + 20);
  const longModel = "m".repeat(AGENTFLOW_LIMITS.maxLabelChars + 20);
  const workflow = decodeAgentflowRunViews("agentflow_status", {
    details: {
      snapshot: snapshot({
        kind: "workflow",
        artifactDir: "/work/project/.agentflow/artifacts/af_1",
        nodes: [
          node({
            id: "research",
            label: "Research",
            phase: "explore",
            backend: longBackend,
            model: longModel,
          }),
          node({
            id: "review",
            label: "Review",
            phase: "report",
            backend: "claude",
            model: "opus",
          }),
        ],
        logs: ["started research", "finished review"],
      }),
    },
  })[0];

  assert.ok(Check(AgentflowRunViewSchema, workflow));
  assert.deepEqual(
    { backend: workflow.backend, model: workflow.model },
    {
      backend: longBackend.slice(0, AGENTFLOW_LIMITS.maxLabelChars),
      model: longModel.slice(0, AGENTFLOW_LIMITS.maxLabelChars),
    },
  );
  assert.deepEqual(
    workflow.nodes.map(({ backend, model }) => ({ backend, model })),
    [
      {
        backend: longBackend.slice(0, AGENTFLOW_LIMITS.maxLabelChars),
        model: longModel.slice(0, AGENTFLOW_LIMITS.maxLabelChars),
      },
      { backend: "claude", model: "opus" },
    ],
  );
  assert.equal(workflow.artifactDir, "/work/project/.agentflow/artifacts/af_1");
  assert.deepEqual(workflow.logs, ["started research", "finished review"]);
});

test("workflow nodes decode subagent detail and group by declared phase", () => {
  const workflow = decodeAgentflowRunViews(
    "agentflow_status",
    {
      details: {
        snapshot: snapshot({
          kind: "workflow",
          status: "running",
          completedAt: undefined,
          phases: ["survey", "verify", "survey", "report"],
          nodes: [
            node({
              id: "s1",
              label: "survey",
              phase: "survey",
              status: "completed",
              startedAt: "2026-08-03T09:00:00.000Z",
              completedAt: "2026-08-03T09:00:04.000Z",
            }),
            node({
              id: "v1",
              label: "verify",
              phase: "verify",
              status: "running",
              startedAt: "2026-08-03T09:00:05.000Z",
              completedAt: undefined,
              usage: { total: 900, cost: 0, costKnown: false },
              toolCalls: Array.from({ length: 6 }, (_, index) => ({
                id: `t${index}`,
                name: "read",
                status: "completed",
                argumentSummary: `file-${index}.ts`,
              })),
            }),
            node({
              id: "s1",
              label: "loose",
              phase: "cleanup",
              status: "queued",
              startedAt: undefined,
              completedAt: undefined,
            }),
          ],
        }),
      },
    },
    NOW,
  )[0];

  assert.ok(Check(AgentflowRunViewSchema, workflow));
  // Declared order wins; a node whose phase is not declared falls into the trailing
  // ungrouped bucket, and each phase's status and elapsed time are derived from its nodes.
  assert.deepEqual(
    workflow.phaseGroups.map((group) => [group.title, group.status, group.elapsedMs]),
    [
      ["survey", "completed", 4_000],
      ["verify", "running", 25_000],
      ["", "queued", 0],
    ],
  );
  assert.deepEqual(workflow.phaseGroups[0].nodeIds, ["s1"]);
  assert.equal(workflow.nodes[2].id, "s1-2", "duplicate node ids normalize uniquely");
  assert.deepEqual(workflow.phaseGroups[2].nodeIds, ["s1-2"]);

  const verify = workflow.nodes.find((item) => item.id === "v1");
  assert.equal(verify.prompt, "Find the auth boundary");
  assert.equal(verify.toolCalls.length, 4, "a node keeps only its most recent tool calls");
  assert.equal(verify.omittedToolCalls, 2);
  assert.equal(verify.elapsedMs, 25_000);
  assert.equal(verify.costKnown, false);
});

test("workflow node bounds retain the newest nodes and count only earlier omissions", () => {
  const workflow = decodeAgentflowRunViews("agentflow_workflow", {
    details: {
      snapshot: snapshot({
        kind: "workflow",
        phases: ["work"],
        nodes: Array.from({ length: AGENTFLOW_LIMITS.maxNodes + 2 }, (_, index) =>
          node({ id: `node-${index}`, label: `node ${index}`, phase: "work" }),
        ),
      }),
    },
  })[0];

  assert.equal(workflow.omittedNodes, 2);
  assert.equal(workflow.nodes[0].id, "node-2");
  assert.equal(workflow.nodes.at(-1).id, `node-${AGENTFLOW_LIMITS.maxNodes + 1}`);
  assert.equal(workflow.phaseGroups[0].nodeIds.at(-1), `node-${AGENTFLOW_LIMITS.maxNodes + 1}`);
});

test("control wrappers preserve their settled output and observation time", () => {
  const observedAt = Date.parse("2026-08-03T09:00:20.000Z");
  const waited = decodeAgentflowRunViews(
    "agentflow_wait",
    {
      details: {
        observedAt,
        results: [{ snapshot: snapshot(), result: "settled wrapper output" }],
      },
    },
    observedAt,
  )[0];
  assert.equal(waited.output, "settled wrapper output");
  assert.equal(waited.elapsedMs, 12_000);
  assert.equal(decodeAgentflowObservedAt({ details: { observedAt } }), observedAt);
});

test("semantic outputs decode every role property and keep prose separate from plain metadata", () => {
  const fixtures = {
    finder: {
      summary: "# Summary",
      findings: [{ path: "src/a.ts", range: "1-2", relevance: "**Relevant** here." }],
      unresolvedQuestions: ["Any callers?"],
    },
    oracle: {
      recommendation: "# Queue writes",
      assumptions: ["Calls overlap."],
      risks: ["Lost updates."],
      revisitConditions: ["Execution becomes serial."],
    },
    librarian: {
      summary: "# Docs agree",
      sources: [{ title: "Reference", url: "https://example.test", evidence: "Says **yes**." }],
      unresolvedQuestions: ["Version differences?"],
    },
    look_at: {
      summary: "# Two lanes",
      observations: ["Left is input."],
      comparisons: [
        {
          referenceFile: "reference.png",
          similarities: ["Both are blue."],
          differences: ["Target has labels."],
        },
      ],
      uncertainties: ["Caption is blurred."],
    },
    delegate: {
      summary: "# Implemented",
      filesChanged: ["src/a.ts"],
      verification: [{ command: "nub run test", status: "passed", output: "42 passed" }],
      followUps: ["Add **fuzzing**."],
    },
    review: {
      summary: "# One issue",
      findings: [
        {
          severity: "high",
          path: "src/a.ts",
          location: "L1-L2",
          explanation: "This can **race**.",
          remediation: "Use `withQueue()`.",
        },
      ],
    },
  };
  const expected = {
    finder: [
      "Summary::markdown",
      "Findings/Finding 1/Path:plain",
      "Findings/Finding 1/Range:plain",
      "Findings/Finding 1/Relevance:markdown",
      "Unresolved questions::markdown",
    ],
    oracle: [
      "Recommendation::markdown",
      "Assumptions::markdown",
      "Risks::markdown",
      "Revisit conditions::markdown",
    ],
    librarian: [
      "Summary::markdown",
      "Sources/Source 1/Title:plain",
      "Sources/Source 1/URL:plain",
      "Sources/Source 1/Evidence:markdown",
      "Unresolved questions::markdown",
    ],
    look_at: [
      "Summary::markdown",
      "Observations::markdown",
      "Comparisons/Comparison 1/Reference file:plain",
      "Comparisons/Comparison 1/Similarities:markdown",
      "Comparisons/Comparison 1/Differences:markdown",
      "Uncertainties::markdown",
    ],
    delegate: [
      "Summary::markdown",
      "Files changed::plain",
      "Verification/Check 1/Command:plain",
      "Verification/Check 1/Status:plain",
      "Verification/Check 1/Output:plain",
      "Follow-ups::markdown",
    ],
    review: [
      "Summary::markdown",
      "Findings/Finding 1/Severity:plain",
      "Findings/Finding 1/Path:plain",
      "Findings/Finding 1/Location:plain",
      "Findings/Finding 1/Explanation:markdown",
      "Findings/Finding 1/Remediation:markdown",
    ],
  };

  for (const [role, result] of Object.entries(fixtures)) {
    const run = decodeAgentflowRunViews(`agentflow_${role}`, {
      details: {
        result,
        snapshot: snapshot({
          semanticRole: role,
          resultPreview: '{"truncated":',
          nodes: [node({ semanticRole: role, resultPreview: '{"truncated":' })],
        }),
      },
    })[0];
    assert.ok(Check(AgentflowRunViewSchema, run));
    assert.ok(run.structuredOutput, `${role} should decode its exact result`);
    const paths = run.structuredOutput.sections.flatMap((section) => [
      ...section.fields.map((field) => `${section.label}:${field.label}:${field.kind}`),
      ...section.items.flatMap((item) =>
        item.fields.map((field) => `${section.label}/${item.label}/${field.label}:${field.kind}`),
      ),
    ]);
    assert.deepEqual(paths, expected[role]);
    if (role === "review") {
      assert.equal(run.structuredOutput.sections[0].fields[0].values[0], "# One issue");
      assert.equal(
        run.structuredOutput.sections[1].items[0].fields[4].values[0],
        "Use `withQueue()`.",
      );
    }
  }
});

test("semantic output uses raw fallback for partial, invalid, extra, and oversized values", () => {
  const decode = (result, resultPreview = JSON.stringify(result)) =>
    decodeAgentflowRunViews("agentflow_delegate", {
      details: {
        result,
        snapshot: snapshot({
          semanticRole: "delegate",
          resultPreview,
          nodes: [node({ semanticRole: "delegate", resultPreview })],
        }),
      },
    })[0];
  const valid = {
    summary: "done",
    filesChanged: [],
    verification: [],
    followUps: [],
  };
  assert.ok(decode(valid).structuredOutput);
  assert.equal(decode(undefined, '{"summary":"cut"').structuredOutput, null);
  assert.equal(decode({ ...valid, extra: true }).structuredOutput, null);
  assert.equal(
    decode({
      ...valid,
      verification: [{ command: "test", status: "maybe", output: "" }],
    }).structuredOutput,
    null,
  );
  assert.equal(
    decode({ ...valid, summary: "x".repeat(AGENTFLOW_LIMITS.maxOutputChars + 1) }).structuredOutput,
    null,
  );
  assert.equal(
    decode(" ".repeat(AGENTFLOW_LIMITS.maxOutputChars + 1), "oversized encoded result")
      .structuredOutput,
    null,
  );
  const multiplicative = {
    summary: "visual summary",
    observations: [],
    comparisons: Array.from({ length: 64 }, (_, index) => ({
      referenceFile: `reference-${index}.png`,
      similarities: Array.from({ length: 64 }, () => ""),
      differences: Array.from({ length: 64 }, () => ""),
    })),
    uncertainties: [],
  };
  const lookAt = decodeAgentflowRunViews("agentflow_look_at", {
    details: {
      result: multiplicative,
      snapshot: snapshot({
        semanticRole: "look_at",
        resultPreview: "bounded preview",
        nodes: [node({ semanticRole: "look_at", resultPreview: "bounded preview" })],
      }),
    },
  })[0];
  assert.equal(lookAt.structuredOutput, null);
});

test("elapsed time only extrapolates to now while a run is still going", () => {
  const live = decodeAgentflowRunViews(
    "agentflow_agent",
    {
      details: {
        snapshot: snapshot({
          status: "running",
          completedAt: undefined,
          nodes: [node({ status: "running", completedAt: undefined })],
        }),
      },
    },
    NOW,
  )[0];
  assert.equal(live.live, true);
  assert.equal(live.elapsedMs, 30_000);

  // A finished run without a completion timestamp has an unknown duration; it
  // must not keep counting up from `createdAt` forever.
  const stale = decodeAgentflowRunViews(
    "agentflow_agent",
    {
      details: {
        snapshot: snapshot({
          completedAt: undefined,
          nodes: [node({ completedAt: undefined })],
        }),
      },
    },
    NOW,
  )[0];
  assert.equal(stale.live, false);
  assert.equal(stale.elapsedMs, 0);

  const backgroundWorkflow = decodeAgentflowRunViews(
    "agentflow_workflow",
    {
      details: {
        snapshot: snapshot({
          kind: "workflow",
          background: true,
          status: "running",
          completedAt: undefined,
          phases: ["active"],
          nodes: [
            node({
              id: "active",
              phase: "active",
              status: "running",
              startedAt: "2026-08-03T09:00:00.000Z",
              completedAt: undefined,
            }),
          ],
        }),
      },
    },
    NOW,
  )[0];
  assert.equal(backgroundWorkflow.nodes[0].elapsedMs, 0);
  assert.equal(backgroundWorkflow.phaseGroups[0].elapsedMs, 0);
});

test("a recorded observation replaces the clock for the rows it describes", () => {
  const observedAt = Date.parse("2026-08-03T09:00:20.000Z");
  assert.equal(decodeAgentflowObservedAt({ details: { observedAt } }), observedAt);
  // A launching tool records nothing, so its rows are free to measure against now.
  assert.equal(decodeAgentflowObservedAt({ details: { snapshot: snapshot() } }), undefined);
  for (const value of [
    undefined,
    null,
    "text",
    { details: { observedAt: "soon" } },
    {
      details: { observedAt: Number.NaN },
    },
  ])
    assert.equal(decodeAgentflowObservedAt(value), undefined);

  const running = {
    status: "running",
    completedAt: undefined,
    nodes: [node({ status: "running", completedAt: undefined })],
  };
  const observed = decodeAgentflowRunViews(
    "agentflow_status",
    { details: { snapshot: snapshot(running), observedAt } },
    observedAt,
  )[0];
  assert.equal(observed.elapsedMs, 20_000, "measured against the observation, not the clock");
});
