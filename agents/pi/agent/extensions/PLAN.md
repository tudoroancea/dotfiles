# Standalone and Cross-Extension Maintenance Plan

## Scope

This plan owns deferred maintenance that crosses top-level standalone extensions or does not belong to the packaged Agentflow, background-processes, Web UI/shared-client, or daemon plans.

It specifically owns:

- canonical session-cost accounting shared by TUI/session-summary consumers;
- the future of the disabled Worktrunk statusline;
- verification and simplification of `notify.ts`;
- the product decision around `custom-header.ts`;
- UI ownership checks among standalone editor/header/footer extensions.

It does not own:

- Agentflow runtime work (`agentflow/PLAN.md`);
- background runtime work (`background-processes/PLAN.md`);
- Web UI/shared-client implementation (`web-ui/PLAN.md`);
- remote daemon implementation (`../../apps/remote-session-daemon/PLAN.md`).

## Context and invariants

- `boxed-editor` is the enabled TUI editor/footer owner and requires a second Escape for interruption while preserving autocomplete dismissal and Pi's current interrupt handler.
- Human waits initiated by the agent or autonomous extension actions must retain balanced `withHerdrBlocked` handling; UI opened directly by the user must not report the agent as blocked.
- TUI and browser presentation may share accounting semantics without sharing host-specific UI implementations.
- Disabled code is not permission to delete it; retirement requires an explicit product decision recorded here.

## Phase 1 — canonical session-cost accounting

Canonical accounting now defines session cost as recorded provider spend in the supplied top-level entries, not the cost of the current LLM context:

- Boxed Editor and Web UI report the whole session tree from `getEntries()`;
- `/session-breakdown` reports every top-level entry in each historical JSONL file;
- assistant/tool-result message usage plus compaction and branch-summary usage are counted from their top-level usage records;
- explicit Agentflow cost/result/tool representations are deduplicated globally by non-empty `agentflow:` cost ID, retaining the greatest recorded value;
- historical aggregation suppresses propagated Agentflow child cost already represented by an included persisted child session, while retaining cost for unavailable or in-memory children;
- nested snapshots and retained transcript tails are not recursively counted.

- [x] Define whether each surface reports active-branch, whole-session-tree, or historical-file cost.
- [x] Define which entry kinds are authoritative for assistant, tool, compaction, branch-summary, and Agentflow child costs.
- [x] Specify keyed deduplication so the same Agentflow cost is never counted twice when represented by both cost and result entries.
- [x] Extract only the host-neutral entry-accounting helper into `agent/extensions/lib/`; keep formatting and UI host-specific.
- [x] Add shared fixtures covering branches, duplicate Agentflow cost IDs, tool results, compactions, summaries, missing usage, and malformed details.
- [x] Make boxed-editor, Web UI projection, and `/session-breakdown` deliberately select the appropriate scope while sharing the accounting rules.

Exit criteria:

- differences between displayed totals are explained by scope, not divergent parsing;
- all consumers agree for the same entry set;
- Web UI shared-client boundaries remain intact because raw Pi entry accounting stays host-side.

## Phase 2 — decide the Worktrunk statusline's future

`worktrunk-statusline.ts` is disabled because its footer conflicts with boxed-editor, but it also owns Worktrunk marker updates that boxed-editor does not replace.

- [ ] Confirm whether Worktrunk marker/status integration is still desired.
- [ ] If desired, separate marker production from footer rendering and keep boxed-editor as the sole footer owner.
- [ ] If not desired, explicitly retire the extension, remove its disable entry, and update footer-ownership tests in the same change.
- [ ] Preserve balanced startup/shutdown for any retained timer or subprocess work.

Exit criteria:

- no dormant competing footer implementation remains without a documented reason;
- desired Worktrunk integration, if retained, has one narrow responsibility.

## Phase 3 — verify and simplify notifications

`notify.ts` currently combines terminal-focus tracking, desktop notifications, question detection, completion behavior, and Agentflow-child suppression without dedicated tests.

- [ ] Verify whether Pi already owns terminal focus reporting and whether the extension's raw stdin listener or `?1004` writes can interfere with TUI input/lifecycle.
- [ ] Enumerate the actual registered question tools in a live session and determine whether the legacy `question` tool hook is still reachable.
- [ ] Verify whether the current persisted-session and `Task label:` heuristics correctly distinguish Agentflow children.
- [ ] Add focused tests for focused/unfocused completion, pending-question notification, child suppression, shutdown cleanup, and listener balancing.
- [ ] Remove only branches proven unreachable after live verification.
- [ ] Coordinate future browser notifications through host-neutral events in `web-ui/PLAN.md`; do not merge browser and macOS delivery implementations.

Exit criteria:

- notifications have explicit event sources and tested focus gating;
- no raw listener or terminal mode survives shutdown;
- obsolete Agentflow-era heuristics are removed or documented.

## Phase 4 — decide custom header ownership

`custom-header.ts` provides deliberate mascot/aesthetic behavior but repeats model and cwd information shown by boxed-editor and may not refresh after model changes.

- [ ] Decide whether the mascot header remains a desired product feature.
- [ ] If retained, verify model-change and cwd/session-transition refresh behavior and remove duplicated metadata if it adds no value.
- [ ] If retired, restore the preferred built-in-header behavior rather than silently losing key hints.
- [ ] Add an ownership test ensuring exactly the intended enabled extension controls each of header, editor, and footer surfaces.

Exit criteria:

- the header is either intentionally retained and lifecycle-correct or explicitly retired;
- active UI ownership is deterministic and test-enforced.

## Dependency and parallelism

- Phases 2, 3, and 4 are independent product decisions and may run in parallel.
- Phase 1 can proceed independently, but the Web UI consumer should be migrated during Web UI Phase 1 projection modularization to avoid duplicate churn.
- Browser notification work remains owned by `web-ui/PLAN.md`; this plan owns only the local notification producer audit.

## Verification

Run focused tests for each affected extension, followed by:

```sh
nub run check
```

Also perform a TUI smoke covering double-Escape interruption, autocomplete dismissal, boxed-editor framing/footer, custom header behavior, notifications, and any retained Worktrunk marker behavior.

Delete this plan when all phases are complete.
