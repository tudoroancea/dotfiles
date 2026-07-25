# Pi Web UI — large-session and browser-quality plan

## Objective

Turn the existing session-scoped Preact companion into a browser UI that:

- matches Pi's HTML exporter closely in density, hierarchy, tool behavior, and transcript readability;
- exposes the complete active-branch history through bounded transport pages;
- remains responsive for very large sessions by virtualizing variable-height timeline rows;
- treats real Chromium behavior, layout, scrolling, authentication, and keyboard interactions as required release criteria through Playwright.

Pagination and virtualization are one atomic product milestone. Neither is considered complete or releasable without the other.

## Current baseline

The original implementation phases are substantially complete: session-scoped HTTP/WebSocket lifecycle, standalone authentication, reconnectable state, custom renderers, composer, Agentflow/background dashboards, completion, and security tests exist under this extension.

The remaining problems are architectural and experiential:

- persisted history is projected newest-first into a fixed budget and old entries are omitted;
- snapshots have an 8 MiB hard ceiling and cannot represent arbitrary sessions;
- the browser renders every received entry with a plain `.map()`, with no virtualizer;
- scroll-following is based on whole-container `scrollHeight` changes;
- native `<details>` expansion state is not durable across virtual unmounts;
- jsdom tests cannot catch overlap, measured layout, scroll anchoring, browser keyboard behavior, or responsive regressions;
- the first visual implementation diverged significantly from the exporter.

A temporary “full history” implementation that merely raises the snapshot projection budget is explicitly rejected. Complete history means every active-branch entry is retrievable in bounded pages while existing per-entry sanitization and payload limits remain in force.

## Authoritative references

### Local implementation and specifications

- `README.md`
- `src/shared/wire.ts`, `src/shared/limits.ts`
- `src/server/projection.ts`, `src/server/state.ts`, `src/server/server.ts`
- `src/web/session-store.ts`, `src/web/app.tsx`
- `src/web/components/Timeline.tsx`, `ToolCall.tsx`, `Composer.tsx`
- `test/`
- repository-root `WEB_UI_EXTENSION.md` and `ADDITIONAL_DETAILS.md`
- generated lifecycle authority `../herdr-agent-state.ts` (audit only; never edit)

### Pi exporter source of truth

Use the local Pi clone, not only installed compiled output:

- `~/dev/pi/packages/coding-agent/src/core/export-html/index.ts`
- `~/dev/pi/packages/coding-agent/src/core/export-html/template.html`
- `~/dev/pi/packages/coding-agent/src/core/export-html/template.css`
- `~/dev/pi/packages/coding-agent/src/core/export-html/template.js`
- `~/dev/pi/packages/coding-agent/src/core/export-html/tool-renderer.ts`
- `~/dev/pi/packages/coding-agent/src/core/export-html/ansi-to-html.ts`
- `~/dev/pi/packages/coding-agent/test/export-html-*.test.ts`
- `~/dev/pi/packages/coding-agent/test/theme-export.test.ts`
- `~/dev/pi/packages/coding-agent/src/modes/interactive/theme/theme.ts`

The exporter HTML/CSS/JS templates are copied as static build assets, so installed templates remain useful runtime references. The source TypeScript, tests, and theme code are authoritative for intent and edge cases. Compare the local clone revision, installed Pi 0.82 artifacts, and the supplied exported session rather than assuming they are identical.

## Architectural decisions

### History protocol

Move from the current protocol v6 to protocol v7 with explicit request-scoped history pages.

Freeze these server-selected bounds for the first implementation: 100 projected entries, a 512 KiB serialized page envelope, a 512-byte cursor, and one in-flight page request per client. Tune them only from measured browser/server results, never from client input.

The initial session snapshot contains a bounded newest window and history identity:

```ts
interface PersistedWindow {
  sessionId: string;
  leafId: string | null;
  historyGeneration: string;
  entries: PersistedEntry[]; // chronological
  hasOlder: boolean;
  olderCursor?: string;
}
```

Add the following `history_page` client command and correlated server response. The request contains the extension generation, history generation, and an opaque exclusive cursor. The server chooses fixed count and byte limits; the client cannot request an unbounded page.

```ts
interface HistoryPageCommand {
  type: "history_page";
  commandId: string;
  generation: string;
  historyGeneration: string;
  cursor: string;
}

interface HistoryPageMessage {
  type: "history_page";
  protocolVersion: 7;
  commandId: string;
  generation: string;
  historyGeneration: string;
  revision: number; // diagnostic sample, not a state revision
  entries: PersistedEntry[]; // chronological
  hasOlder: boolean;
  olderCursor?: string;
}
```

`PersistedState.entriesTruncated` is replaced by `historyGeneration`, `hasOlder`, and optional `olderCursor`. The server message union includes `history_page`; it is not a `StatePatch`.

