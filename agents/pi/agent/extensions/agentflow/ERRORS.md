# Agentflow extension error log

Top-level agents append concise reports here when Agentflow itself behaves unexpectedly. Do not log ordinary child-task failures, user cancellations, or invalid requests that already produce an accurate actionable error. Never include secrets or full sensitive prompts.

Each report should include the date, tool, run ID when available, expected and actual behavior, minimal reproduction, artifact/session references, fallback used, and status.

## 2026-08-06 — Finder returned no structured result for dashboard recovery map

- Tool: `agentflow_finder`; run `af_mshgd5p5_1`.
- Expected: a repository map of dashboard state, artifact recovery, session scoping, and relevant tests.
- Actual: the tool returned `Subagent did not call structured_output` with no findings.
- Reproduction: ask the finder whether `/agentflow` restores subagent runs after reloading or resuming a Pi session.
- Evidence: run `af_mshgd5p5_1`; no artifact path was returned.
- Fallback: inspect `src/index.ts`, `src/runtime/{run-engine,artifact-store,workflow-runtime}.ts`, `src/ui/dashboard.ts`, and tests directly.
- Status: open.

## 2026-08-05 — Finder returned no structured result for daemon model-control map

- Tool: `agentflow_finder`; run `af_msh6jo5x_b`.
- Expected: a repository map for shared model-control adoption in the remote-session daemon.
- Actual: the tool returned `Subagent did not call structured_output` with no findings.
- Reproduction: ask the finder to map the daemon parser, managed transport, projection capability source, host commands, and tests needed for shared Phase 5C model controls.
- Evidence: run `af_msh6jo5x_b`; no artifact path was returned.
- Fallback: inspect the daemon transport, API schemas/server, SDK host/bundle, projection, and tests directly.
- Status: open.

## 2026-08-05 — Finder returned no structured result

- Tool: `agentflow_finder`; run `af_msgadg8v_1`.
- Expected: a repository map locating the web UI shortcut and display-filter dialogs and their keyboard handlers.
- Actual: the tool returned `Subagent did not call structured_output` with no repository findings.
- Reproduction: ask the finder to locate the web UI keymap hint dialog, transcript filter dialog, keyboard handling, focus behavior, and tests under `agent/extensions/web-ui` and `packages/pi-web-ui-client`.
- Evidence: run `af_msgadg8v_1`; no artifact path was returned.
- Fallback: use `ffgrep` and direct file reads to locate and fix the handlers.
- Status: open.

## 2026-08-05 — Focused review fetch failed

- Tool: `agentflow_review`; run `af_msfwqc1q_3`.
- Expected: a structured read-only review of the final Agentflow renderer diff.
- Actual: the tool returned `fetch failed` without findings.
- Reproduction: request a focused review against `HEAD` for the Agentflow TUI/web renderer and test paths.
- Evidence: run `af_msfwqc1q_3`; no artifact path was returned.
- Fallback: inspect the final diff directly and run both package typechecks, formatting checks, and test suites.
- Status: open.

## 2026-07-28 — Delegate integration removed unowned files from an untracked subtree

- Tools: `agentflow_workflow`/`agentflow_delegate`; runs include `af_ms4fto2h_4` and `af_ms4hhw8y_8`.
- Expected: delegates with explicit ownership under an untracked `apps/remote-session-daemon/` subtree preserve pre-existing unowned `PLAN.md`, `docs/SDK_HOSTING_EVALUATION.md`, and `docs/PI_EVENT_BUS_RELOAD_MRE.md`.
- Actual: all three unowned files disappeared while owned implementation files integrated; the final delegate's file inventory confirms they were absent despite no ownership or requested deletion.
- Reproduction: create an untracked subtree containing pre-existing files, delegate changes to disjoint owned paths within that subtree, integrate, and compare the full pre/post inventory.
- Evidence: `/Users/tudoroancea/.pi/agent/agentflow/af_ms4fto2h_4/`, run `af_ms4hhw8y_8`, and parent session `019fa7f6-34c0-7984-8763-d1da802d2128`.
- Fallback: restore the three files from the main checkout, then update the owning plan directly.
- Status: open.

## 2026-07-28 — Workflow parallel misuse produced an internal TypeError

- Tool: `agentflow_workflow`; run `af_ms4fsvyq_3`.
- Expected: passing already-started helper promises to `parallel()` is rejected with an actionable validation error explaining that thunks are required.
- Actual: the run failed before creating nodes with `Cannot read properties of undefined (reading 'ok')`.
- Reproduction: call `parallel([delegate({...}), delegate({...})])` instead of wrapping each helper in `() => delegate({...})`.
- Evidence: `/Users/tudoroancea/.pi/agent/agentflow/af_ms4fsvyq_3/`; reproduced again on 2026-08-05 as run `af_msfpj2be_4` with artifacts at `/Users/tudoroancea/.pi/agent/agentflow/af_msfpj2be_4/`.
- Fallback: read the workflow skill, correct the calls to thunks, and rerun.
- Status: open; invalid workflow syntax should not surface an internal TypeError.

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

