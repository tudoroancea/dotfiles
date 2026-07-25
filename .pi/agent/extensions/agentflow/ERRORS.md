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
- Status: fixed on 2026-07-24; semantic helpers no longer carry implicit profile deadlines, and workflows without an explicit `limits.timeoutMs` no longer have a hidden sandbox deadline.

## 2026-07-18 — Background delegates/reviews are forcibly aborted without usable results

- Tools: `agentflow_delegate`, `agentflow_review`
- Runs: `af_mrpgvyx6_3`, `af_mrph9mk8_5`, `af_mrpjlw7u_b`, `af_mrpk3ett_d`, `af_mrpkk671_e`, `af_mrpkk672_f`, `af_mrpkqxa1_g`, `af_mrpkqxa6_h`, `af_mrpkqxaa_i`, `af_mrplgxnc_k`, `af_mrplgxng_l`, `af_mrplgxnk_m`
- Expected: no-limits background delegates and focused read-only reviews complete or return an actionable child failure.
- Actual: agents doing useful tool work are aborted at exact five- or ten-minute boundaries with generic `Subagent aborted`; even four-file reviews fail to return findings, and one completed review path failed with `Subagent did not call structured_output`.
- Reproduction: launch a background delegate that needs more than ten minutes, or a focused `agentflow_review` of four medium-sized files.
- Evidence: run snapshots and session paths under `~/.pi/agent/agentflow/<runId>/`.
- Fallback: continue from partial mutations, run verification directly, and perform focused top-level review.
- Status: fixed on 2026-07-24 for the exact five-/ten-minute aborts by removing implicit semantic deadlines. The isolated missing-`structured_output` result was not reproducible and is an actionable child-compliance failure unless evidence shows the tool call was lost.

## 2026-07-20 — Foreground advisory tools returned unexplained generic aborts

- Tools: `agentflow_oracle`, `agentflow_review`
- Runs: `af_mrtcgs6b_2`, `af_mrtd1lfw_3`, `af_mrywskbm_3`
- Expected: a focused Phase 1 resolver design recommendation and an integrated diff review, or actionable failures with artifact context.
- Actual: both tools returned only `Subagent aborted` plus the run ID.
- Reproduction: ask the oracle to assess the Phase 1 design, then ask review to inspect the stable implementation diff against `PLAN.md`.
- Fallback: continue from direct source and Pi API inspection, run model-free tests, and perform a top-level diff review.
- Fresh reproduction: the pre-reload parent runtime aborted `af_mrywskbm_3` while reviewing this fix; fresh Pi processes exercised the patched runtime in RPC smoke tests.
- Status: fixed on 2026-07-24 by removing the implicit five-minute oracle/review deadline; explicit user-requested timeouts now preserve their causal timeout message.

## 2026-07-22 — Foreground integrated review aborted at five minutes

- Tool: `agentflow_review`
- Run: `af_mrw663rq_7`
- Expected: prioritized findings from a read-only review of the completed local web UI.
- Actual: the reviewer performed useful reads for exactly five minutes, then returned only `Subagent aborted` with no review result.
- Reproduction: request a no-limits review across the local `server`, `shared`, `client`, `scripts`, and `tests` paths against the project brief.
- Evidence: run snapshot `~/.pi/agent/agentflow/af_mrw663rq_7/`; no child session path was reported.
- Fallback: continue with direct top-level review, targeted tests, and a narrower follow-up review if time permits.
- Status: fixed on 2026-07-24 by removing the implicit five-minute review deadline.

## 2026-07-22 — Background stop left the launched server child listening

- Tools: `background_event_stream`, `background_stop`
- Job: `mon_3`
- Expected: stopping the runtime-owned `nub run start` job cancels its full process tree, including `node dist/server/index.js`.
- Actual: `background_stop` returned `cancelled`, but child PID 19769 remained bound to `127.0.0.1:4783`, causing the next Playwright run to fail its web-server port check.
- Reproduction: launch `nub run start 2>&1` as a persistent background event stream, then stop `mon_3` and inspect port 4783.
- Evidence: output and metadata under `~/.pi/agent/background-processes/019f89cc-8dc6-72bd-888e-d397a4c37723/abe4953c-622a-4780-ad9e-b5a8a620236a/mon_3/`.
- Fallback: terminate the orphaned wrapper/child PIDs directly, verify the port is free, and continue tests.
- Status: not reproducible on 2026-07-24 with Pi 0.82.0: an exact nested `nub run start` TCP-server reproduction stopped the server PID and closed its listening port. This belongs to the background-process/Pi local-bash process-tree backend rather than Agentflow; no Agentflow change was required.

## 2026-07-23 — Documentation review aborted after five minutes

- Tool: `agentflow_review`
- Run: `af_mrxiw91k_2`
- Expected: structured findings from a read-only review of ten Markdown files.
- Actual: the reviewer performed useful repository reads for exactly five minutes, then returned only `Subagent aborted` without findings.
- Reproduction: request a no-limits documentation diff review across `README.md`, `AGENTS.md`, `RULES.md`, and `docs/**/*.md`.
- Evidence: run snapshot `~/.pi/agent/agentflow/af_mrxiw91k_2/`.
- Fallback: inspect the partial tool trace, review the diff directly, and run formatting/link checks locally.
- Status: fixed on 2026-07-24 by removing the implicit five-minute review deadline.

## 2026-07-24 — Focused foreground review aborted after extensive unrelated inspection

