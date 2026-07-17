# Agentflow extension error log

Top-level agents append concise reports here when Agentflow itself behaves unexpectedly. Do not log ordinary child-task failures, user cancellations, or invalid requests that already produce an accurate actionable error. Never include secrets or full sensitive prompts.

Each report should include the date, tool, run ID when available, expected and actual behavior, minimal reproduction, artifact/session references, fallback used, and status.

## 2026-07-17 — Workflow budget failures masked by sandbox IPC errors

- Tool: `agentflow_workflow`
- Runs: `af_mrp6g0q4_1`, `af_mrp6jhvy_2`
- Expected: foreground errors identify aggregate token-budget exhaustion.
- Actual: the tool reported `Workflow sandbox IPC disconnected` and `Workflow sandbox IPC send failed: write EPIPE`; the causal `Token budget exceeded` errors were visible only in `run.json`.
- Reproduction: run parallel delegates with an explicit token budget below their aggregate `usage.total`.
- Evidence: parent session `2026-07-17T16-45-08-247Z_019f70f7-af17-7ba9-9de2-a84e41bea470.jsonl` and the two run artifact directories.
- Fallback: launch independent semantic delegates and synthesize after waiting for them.
- Status: addressed by the workflow causal-error regression work tracked in the root `PLAN.md`.

## 2026-07-17 — Oracle returned an unexplained generic abort

- Tool: `agentflow_oracle`
- Run ID: not returned by the tool.
- Expected: a recommendation or an actionable error with a run ID/artifact location.
- Actual: `Subagent aborted` with no diagnostic context while reviewing Agentflow scheduler and IPC changes.
- Reproduction: ask the oracle to review the Agentflow runtime files and recommend regression coverage.
- Fallback: continue with direct source inspection and tests.
- Status: addressed; foreground semantic and raw-agent errors now include run, node, and artifact context when available.
