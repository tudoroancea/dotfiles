# Standalone and cross-extension maintenance plan

## Scope

This plan owns standalone extensions, shared session-cost accounting, and TUI ownership checks. Background runtime maintenance belongs to `background-processes/PLAN.md`.

The Web UI, shared browser client, remote-session daemon, Agentflow runtime, Worktrunk statusline, and Herdr integration are retired. Their implementation plans and integration requirements no longer apply.

## Retained profile

- `automatic-session-name.ts` owns session naming independently of Agentflow. It names persisted, unnamed sessions after the first completed exchange on `agent_settled`, preserves manual names, and cancels stale requests on session transitions and shutdown.
- `notify.ts` handles terminal-focus tracking, `questionnaire` notifications, completion notifications, and optional Raycast confetti only in TUI mode. It no longer detects or suppresses Agentflow children.
- Background processes, FFF, questionnaire, and their owner-local renderers remain supported.
- `boxed-editor/index.ts`, `builtin-tool-renderers.ts`, and `custom-header.ts` remain in the repository but are disabled by `agent/settings.json`. Pi owns the active editor, footer, header, and built-in tool presentation. Disabled code is not retired code.
- `tests/resource-profile.test.ts` checks the enabled and disabled extension profile. `TUI_RENDERING.md` records the retained renderer contract.

## Canonical session-cost accounting

Session cost means recorded provider spend in the supplied top-level entries, not the cost of the current LLM context.

- `agent/extensions/lib/session-cost.ts` owns host-neutral accounting. Formatting remains with each consumer.
- The retained, disabled boxed-editor consumer selects the whole session tree with `getEntries()`.
- `/session-breakdown` reads every top-level entry in each historical JSONL file.
- Assistant and tool-result usage, compaction usage, and branch-summary usage count from their top-level records. Nested snapshots and retained transcript tails do not count recursively.
- Historical Agentflow cost, result, and tool representations remain supported. Non-empty `agentflow:` cost IDs deduplicate by the greatest recorded value.
- Historical aggregation suppresses propagated child cost when the included persisted child session already represents it. Cost for unavailable or in-memory children remains counted.
- Historical parsing retains legacy numeric-string costs. Removing the Agentflow runtime does not authorize removing this compatibility.

Completed work:

- [x] Extract canonical entry accounting and define consumer scopes.
- [x] Cover duplicate Agentflow cost IDs, tool results, compactions, summaries, missing usage, and malformed details.
- [x] Retain cross-file and persisted-child deduplication tests after runtime retirement.

## Deferred notification maintenance

- [ ] Verify whether Pi 1.0 already owns terminal focus reporting and whether the raw stdin listener or `?1004` writes interfere with input or lifecycle.
- [x] Add focused tests for focused and unfocused completion, questionnaire notifications, OSC sanitization, confetti gating, shutdown cleanup, and listener balancing.
- [x] Verify in lifecycle tests that session restart resets focus state without retaining a timer or listener.

Exit criteria:

- notifications have explicit event sources and tested focus gating;
- no raw listener or terminal mode survives shutdown;
- RPC, print, and JSON modes produce no terminal notifications or focus-reporting writes.

## Ongoing ownership checks

- [x] Cover standalone naming, manual-name preservation, persisted attempt guards, failed generation, cancellation, and stale-session results with 46 deterministic tests.
- [ ] Keep the resource-profile test aligned with intentional enablement changes. Re-enabling a presentation extension requires an explicit editor, footer, header, or built-in renderer ownership decision.
- [ ] Preserve historical Agentflow accounting fixtures when changing session parsing.

## Test and deployment ownership

- [x] Move standalone extension tests into `agent/extensions/test/` and shared helper tests into `agent/extensions/lib/test/`.
- [x] Keep cross-owner goldens and resource-loading checks in `tests/`, with one root test runner and no duplicate package runs.
- [x] Replace whole-tree deployment with resource-specific links. Keep dependencies in the source workspace and private state in the deployed agent directory.
- [x] Cover both source and directory-linked resource discovery, including exclusion of test files from extension loading.

## Verification

Run focused tests for each affected extension, then run from `agents/pi`:

```sh
nub run check
```

Perform a TUI smoke covering Pi's editor, footer, and header, retained tool renderers, session naming, questionnaire notifications, completion notifications, and reload cleanup. Check RPC, print, and JSON mode guards separately.