Page responses are query results, not global state mutations:

- they do not change `SessionStateStore` revisions;
- they are sent only to the requesting authenticated client;
- they are not broadcast or coalesced as live state;
- only one older-page request is in flight per client;
- retries with the same valid cursor are idempotent;
- malformed, stale, or lineage-mismatched cursors trigger a bounded error/resnapshot path.

Use a per-generation cursor authority. A cursor identifies `historyGeneration`, an exclusive raw branch index, and the expected boundary entry ID. Encode and authenticate it opaquely with a per-runtime random key, then validate its exact byte bound, signature, lineage, index range, and boundary ID before projection. Cache an entry-ID/index map for page lookup rather than rescanning the branch for every request. Cursor reuse is idempotent.

`historyGeneration` remains stable across strict appends. Rotate it whenever the active lineage is not a strict append: session/tree navigation, compaction, changed ancestry, leaf replacement, or a failed append-boundary check. A rotation invalidates loaded pages atomically in the browser. Extension session replacement still rotates the existing top-level generation.

Keep individual entry/message/tool projection limits, redaction, image limits, and outbound queue limits. Build pages backwards under both a fixed entry count and a serialized-envelope byte budget, then return entries chronologically. A single oversized projected entry must produce an explicit bounded omission representation rather than violate the page limit.

### Browser history store

Separate rapidly changing live/core state from paged history so every streamed token does not rebuild a large array.

Maintain:

- bounded page chunks in chronological order;
- an entry-ID index for deduplication;
- chunk prefix counts or another indexed accessor for virtual rows;
- `hasOlder`, `olderCursor`, `loadingOlder`, and page error state;
- pending page requests correlated by command ID, generation, history generation, and cursor;
- a tool-call index built incrementally as older assistant entries arrive;
- controlled expansion state keyed by stable tool/entry IDs;
- a monotonic history version independent of live-state revisions.

A same-lineage tail snapshot merges/deduplicates without discarding loaded older chunks. A generation or history-generation change clears pages, stale requests, search results, and obsolete expansion state before installing the new tail.

### Virtualization

Use pinned `@tanstack/virtual-core` through a small extension-owned Preact hook. There is no first-party TanStack Virtual Preact adapter; do not route the React adapter through `preact/compat`.

Virtualize stable logical transcript rows, not individual Markdown blocks or diff lines. Persisted rows use `entry:${entry.id}`. Live rows use deterministic identities derived from the existing message identity/tool call ID (`live-message:…`, `live-tool:${toolCallId}`, and one `partial-assistant` tail row); they must not depend on array indexes. Requirements:

- variable-height measurement with `ResizeObserver`;
- conservative estimates and measured correction;
- 6–10 rows of overscan, tuned from browser measurements;
- persistent controlled tool expansion across unmount/remount;
- focused-row retention so keyboard focus is not destroyed by scrolling;
- no pinning of every expanded row, which would defeat virtualization;
- explicit cleanup of observers and virtualizer subscriptions.

Pagination and scrolling behavior:

- the initial snapshot opens at the latest row after measurement;
- a user within a measured bottom threshold follows live growth;
- a user who scrolls away is not moved and gets an accessible “Jump to latest” control with an unseen-update count;
- loading an older page captures the first visible stable row ID and pixel offset, prepends the page, and restores that row to the same offset;
- measurement changes above the anchor are compensated while the anchor lock is active;
- CSS browser anchoring is disabled on the virtual scroller so only one anchoring authority exists;
- a top sentinel may load one page at a time, but a visible keyboard-accessible load/retry control remains available.

### Search and accessibility

Virtualization makes native browser Find incomplete because unmounted rows are absent from the DOM. Preserve exporter-like complete-session discovery with app-level search:

- index bounded projected plain text as pages arrive;
- allow a complete-session search to fetch remaining pages sequentially through the same bounded protocol;
- make it cancellable, yield between pages, and report progress;
- scroll/mount/focus stable result rows for next/previous navigation.

Do not put `aria-live` on the entire virtual transcript. Use dedicated polite regions for connection changes, loaded-page counts, unseen live updates, and search progress. Keep load/search/tool/composer controls keyboard reachable with stable accessible names.

### Keyboard handling

Keep native Preact textarea handlers for the small composer shortcut set. Do not add alpha `@tanstack/preact-hotkeys` unless shortcut scope grows enough to justify centralized conflict handling.

Required behavior:

- Enter inserts a newline;
- Option/Alt+Enter submits when idle and steers when running;
- Ctrl+Enter queues/follow-up while running;
- Option/Alt+`.` aborts while running, detected with `event.code === "Period"` for layout resilience;
- autocomplete selection remains unambiguous;
- shortcuts are discoverable in the UI and tested in a real browser.

### Authentication and Tailscale

