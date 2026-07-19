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

## 2026-07-17 — Workflow child has an undocumented five-minute deadline

- Tool: `agentflow_workflow`
- Run: `af_mrpgmepo_2`
- Expected: a workflow without user-specified limits can run long research and phased implementation children to completion.
- Actual: the run failed during its first parallel research phase with `Child deadline exceeded after 300000ms`; completed sibling results were discarded and later phases never started.
- Reproduction: launch a no-limits workflow whose initial `parallel()` contains finder, oracle, and librarian research broad enough for one child to exceed five minutes.
- Evidence: `/Users/tudoroancea/.pi/agent/agentflow/af_mrpgmepo_2/{run.json,result.json,transcripts.json}`.
- Fallback: split the work into shorter workflows/delegates and reuse completed research artifacts.
- Status: open.

## 2026-07-18 — Background delegates/reviews are forcibly aborted without usable results

- Tools: `agentflow_delegate`, `agentflow_review`
- Runs: `af_mrpgvyx6_3`, `af_mrph9mk8_5`, `af_mrpjlw7u_b`, `af_mrpk3ett_d`, `af_mrpkk671_e`, `af_mrpkk672_f`, `af_mrpkqxa1_g`, `af_mrpkqxa6_h`, `af_mrpkqxaa_i`, `af_mrplgxnc_k`, `af_mrplgxng_l`, `af_mrplgxnk_m`
- Expected: no-limits background delegates and focused read-only reviews complete or return an actionable child failure.
- Actual: agents doing useful tool work are aborted at exact five- or ten-minute boundaries with generic `Subagent aborted`; even four-file reviews fail to return findings, and one completed review path failed with `Subagent did not call structured_output`.
- Reproduction: launch a background delegate that needs more than ten minutes, or a focused `agentflow_review` of four medium-sized files.
- Evidence: run snapshots and session paths under `~/.pi/agent/agentflow/<runId>/`.
- Fallback: continue from partial mutations, run verification directly, and perform focused top-level review.
- Status: open.