## 2026-07-27 — Read-only review rewrote global model settings

- Tool: `agentflow_review`; no run ID was returned by the tool.
- Expected: a scoped review against `HEAD` reads the working tree without mutating repository or user configuration.
- Actual: after the review completed successfully, `agent/settings.json` had been reformatted and its `defaultProvider` changed from `pave` to `openai-codex`; the enabled-model ordering also changed.
- Reproduction: run a foreground `agentflow_review` from the `~/.pi` repository, then inspect `git diff -- agent/settings.json`.
- Evidence: parent session `/Users/tudoroancea/.pi/agent/sessions/--Users-tudoroancea-.pi--/2026-07-27T13-26-30-726Z_019fa3c1-6e46-7338-ab9e-c573df51e789.jsonl`.
- Fallback: restore `agent/settings.json` from `HEAD` and retain the review result.
- Status: open.

## 2026-07-27 — Finder completed without structured output

- Tool: `agentflow_finder`; run `af_ms3chmlf_3`.
- Expected: a compressed map of process-global and module-global assumptions across the web-ui, Agentflow, background-processes, and Herdr extensions.
- Actual: the tool returned only `Subagent did not call structured_output`, with no repository map or partial findings.
- Reproduction: request a foreground conceptual inspection of those four extension paths, asking it to distinguish routine multi-session collisions from rare fatal failures.
- Fallback: use direct targeted content search and file reads.
- Status: open.

## 2026-07-27 — Finder again completed without structured output

- Tool: `agentflow_finder`; run `af_ms3mwanr_1`.
- Expected: a compressed map of the coding-agent extension runtime, event bus, reload/disposal lifecycle, and relevant tests.
- Actual: the tool returned only `Subagent did not call structured_output`, with no repository map or partial findings.
- Reproduction: request a foreground conceptual inspection scoped to `packages/coding-agent/src` and `packages/coding-agent/test` for event-bus listener ownership across session reload.
- Fallback: use `fffind`, `ffgrep`, direct full-file reads, and git/GitHub history inspection.
- Status: open.

## 2026-07-29 — Finder completed without structured output during worktree assessment

- Tool: `agentflow_finder`; run `af_ms647vje_1`.
- Expected: a compressed status map of the daemon plan, implementation, tests, shared-contract dependencies, and next incomplete work.
- Actual: the tool returned only `Subagent did not call structured_output`, with no repository map or partial findings.
- Reproduction: request a foreground conceptual assessment scoped to `apps/remote-session-daemon`, `packages/pi-web-ui-client`, the root manifest, and `AGENTS.md`.
- Evidence: parent session `/Users/tudoroancea/.pi/agent/sessions/--Users-tudoroancea-.pi-.worktrees-remote-daemon-core--/2026-07-29T13-22-46-771Z_019fae0a-bb73-7cf5-b60c-1069f96dcc21.jsonl`.
- Fallback: use the successful main-worktree finder plus direct plan, source, test, and Git inspection.
- Status: open.

## 2026-07-27 — Delegate integration cleared pre-existing staged state

- Tool: `agentflow_delegate`; run `af_ms3mym8r_1`; continuation session `/tmp/remote-daemon-phase0d-delegate.json`.
- Expected: the delegate edits only its two exclusively owned new files and preserves the index state of unrelated parent-session work.
- Actual: before launch, the SDK multisession fixtures were staged additions and `apps/remote-session-daemon/PLAN.md` was staged; after completion, the fixtures were untracked and the plan was only unstaged, while file contents remained present.
- Reproduction: stage parent-session files, launch a delegate with disjoint ownership, wait for successful integration, then compare `git status --short` before and after.
- Fallback: preserve and verify the working-tree contents directly; do not assume Agentflow integration preserves staging.
- Status: open.

## 2026-07-28 — Claude child hit an undocumented 30-minute deadline

