# Unified Pi activity UI revamp

## Decisions and priorities

This plan covers the local Boxed Editor, Agentflow, and Background Processes extensions. Worktrunk is out of scope and may be ignored.

The design priorities, in order, are:

1. **Reliable, minimal persistent chrome** that works with the custom input box.
2. **The right information in snapshots and expanded tool rendering.**
3. **Information-first dashboards that are useful even before any live preview exists.**
4. **Consistent actions and navigation, without duplicate menus or commands.**
5. **Live refresh and live output preview only after the static information architecture is complete.**

The most important dashboard information is:

- For every running item: **elapsed running time**.
- For subagents: **initial prompt**, then **token usage and cost**, then output and tool calls.
- For background processes: **cwd and command**, then state/runtime information, then output.

The same priority applies to expanded tool rendering with `app.tools.expand` (normally Ctrl-O):

- expanded subagent calls show the initial prompt, elapsed time, tokens/cost, tool calls, and output;
- expanded background-process calls show cwd and command first, then elapsed/status and output metadata or preview.

## Current problems

- `.pi/agent/extensions/boxed-editor.ts` installs an empty custom footer, so Agentflow's keyed `setStatus("agentflow", ...)` is published but invisible.
- Agentflow and Background Processes use different passive surfaces: Agentflow uses an invisible footer status while Background Processes uses a multi-line widget above the editor.
- Both dashboards use nested selector/action/editor flows. Information is fragmented across menus, manual refresh actions, and editor dialogs.
- Agentflow snapshots retain labels, usage, tool calls, and output previews, but `NodeSnapshot` does **not** retain the initial task prompt or effective cwd. The dashboard therefore cannot display the most important task identity from its read model.
- Agentflow expanded semantic results show tool calls and output previews but not the initial prompt. The raw agent renderer shows a short prompt in the call header, but does not provide a coherent expanded information hierarchy.
- Background job records already retain `cwd`, `command`, timestamps, status, output metadata, and artifacts, but the current dashboard makes users enter separate action menus to see them.

## Information architecture

Each piece of information should have one primary home.

| Surface | Purpose | Information | Actions |
|---|---|---|---|
| Boxed editor border | Parent-session context | context usage, session cost, model, thinking level, cwd | normal editor actions |
| Activity footer | Awareness and discovery | active Agentflow count/progress; active process count; unresolved warning count; dashboard command hints | none |
| Dashboard list | Compare and choose work | identity, elapsed time, primary task/process description, state, key metrics | select, inspect, cancel/stop |
| Dashboard detail | Inspect one item | complete prompt or cwd+command, timing, tokens/cost where applicable, tool calls, output/result, artifacts/errors | scroll, cancel/stop, back |
| Collapsed tool/result row | Compact transcript history | identity, state, concise metrics | expand only |
| Expanded tool/result row | In-context inspection | the same ordered detail model as the dashboard, bounded for transcript use | collapse only |
| Agent-facing tools | Model control plane | structured status/wait/stop/cancel operations | model-only |

Rules:

- Do not show model/context/cwd from the parent session in the activity footer; those already belong to the editor border.
- Do not list individual prompts or commands in the passive footer.
- Do not create separate Overview, Command, Tail, Result, Artifacts, and Refresh action menus. A single detail view presents the relevant information in priority order.
- Do not add a full subagent takeover input.
- Keep Agentflow steering available in the backend and model-facing tool API, but omit it completely from the UI: no steering input, button, menu item, shortcut, status hint, or dashboard action.
- Do not add a manual Refresh action once a dashboard supports subscriptions.
- User cancellation/stopping happens in the relevant dashboard with `x` and confirmation. Model cancellation/stopping remains in tools. Avoid additional user-facing stop/tail commands in the redesigned interaction.

## Visual direction

The boxed editor remains the sole persistent chrome:

```text
╭─ 42% of 200k · $1.18 ───────────── (openai) model · medium ─╮
│ Ask the parent agent…                                        │
╰────────────────────────────────────────────── ~/project ─────╯
  ◆ /agentflow 2 · 3/5 tasks   ■ /background-tasks 1
```

The activity footer is intentionally terse. Elapsed time, prompts, commands, cwd, tokens, and costs belong in dashboards and expanded rows where there is enough space.

Use one status vocabulary throughout:

- `·` queued;
- `◆` active Agentflow run/task;
- `■` active background process/event stream;
- `✓` completed;
- `✗` failed;
- `◇` aborted, cancelled, timed out, or killed.

Use theme roles: accent/warning for active, success for completed, error for failure, muted for cancelled/killed, and dim for metadata.

## Dashboard specifications

### Agentflow list

Rows are optimized for identifying the task and its resource use:

```text
❯ ◆ review  Inspect auth boundary regressions…   1m42s   18.4k tok   $0.21
  ✓ finder  Locate cache invalidation paths…       38s    6.1k tok   $0.04
```

Required row information, in order of importance:

1. selection and status;
2. semantic role/run label;
3. bounded single-line initial prompt;
4. elapsed time;
5. total tokens;
6. cost;
7. completed/total task count for multi-node workflows when space permits.

The run ID, origin tool, artifact marker, and lower-priority metadata may appear only at wider widths or in the detail view. Prompt text must be preserved ahead of IDs when the terminal is narrow.

### Agentflow detail

The read-only detail view uses one fixed hierarchy rather than action submenus:

```text
◆ review · running · 1m42s · 18.4k tokens · $0.21

Prompt
Inspect the authentication boundary for regressions introduced by…

Tool calls
✓ read       .pi/agent/extensions/…
◆ ffgrep     validateToken

Output
Current bounded result/output preview…

Artifacts
/path/to/run/artifacts
```

Order:

1. status, elapsed time, tokens, and cost;
2. complete bounded initial prompt;
3. task/node summaries for workflows;
4. tool-call timeline with arguments/results on expanded detail;
5. output/result preview;
6. errors, session path, and artifacts.

There is no child input. `x` cancels an active run after confirmation. Escape returns to the list.

### Background Processes list

Rows prioritize where and what is running:

```text
❯ ■ ~/project/api   bun test --watch                    4m12s
  ✓ ~/project/web   nub run build                         52s
```

Required row information, in order:

1. selection and status;
2. cwd, shortened relative to home where appropriate;
3. bounded single-line command;
4. elapsed time;
5. process kind and delivery warning only when space permits.

Description, job ID, output size, PID, and artifact indicators are secondary. A user should not have to open a job just to learn its cwd or command.

### Background Process detail

The detail view also avoids action submenus:

```text
■ running · 4m12s · background command
~/project/api
$ bun test --watch

Output
…bounded tail…

output: /path/to/output.log
metadata: /path/to/metadata.json
```

Order:

1. status, elapsed time, and kind;
2. cwd;
3. complete bounded command;
4. terminal cause/exit status when settled;
5. output tail;
6. delivery/event-stream health;
7. output and metadata artifact paths.

Output is useful but subordinate to cwd and command. The local runtime's existing combined output stream is sufficient; do not add stdout/stderr splitting solely for this UI.

`x` stops an active job after confirmation. Escape returns to the list.

## Expanded tool rendering

Dashboard and expanded tool rows must use the same formatting helpers and ordering so they do not drift into separate interfaces.

### Agentflow

- Add bounded `prompt` and effective `cwd` fields to `NodeSnapshot`; the prompt is required for dashboards and expanded result rendering.
- Preserve the initial user/task prompt, not the child system prompt.
- Derive elapsed time from `startedAt`/`completedAt` and render it consistently.
- For raw `agentflow_agent`, collapsed rendering keeps the prompt/status/metrics and recent tool-call previews; expanded rendering shows the full bounded prompt, timing, tokens/cost, tool calls, output, and artifacts.
- For semantic tools, normalize `task`, `question`, `objective`, review scope, and similar role-specific inputs into the stored initial task prompt. Expanded rendering must not depend only on transient tool arguments because dashboard recovery also needs the prompt.
- Keep role-specific summaries such as findings/sources/files changed in collapsed results.

### Background Processes

- Use the render context cwd during the pending call and persisted job cwd after launch.
- Collapsed launch rows show a bounded command/description and concise state.
- Expanded launch/status/result rows show cwd and command first, followed by elapsed/status, monitor/delivery metadata, and output preview/artifact path.
- Reuse the same command, cwd, duration, and status formatters as the dashboard.

All expanded output remains bounded; complete output stays in artifacts.

## Interaction contract

Both dashboards use the same controls:

- configured up/down plus optional `j`/`k`: move selection or scroll;
- configured confirm: inspect selected item;
- `x`: cancel/stop selected active item, with confirmation;
- configured cancel/Escape: back or close;
- page-up/page-down and `g`/`G`: detail scrolling when needed.

Selection is retained by stable run/job ID. Destructive actions resolve a fresh snapshot immediately before acting. Key hints use injected keybindings rather than hard-coded `enter`, `escape`, or `ctrl+o` strings.

## Implementation phases

Every phase must leave a coherent UI. A phase may replace a surface, but must not temporarily add a second competing surface or a second way to perform the same user action.

### Phase 1 — Repair persistent chrome

- [x] Add focused tests for boxed editor/footer composition at 40, 80, and 120 columns.
- [x] Change the boxed footer from an empty renderer to a compact compositor for `footerData.getExtensionStatuses()`.
- [x] Keep parent model, thinking, context, cost, and cwd exclusively in the editor border.
- [x] Make `boxed-editor.ts` the only enabled owner of `setFooter()` and `setFooter(undefined)`.
- [x] Ignore Worktrunk and leave its configuration untouched.

Acceptance:

- Agentflow keyed status is visible with Boxed Editor enabled.
- Multiple statuses fit predictably or truncate as a single activity line.
- There is no duplicate parent-session metadata.
- Reload/shutdown leaves no stale footer resources.

### Phase 2 — Establish shared information models and expanded renderers

This phase comes before dashboard redesign or live preview.

Agentflow:

- [x] Extend persisted node snapshots with the bounded initial task prompt and effective cwd.
- [x] Ensure recovery, artifact checkpoints, and workflow nodes retain those fields.
- [x] Add shared elapsed-time, token, cost, prompt, status, and tool-call formatting helpers.
- [x] Redesign raw and semantic expanded renderers around: prompt → time/tokens/cost → tool calls → output → artifacts.
- [x] Keep collapsed semantic summaries concise and role-aware.

Background Processes:

- [x] Add shared cwd shortening, command sanitization, duration, status, and job-detail formatting helpers.
- [x] Redesign expanded tool results around: cwd → command → elapsed/status → output/delivery/artifacts.
- [x] Keep collapsed tool rows concise.

Acceptance:

- Ctrl-O exposes the required prompt or cwd+command without opening a dashboard.
- Dashboard and tool-renderer formatters have one source of truth per extension.
- Snapshots recovered from disk contain enough information to render the same identity after reload.
- No live subscriptions or preview panes are required for this phase to be useful.

### Phase 3 — Unify passive activity

Agentflow and Background Processes can be implemented in parallel.

Agentflow:

- [x] Publish only aggregate active-run/task progress, titled by `/agentflow`, through `setStatus("agentflow", ...)`.
- [x] Do not put prompts, tokens, costs, elapsed times, or run IDs in the passive footer.

Background Processes:

- [x] Replace the multi-line widget with `setStatus("background-processes", ...)`.
- [x] Show `/background-tasks` as the section title, followed by active count and unresolved warning count when needed.
- [x] Remove widget timers and widget lifecycle tests.

Acceptance:

- Both domains occupy one line below the boxed editor.
- No routine activity widget remains above the editor.
- Statuses clear when no longer relevant and on all shutdown paths.

### Phase 4 — Replace nested dashboards with information-first static views

This phase deliberately precedes live preview. Each old nested dashboard is replaced atomically rather than retained alongside the new view.

Agentflow:

- [x] Implement the specified run list using initial prompt, elapsed time, tokens, and cost.
- [x] Implement the single read-only detail hierarchy using the shared Phase 2 formatters.
- [x] Enclose Agentflow list and detail dashboards in a visible border so overlays remain distinct from the transcript.
- [x] Add direct `x` cancellation and remove cancel/steer/refresh action menus from the dashboard UI.
- [x] Remove redundant user-facing `/agentflow-status` and `/agentflow-steer` commands; `/agentflow` owns status inspection and dashboard actions.
- [x] Keep steering backend/tool support unchanged, but expose no steering affordance anywhere in the dashboard or persistent chrome.
- [x] Do not add a takeover input.

Background Processes:

- [x] Implement the specified job list using cwd, command, and elapsed time.
- [x] Implement the single read-only detail hierarchy using the shared Phase 2 formatters.
- [x] Add direct `x` stop and remove Overview/Command/Tail/Artifacts/Refresh action menus.
- [x] Review and remove redundant user-facing `/background-stop` and `/background-tail` commands once the dashboard replacements cover those actions; retain model-facing tools.