Do not weaken the existing single-use fragment-to-HttpOnly-cookie authentication. Tailscale Serve remains an explicitly configured reverse proxy; the extension does not launch or trust Tailscale identity headers. Playwright must exercise the real bootstrap exchange and cookie path rather than bypassing authentication.

## Implementation phases

### Phase 0 — reconcile and stabilize the exporter-parity pass (sequential, in progress)

- [x] Review the current partial diff against the local Pi exporter source, installed 0.82 assets, exported session HTML, and supplied screenshots.
- [x] Finish compact transcript/tool styling, session intro, composer metadata/shortcuts, bash expansion, and status/chevron fixes.
- [x] Remove the rejected raised-budget/full-history experiment.
- [x] Make all existing format, lint, typecheck, Vitest, and production-build checks pass.
- [x] Audit Herdr lifecycle behavior without editing the generated authority.

This phase must be stable before parallel large-session work starts.

### Phase 1 — Playwright foundation and protocol contract (short sequential gate)

- [x] Add pinned `@playwright/test`, `playwright.config.ts`, and `e2e/` outside Vitest discovery.
- [x] Build a worker fixture around the real `startWebUiServer()` with dynamic ports, real `dist/web`, controllable fake `ExtensionContext`, and generated branches.
- [x] Add the first Chromium smoke test: bootstrap fragment exchange, fragment removal, authenticated cookie, WebSocket readiness, and clean shutdown.
- [x] Define the new wire schemas, cursor invalidation rules, page count/byte limits, stable row IDs, and generated large-session fixtures.
- [x] Add a required `check` command that runs format check, lint, typecheck, Vitest, build, and Chromium Playwright. Browser installation must be explicit in CI.

The browser gate is established first so later phases cannot defer real-browser validation.

### Phase 2 — parallel foundations after the contract freezes

#### 2A. Server pagination workstream

Owned files:

- `src/shared/wire.ts`, `src/shared/limits.ts`
- `src/server/projection.ts`, `src/server/state.ts`, `src/server/server.ts`
- focused protocol/state/server tests

Tasks:

- [x] Implement bounded page projection and exact serialized-envelope accounting.
- [x] Implement opaque validated cursors and strict-append history-generation tracking.
- [x] Handle page requests without state revisions or broadcasts.
- [x] Reject stale/malformed/out-of-range requests safely.
- [x] Avoid repeated whole-branch work on hot reconciliation paths; cache append-derived session cost/index metadata and recompute on lineage rotation.
- [x] Test first/last pages, count and byte boundaries, escaped content, idempotence, appends, branch resets, compaction, concurrent clients, and slow-client limits.

#### 2B. Browser store and virtualizer workstream

Owned files:

- `src/web/session-store.ts` and new focused store modules
- a new extension-owned Preact virtualizer hook/module
- `ToolCall.tsx` controlled-expansion seam
- focused store/hook/component tests using frozen protocol fixtures

Tasks:

- [x] Implement chunked history storage, ID deduplication, indexed row access, and lineage reset.
- [x] Keep history snapshots stable across live token updates.
- [x] Implement the pinned `@tanstack/virtual-core` Preact adapter with variable-height measurement and cleanup.
- [x] Externalize tool expansion state and preserve focused rows.
- [x] Unit-test stale responses, duplicate pages, tail merges, reset races, measurement updates, and observer disposal.

#### 2C. Playwright scenario workstream

Owned files:

- `playwright.config.ts`
- `e2e/**`
- E2E fixture helpers only

Tasks:

- [x] Generate deterministic thousands-entry sessions with mixed Markdown, images, and tool heights.
- [x] Prepare browser assertions for bounded DOM row count, page completeness, anchoring, live-follow behavior, expansion persistence, and reset races.
- [ ] Add desktop/mobile exporter-parity screenshots with reduced motion and deterministic data.

This stream may author tests against the frozen contract while 2A/2B implement it. It must not weaken assertions merely to match an incomplete implementation.

### Phase 3 — pagination/virtualization integration (sequential shared-file phase)

Owned integration files:

- `src/web/app.tsx`
- `src/web/components/Timeline.tsx`
- timeline/virtualization CSS
- transport wiring

- [x] Connect initial tail snapshots and correlated older-page requests to the chunked store.
- [x] Render the virtual row model and live tail without flattening/rebuilding all history on every update.
- [x] Implement top loading, retry, prepend anchoring, initial latest positioning, bottom-follow threshold, unseen count, and jump-to-latest.
- [x] Preserve tool expansion and keyboard focus through virtual unmount/remount.
- [x] Rotate cleanly on extension/history generations and ignore stale page responses.
- [x] Remove the old “Earlier history is not shown” truncation state; represent only actionable loading/error/end-of-history states.

Pagination plus virtualization is complete only when integrated and passing large-session browser tests.

### Phase 3.5 — exporter-faithful client rendering (after Phase 3, before Phase 4)