- Tool: `agentflow_review`
- Run: `af_mryre25i_1`
- Expected: actionable findings for a two-file Pi upgrade skill review.
- Actual: the child consumed extensive context while inspecting unrelated paths under `~/.nub`, then returned only `Subagent aborted` without findings.
- Reproduction: request a foreground review limited to `.pi/agent/skills/pi-upgrade/SKILL.md` and its diagnostic shell script.
- Evidence: `~/.pi/agent/agentflow/af_mryre25i_1/` and the run snapshot.
- Fallback: perform direct top-level review and shell validation.
- Status: fixed on 2026-07-24 for the abort by removing the implicit five-minute review deadline. Unrelated child inspection remains a task-scoping/model behavior issue rather than a scheduler failure.

## 2026-07-24 — Pi migration re-review hit the hidden five-minute abort

- Tool: `agentflow_review`
- Run: `af_mrys4uuj_3`
- Expected: remaining actionable findings for a six-file Pi 0.82.0 migration re-review.
- Actual: the child performed useful inspection but was aborted at exactly five minutes and returned only `Subagent aborted` without findings.
- Reproduction: request a foreground re-review of the Agentflow and background-processes manifests, locks, and `child-model-runtime` migration without specifying a limit.
- Evidence: `~/.pi/agent/agentflow/af_mrys4uuj_3/` and the run snapshot.
- Fallback: rely on the first completed review, direct API/source inspection, typechecks, tests, lint, and RPC smoke checks.
- Status: fixed on 2026-07-24 by removing the implicit five-minute review deadline.

## 2026-07-24 — Workflow runtime tests race artifact cleanup

- Tool: local `vitest` via `bash`; no Agentflow run ID.
- Expected: the full Agentflow test suite completes after workflow subprocesses settle.
- Actual: `test/workflow-runtime.test.ts` intermittently fails cleanup with `ENOTEMPTY` while removing a workflow artifact directory; consecutive runs failed different cases (`child-failure` and `budget`).
- Reproduction: run `TMPDIR=/tmp nub run test` in `.pi/agent/extensions/agentflow`.
- Evidence: parent session `/Users/tudoroancea/.pi/agent/sessions/--Users-tudoroancea-dotfiles--/2026-07-24T12-56-41-036Z_019f9433-0b4c-7300-9a87-912efe93cf69.jsonl`.
- Fallback: run the focused dashboard suite separately; all 13 dashboard tests pass.
- Status: open; likely a workflow subprocess/artifact-write cleanup race unrelated to the dashboard changes.

## 2026-07-25 — Claude child advertises Pi skills that its Skill tool cannot load

- Tool: `agentflow_claude`
- Run: `af_ms0lkkgi_1`
- Expected: the controlled Claude child can invoke the staged `frontend-design` Pi skill listed in its system prompt.
- Actual: `Skill({ skill: "frontend-design" })` failed with `<tool_use_error>Unknown skill: frontend-design</tool_use_error>` even though the prompt's active-skills index included it.
- Reproduction: ask a Claude child to invoke `frontend-design` and report a heading from the loaded content.
- Evidence: `~/.pi/agent/agentflow/af_ms0lkkgi_1/` and parent session `/Users/tudoroancea/.pi/agent/sessions/--Users-tudoroancea-dotfiles--/2026-07-25T16-42-00-292Z_019f9a27-b0e4-76b3-9e80-0580064c1fe2.jsonl`.
- Fallback: inspect the skill and SDK configuration directly; official SDK guidance is to register controlled skill paths as local plugins rather than relying on `additionalDirectories` for discovery.
- Status: fixed on 2026-07-25 by staging captured Pi skills as an explicit local SDK plugin, filtering on plugin-qualified names, and validating registration from the SDK initialization message. A fresh Pi process successfully loaded `pi-agentflow-skills:frontend-design` and returned content unique to that skill.

## 2026-07-25 — Delegate failed with unexplained invalid model content

- Tool: `agentflow_delegate`
- Run: `af_ms054z1z_6`
- Expected: implement a bounded, explicitly owned server pagination task or return an actionable child-task failure.
- Actual: after seven successful repository reads, the run failed with only `The model produced invalid content` and request ID `05343e86-ef2a-4d47-b2e2-c6f0bd279f72`; no malformed content or remediation detail was exposed.
- Reproduction: launch a background delegate owning the web UI shared/server history files with explicit pagination acceptance criteria and focused Vitest/lint commands.
- Evidence: `~/.pi/agent/agentflow/af_ms054z1z_6/` and continuation session `/tmp/agentflow-web-ui-history-server.json`.
- Fallback: split the implementation into smaller bounded delegate tasks and continue from direct source inspection; the failed run made no edits.
- Status: open.

## 2026-07-25 — Review reset a working-tree CSS change and reviewed stale content

- Tool: `agentflow_review`
- Run ID: not returned by the tool.
- Expected: read-only review of the current working-tree diff in `.pi/agent/extensions/web-ui-simple/web/styles.css` against `HEAD`.
- Actual: although `git diff` immediately before the review showed the CSS change, the review claimed there was no diff and described the `HEAD` content; immediately afterward the working-tree CSS change had been reset, despite the tool being documented as non-mutating. The review also generated an untracked `package.json`, `nub.lock`, and `node_modules/` in `web-ui-simple` at 18:16:21.
- Reproduction: modify `styles.css`, confirm with `git diff`, then review that path with `base: "HEAD"` and inspect the file and status afterward.
- Evidence: parent session `019f9a09-4c87-7e0a-8459-845fd94a9562`; no run or artifact path was returned.
- Fallback: remove the generated package artifacts, reapply the two focused CSS edits directly, and verify with local `git diff`/`git diff --check`.
- Status: open.