- Tool: `agentflow_claude`; run `af_ms4eg3d3_6`.
- Expected: a no-limits foreground Opus coding child completes an idiomatic TypeScript conversion or returns a task-level result.
- Actual: after 79 productive tool calls and partial file edits, the run failed at exactly 1,800,000 ms with `Claude child deadline exceeded`; the task had no user-requested timeout.
- Reproduction: launch a broad but scoped Opus edit task without limits that requires more than 30 minutes.
- Evidence: `~/.pi/agent/agentflow/af_ms4eg3d3_6/`; reproduced by the narrower TSX follow-up `af_ms4gykoj_9`, which also timed out at exactly 1,800,000 ms after 80 productive tool calls.
- Fallback: retain the partial edits, finish the remaining configuration and verification directly, and verify locally.
- Status: open.

## 2026-07-28 — Workflow `parallel` positional misuse surfaced an internal TypeError

- Tool: `agentflow_workflow`; run `af_ms4nvepu_1`.
- Expected: passing positional helper promises to `parallel(...)` instead of the documented thunk array is rejected with an actionable validation error.
- Actual: the workflow failed with the internal error `thunks.map is not a function` and returned no child results.
- Reproduction: call `parallel(finder({...}), finder({...}))` rather than `parallel([() => finder({...}), ...])`.
- Evidence: `~/.pi/agent/agentflow/af_ms4nvepu_1/`; parent session `019fa8c7-53ee-70d3-ae27-06ecb39f27c7`.
- Fallback: read the workflow skill and invoke independent top-level finders in parallel.
- Status: open; invalid workflow shape should produce an actionable validation error rather than an internal TypeError.

## 2026-07-28 — Workflow parallel helper returned undefined and discarded child results

- Tool: `agentflow_workflow`; run `af_ms4m8ndh_3`.
- Expected: three parallel `finder(...)` calls return normalized envelopes that can be checked through `result.ok`.
- Actual: the workflow failed with `Cannot read properties of undefined (reading 'ok')`; one finder was reported as aborted and no child results were returned.
- Reproduction: assign `await parallel([finder(...), finder(...), finder(...)])`, then iterate over the returned values and read `.ok`.
- Evidence: `~/.pi/agent/agentflow/af_ms4m8ndh_3/`.
- Fallback: invoke three top-level `agentflow_finder` tools in parallel and synthesize their successful results.
- Status: open.

## 2026-07-31 — Final Agentflow review child returned without structured output

- Tool: `agentflow_review`; run `af_ms93ln2o_a`.
- Expected: a normalized structured review envelope with actionable findings.
- Actual: the child reported `Subagent did not call structured_output` and returned no review findings.
- Reproduction: run a focused `agentflow_review` over the integrated diff after implementation.
- Evidence: run `af_ms93ln2o_a`; no mutation or artifact path was reported.
- Fallback: use the earlier successful structured review findings, run the full `nub run check`, and inspect `git diff --check`/status directly.
- Status: open.

## 2026-08-05 — Finder completed without structured output during workflow-renderer mapping

- Tool: `agentflow_finder`; run `af_msfsfmpp_1`.
- Expected: a compressed map of the TUI and browser workflow renderers, phase/status data, related tests, and owning plans.
- Actual: the tool returned only `Subagent did not call structured_output`, with no repository map or partial findings.
- Reproduction: request a foreground conceptual map of `agentflow_workflow` rendering across the Agentflow extension and shared Web UI client.
- Evidence: parent session `019fd0d8-c323-7804-aa98-e37104619942`.
- Fallback: use `fffind`, `ffgrep`, direct complete file reads, and focused tests.
- Status: open; repeats the existing finder structured-output failure pattern.

## 2026-07-31 — Librarian tool calls time out at 120 s in intermittent runs

- Tool: `agentflow_librarian`; runs `af_msd5lx7m_1` (foreground, `fetch_content` timeout), `af_msd5lx7p_2` (background, `fetch_content` timeout), `af_msd5v36v_4` (background, `web_search` timeout).
- Expected: a librarian researching a web question completes within its tool-call budget and returns a structured answer with sources.
- Actual: three of five runs in one session aborted when a single child tool call (`fetch_content` twice, `web_search` once) hung for exactly 120,000 ms; the identical queries succeeded on retry (foreground `af_msd5v36v_3`, background `af_msd61r4n_5`), including background mode, so the failures are not a persistent provider outage.
- Reproduction: launch librarian runs (foreground and background) with web questions that trigger `fetch_content` page fetches; observe intermittent 120 s tool timeouts. Constraining the child to search snippets only (no `fetch_content`) did not fully avoid them — `web_search` itself timed out once.
- Evidence: run artifacts in `~/.pi/agent/agentflow/` (e.g. `af_msd5lx7m_1`); parent session was a web-UI renderer smoke test.
- Fallback: relaunch the same question; on success, the child returns a snippet-based answer with sources.
- Status: open; possible relationship to background vs. foreground scheduling, but the foreground run also timed out once, so it is not background-specific.