Authoritative handoff: `RENDERING_HANDOFF.md`. Use the local Pi source under `~/dev/pi/packages/coding-agent/src/core/export-html/` as the behavioral and visual specification.

- [ ] Port exporter transcript typography, 12px/18px density, spacing, colors, message hierarchy, and disclosure behavior onto the virtualized Preact timeline without changing its paging/row architecture.
- [ ] Reproduce the exporter’s browser-rendered `bash`, `read`, `write`, `edit`, and `ls` presentations from `template.js` and `template.css` using safe semantic Preact nodes.
- [ ] Render terminal-like output as escaped `.ansi-line`/span components; add a bounded client-side ANSI parser only where actual ANSI parity requires it, never raw injected server HTML.
- [ ] Hand-port useful terminal presentations for other known tools while preserving focused Agentflow, background-job, and questionnaire renderers.
- [ ] Make the unknown-tool fallback compact, terminal-like, safe, and consistent.
- [ ] Preserve controlled expansion/focus across virtual unmounts and trigger correct row remeasurement on expansion and live output.
- [ ] Add exporter-source fixtures, component assertions, and deterministic Playwright parity screenshots while keeping large-session DOM, anchoring, paging, and live-follow checks green.

This phase is client-only. It must not import private Pi internals, invoke TUI renderers, serialize components, add server-rendered tool HTML, or replace the virtualized timeline.

### Phase 4 — complete-session search and accessibility (parallel after stable row APIs)

#### 4A. Search

- [ ] Add incremental plain-text indexing over loaded projected entries.
- [ ] Fetch remaining pages sequentially for complete-session search with cancellation/progress.
- [ ] Implement next/previous result navigation through virtual row mounting.

#### 4B. Accessibility and remaining exporter parity

- [ ] Replace transcript-wide live announcements with small status regions.
- [ ] Verify load/search/tool/composer keyboard order and focus retention.
- [ ] Compare density, typography, responsive dimensions, tool summaries, Markdown, code, diffs, and images against exporter source and deterministic screenshots.
- [ ] Verify dashboards remain usable and do not inherit transcript-only virtualization assumptions.

These workstreams can proceed in parallel because search owns its index/components while accessibility/parity owns semantics/styles, but changes to shared virtual-row APIs require coordination.

### Phase 5 — required browser gate and hardening

- [ ] Bootstrap authentication succeeds and strips the secret fragment.
- [ ] Multi-thousand-entry sessions render a bounded DOM and page to the first entry without gaps or duplicates.
- [ ] Prepending preserves the visible anchor within a small pixel tolerance.
- [ ] Live growth follows only at the bottom; jump-to-latest restores following.
- [ ] Expanded tool details survive virtual unmount/remount and dynamic resize.
- [ ] Stale page responses and lineage resets never mix branches.
- [ ] Complete-session search finds initially unloaded content.
- [ ] Composer shortcuts, autocomplete, steer/follow-up, abort, reconnect disabling, and feedback work through the real server.
- [ ] Desktop and phone viewports keep timeline controls and composer usable.
- [ ] Keyboard traversal retains focus and meaningful accessible names.
- [ ] CSP, unsafe content, payload limits, Origin checks, reconnects, lifecycle cleanup, RPC stdout cleanliness, and Herdr behavior remain intact.
- [ ] `nub run check` is green and Playwright is mandatory, not optional or skipped.

## Parallel execution rules

Safe parallelism begins only after Phase 1 freezes protocol names, reset semantics, fixture shapes, and stable row IDs.

- Phase 2A owns server/protocol production files.
- Phase 2B owns browser store/virtualizer production files.
- Phase 2C owns only Playwright/config/fixture files.
- No parallel edits to `app.tsx`, `Timeline.tsx`, or shared timeline CSS during Phase 3.
- Integrate and verify Phase 2 before starting search/accessibility polish.
- Review the stable integrated diff after each major phase; do not ask reviewers to reason over concurrent partial states.

## Acceptance criteria

- Every active-branch entry is reachable through bounded authenticated pages regardless of total session size.
- No snapshot or page exceeds fixed server byte/count limits, and no client can request an unbounded payload.
- The transcript DOM remains bounded while scrolling through very large, variable-height sessions.
- Older-page loading and live updates do not cause visible scroll jumps or steal position from a reader.
- Branch/session generation changes cannot mix stale and current history.
- Tool expansion, focus, keyboard control, and complete-session search remain functional under virtualization.
- The transcript and composer closely follow the local Pi exporter source and supplied references rather than a separately invented design.
- Chromium Playwright tests exercise the real built app, real HTTP/WebSocket server, and real bootstrap authentication and are a required release gate.
- Existing TUI/RPC lifecycle, security, dashboards, output cleanliness, and Herdr semantics do not regress.