Acceptance:

- The dashboards are already complete and useful from ordinary snapshot reads.
- The most important information is visible in list rows without opening detail.
- One detail view replaces multiple action/editor dialogs.
- User actions have one primary location; model actions remain tools.
- Manual refresh may temporarily occur when reopening the dashboard, but there is no visible Refresh menu item.

### Phase 5 — Add live freshness, not new information

Only after Phase 4 is accepted:

Agentflow:

- [x] Expose list/get/global and per-run subscriptions over `RunEngine` events.
- [x] Refresh elapsed time at 1 Hz and update tokens, cost, tool calls, and output as snapshots change.

Background Processes:

- [x] Add list/get/global and per-job subscriptions over `ProcessRuntime` change notifications.
- [x] Refresh elapsed time at 1 Hz.
- [x] Add a fixed-height live tail to the existing output section; do not change the detail hierarchy.

Both:

- [x] Retain selection by stable ID.
- [x] Coalesce chatty output/tool updates to approximately 50 ms.
- [x] Cache sanitized wrapped output by version and width.
- [x] Keep viewport height stable while content changes.
- [x] Dispose subscriptions, intervals, and repaint timers idempotently.

Acceptance:

- Live behavior enhances the Phase 4 views rather than introducing another UI.
- Elapsed time is visibly current.
- Agentflow tokens and cost update while running.
- Chatty output cannot starve keyboard handling or resize the overlay.

### Phase 6 — Result cards and integration hardening

- [x] Align asynchronous Agentflow result cards with the same prompt/metrics/tool/output hierarchy when expanded.
- [x] Align background completion/event cards with the same cwd/command/status hierarchy when expanded.
- [x] Use configured `app.tools.expand` hints everywhere.
- [x] Test simultaneous Agentflow and Background Processes activity with Boxed Editor.
- [x] Test narrow/wide resizing, theme invalidation, reload, new/resume/fork, shutdown, cancellation/stop races, recovered snapshots, and delivery failures.
- [x] Add a repository guard that only Boxed Editor owns the footer.
- [x] Run typecheck, tests, lint, format checks, and smoke coverage for both packages.

Acceptance:

- Passive footer, dashboard lists, detail views, and expanded transcript rows use the same vocabulary and ordering.
- No information has multiple competing primary homes.
- No stale footer, widget, status, subscription, or timer survives teardown.

## Verification commands

```bash
cd .pi/agent/extensions/agentflow
nub run typecheck
nub run test
nub run lint
nub run format:check
nub run smoke
nub run smoke:config

cd ../background-processes
nub run typecheck
nub run test
nub run lint
nub run format:check
nub run smoke
```

Focused manual verification:

1. Start Pi with Boxed Editor, Agentflow, and Background Processes enabled.
2. Launch one Agentflow task and one background process from a non-root cwd.
3. Confirm the footer shows only aggregate activity.
4. Confirm the Agentflow list prioritizes prompt, elapsed time, tokens, and cost.
5. Confirm the process list prioritizes cwd, command, and elapsed time.
6. Expand their tool rows with the configured expand binding and compare ordering with dashboard detail.
7. Cancel/stop from the dashboards and verify confirmation and settlement.
8. Only after Phase 5, verify live elapsed time, token/cost updates, tool-call updates, and process tail behavior.
9. Resize across narrow and wide widths and run `/reload` to detect stale UI resources.

## Cross-dependencies and non-goals

- Phase 1 is required before keyed passive statuses can be trusted.
- Phase 2 is required before dashboards so prompt/cwd/command/timing information does not get reformatted independently in multiple places.
- Agentflow and Background Processes work can proceed in parallel within Phases 2–5.
- Phase 5 must not begin until the information-first Phase 4 dashboards are accepted.

Non-goals:

- Worktrunk integration;
- full subagent takeover or child chat input;
- any user-facing subagent steering UI; backend and model-tool steering remain available;
- Codex/Claude backend changes;
- interactive process stdin or PTY emulation;
- stdout/stderr splitting solely for presentation;
- scheduler, persistence, artifact, delivery, or process-lifecycle redesign beyond adding snapshot fields/subscriptions needed by the UI;
- a unified `/activity` dashboard;
- a new workspace package solely for small UI helpers.
