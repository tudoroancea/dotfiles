# Local Pi Web UI Extension Plan

## Objective

Build a session-scoped web companion for the currently running Pi process, following `WEB_UI_EXTENSION.md`, with the first rendering milestone focused on this dotfiles repository's actual tool set and later milestones adding native web dashboards for Agentflow and background processes.

The extension must remain compatible with the custom Pi 0.82 setup, TUI and RPC modes, `/reload` and session replacement, and the generated Herdr lifecycle authority. It must not turn Pi into a global daemon.

## Sources and constraints

- `WEB_UI_EXTENSION.md`: target behavior, lifecycle, protocol, security, and reconnection model.
- `ADDITIONAL_DETAILS.md`: future daemon boundary, base-path/proxy compatibility, centralized runtime configuration, and authentication seams that this session-scoped extension must preserve.
- Pi extension docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
- Pi RPC docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.
- Pi session format: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`.
- Pi TUI API: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`.
- Custom compact built-ins: `.pi/agent/extensions/compact-builtin-tools.ts`.
- Questionnaire tool: `.pi/agent/extensions/questionnaire.ts`.
- Agentflow tools, snapshots, event emission, and dashboard: `.pi/agent/extensions/agentflow/src/`.
- Background tools, serialized job snapshots, runtime subscriptions, and dashboard: `.pi/agent/extensions/background-processes/src/`.
- Custom input chrome and metadata behavior: `.pi/agent/extensions/boxed-editor.ts` and the supplied `Screenshot 2026-07-24 at 18.27.35.png` reference.
- Installed FFF completion behavior: `~/.pi/agent/npm/node_modules/@ff-labs/pi-fff/src/index.ts` (currently 0.10.1), especially its FFF `mixedSearch`, 20-result cap, frecency/git-aware ordering, `@` prefix parsing, quoted-path insertion, and completion replacement semantics.
- Installed Pi settings: `.pi/agent/settings.json` (Pi 0.82, Node-compatible local setup, `nub` package management).

Important architectural constraint: `pi.getAllTools()` exposes tool metadata but not `renderCall` or `renderResult`. A web extension cannot generically reuse arbitrary TUI renderers. TUI components also produce terminal lines and ANSI styling rather than semantic browser markup. Initial parity therefore means matching the information hierarchy and collapsed/expanded behavior with explicit web renderers for the locally enabled tools, backed by fixtures from their TUI renderers. Unknown tools retain a safe generic renderer.

## Pinned technology stack

### Runtime and package layout

- Language: TypeScript in strict mode.
- Runtime: the same Node.js process as Pi; no subprocess and no separate backend service.
- Package manager/script runner: `nub`, matching this repository's JavaScript/TypeScript policy and current extension setup.
- Pi extension location: `.pi/agent/extensions/web-ui/` as a multi-file local package with `src/index.ts` declared in `package.json#pi.extensions`.
- Pi version contract: peer/dev dependency on `@earendil-works/pi-coding-agent` 0.82.x and matching Pi packages where types are needed.

### Backend

- HTTP: Node built-in `node:http`.
- WebSocket: `ws` as the only server framework dependency.
- Protocol schemas and runtime boundary validation: `typebox`, shared between server and browser DTO definitions where practical.
- Authentication, origin checks, cookies, CSP, static serving, limits, and routing: small extension-owned modules using Node APIs; no Express, Fastify, Hono, or middleware stack.
- Logging: stderr or an extension-owned file only; never stdout in RPC mode. No logging framework.
- URL discovery: after the server begins listening, show one initial non-LLM startup announcement before normal conversation content with the canonical access URL and a `/copy-remote-url` hint. Use the configured remote URL when available and otherwise the loopback URL; never invent a remotely reachable address.
- URL copying: register `/copy-remote-url` with the description “Copy Remote URL” and use Pi's exported `copyToClipboard()` utility, followed by concise success/error feedback. The copied URL must be directly usable rather than requiring the user to copy credentials separately.
- Authentication handoff: place a short-lived, single-use bootstrap credential in the copied URL fragment rather than its query string. The browser exchanges it for the per-run authenticated session and immediately removes the fragment from the address bar/history entry. Never include credentials in the ordinary diagnostic URL written to logs or stderr.
- State: extension-owned in-memory snapshot/event reducer with monotonic revision and generation; no database or cache.

Rationale: the server has only static GETs, a health/snapshot endpoint, and one WebSocket upgrade path. A backend framework would add more surface than behavior.

### Frontend

- UI framework: Preact.
- Build tool: Vite with `@preact/preset-vite`.
- React migration discipline: use React-compatible function components, hooks, refs, context, and JSX only; avoid Preact-only signals and component APIs. Keep framework imports behind normal component/store modules so migration is primarily dependency/import, Vite plugin, JSX runtime, and test-renderer replacement.
- State: a plain TypeScript external store plus Preact hooks/`useSyncExternalStore`; no Redux, Zustand, TanStack Query, TanStack DB, or signals library initially.
- Routing: none initially; dashboard/timeline selection is application state rather than URL routing.
- Markdown: `marked` followed by `dompurify`; embedded HTML is disabled/escaped before sanitization, URL schemes are allow-listed, and no unsanitized HTML reaches the DOM.
- Syntax highlighting: `highlight.js/lib/core` with only a small explicit language set used by common repository files. Plain text remains the fallback.
- Diff rendering: extension-owned line classifier over the existing unified patch/diff strings; no diff editor or diff library initially.
- ANSI: do not render trusted ANSI as HTML in the first implementation. Strip/control-sanitize tool output and render semantic statuses with CSS. Add a vendored ANSI converter only if a later server-side TUI compatibility adapter proves necessary.
- Icons: inline local SVG or text symbols; no icon package.
- Input: native responsive `<textarea>`; no CodeMirror/Monaco. Wrap it in a purpose-built composer that reproduces the local boxed editor's information hierarchy and chrome.

### Composer design reference

- Use a thin muted semantic border with rounded terminal-style corners and metadata visually inset into the border.
- Top-left metadata: context usage and session cost.
- Top-right metadata: provider/model and thinking level, with thinking-level semantic color.
- Bottom-right metadata: shortened cwd.
- Preserve multiline monospace input, visible keyboard focus/caret, modest internal padding, and compact vertical chrome.
- On narrow screens, prevent metadata collisions by moving the model/thinking and cwd labels into a compact secondary row; truncate paths/model names before shrinking the editor text below a comfortable touch/mobile size.
- The composer remains sticky near the viewport bottom, accounts for mobile safe-area insets and virtual keyboards, and exposes large-enough touch targets for send/abort and steer/follow-up selection.
- The web component should match the structure and behavior of `.pi/agent/extensions/boxed-editor.ts`, not imitate terminal ANSI or hard-code screenshot pixels.

### Styling

- Plain authored CSS with CSS custom properties corresponding to Pi theme roles.
- A small stable class naming convention; no Tailwind, CSS-in-JS, component kit, Sass, PostCSS plugin stack, or CSS Modules initially.
- Default palette follows the active Rosé Pine dark/light intent where public theme values cannot be safely resolved, while preserving semantic token names so theme synchronization can be added later.
- Mobile-first responsive layout using CSS grid/flex and native details/controls where suitable.

### Build and asset delivery

- Vite builds and minifies only browser assets, using its default production minifier.
- Browser output is emitted to `dist/web/` with hashed JS/CSS assets and a small `index.html`.
- The extension backend is not bundled: Pi/jiti loads `src/index.ts` directly, preserving extension conventions and useful stack traces.
- Static assets are served from the resolved package directory. Do not embed the bundle into TypeScript or a single HTML string.
- Production responses use a strict CSP and no inline scripts or inline event handlers.
- Development uses a Vite dev server only behind an explicit local development option; production never depends on Vite.

### Tests and quality tooling

- Vitest for protocol, reducers, lifecycle, render fixtures, and security cases.
- `@testing-library/preact` plus `jsdom` for component behavior.
- Direct `ws` clients for transport/lifecycle tests.
- Oxlint and Oxfmt, matching repository policy.
- No Playwright in the first dependency set; add a browser smoke suite only after the transport and renderer fixtures stabilize.

## Integration design for custom Pi functionality

### Tool renderer registry

Create a browser-side registry keyed by tool name. Each adapter receives a normalized tool-call view model containing arguments, partial/final content, details, status, error state, and expanded state.

First parity set:

1. Compact built-ins: `bash`, `edit`, and `write`, matching `.pi/agent/extensions/compact-builtin-tools.ts` rather than stock exporter behavior.
2. Remaining built-ins: `read`, `grep`, `find`, and `ls`.
3. Agentflow: `agentflow_finder`, `agentflow_oracle`, `agentflow_librarian`, `agentflow_look_at`, `agentflow_delegate`, `agentflow_review`, `agentflow_claude`, `agentflow_workflow`, `agentflow_status`, `agentflow_wait`, `agentflow_cancel`, and `agentflow_steer`; include raw `agentflow_agent` if enabled.
4. Background: `background_run`, `background_event_stream`, `background_status`, `background_wait`, and `background_stop`.
5. `questionnaire` final call/result rendering. Interactive browser questionnaire answering is a separate later feature.
6. Generic fallback: name, formatted arguments, accumulated text/images, error, and expandable JSON details.

Parity is verified with shared JSON fixtures and assertions about labels, status, counts, previews, expanded detail, truncation, and error presentation. Pixel or ANSI parity is not a goal.

### Dashboard provider bridge

Add a small in-process capability protocol over `pi.events` rather than importing private extension runtime instances into the web extension.

- The web extension listens for provider registration and emits a discovery request during `session_start`, after all extension factories have registered listeners.
- Agentflow registers a provider backed by `RunEngine.getSnapshot()`, `subscribe()`, `cancel()`, and `steer()` with deliberately projected web DTOs.
- Background processes registers a provider backed by runtime list/job subscriptions, `compactSnapshot`/bounded tail projections, and stop actions.
- Providers return serializable snapshots and unsubscribe functions; raw runtime objects, abort controllers, session managers, credentials, and arbitrary filesystem access are never exposed to the browser.
- WebSocket dashboard commands pass through the same authentication, validation, size limits, and generation checks as prompt commands.
- Autonomous dashboards and subscriptions are not Herdr-blocked scopes. Any future browser confirmation or approval that Pi awaits must use balanced `herdr:blocked` active/inactive events in `finally` and must be audited in TUI and RPC behavior.

## Implementation phases

### Phase 0 — package skeleton and fixture inventory (sequential prerequisite)

- [x] Create `.pi/agent/extensions/web-ui/` package, strict TypeScript configs, Vite browser entry, lint/format/test scripts, and ignored generated assets.
- [x] Pin dependencies and lock them with `nub`.
- [x] Capture representative persisted and live fixtures for built-ins, all enabled Agentflow tools, all background tools, questionnaire, custom messages, images, partial updates, errors, and parallel tool calls.
- [x] Define explicit output/payload limits before accepting remote input.

### Phase 1 — lifecycle and transport spike (sequential prerequisite)

- [x] Start Node HTTP/`ws` resources only from `session_start` in TUI/RPC modes.
- [x] Implement idempotent shutdown for `/reload`, session replacement, and process shutdown.
- [x] Serve built assets, health metadata, and a minimal authenticated WebSocket.
- [x] Generate per-run credentials, bind to loopback by default, validate Origin, and avoid query-string secrets.
- [x] Once listening, insert one initial non-LLM startup announcement before normal conversation content showing the canonical access URL and `/copy-remote-url`; do not persist stale per-run URLs into LLM context.
- [x] Register `/copy-remote-url` (“Copy Remote URL”) to copy a directly usable authenticated link through Pi's `copyToClipboard()`, with success/error feedback and tests for unavailable clipboard integration.
- [x] Exchange the link's short-lived single-use fragment credential for the per-run browser authentication state, then strip the fragment immediately.
- [x] Send prompt, explicit steer/follow-up, abort, ping, snapshot request, and command acceptance/error responses.
- [x] In RPC mode, write only the non-secret diagnostic URL to stderr and never emit startup announcements or URLs on stdout; define no-output behavior for print/JSON modes.
- [x] Verify RPC stdout remains clean and TUI responsiveness is unaffected.

### Phase 2 — versioned session protocol and state (depends on Phase 1)

- [x] Define extension-owned TypeBox wire schemas and inferred TypeScript DTOs.
- [x] Implement generation/revision sequencing and command IDs.
- [x] Keep persisted branch entries separate from partial assistant and running-tool state.
- [x] Treat tool updates as accumulated replacement state, correlated by `toolCallId`.
- [x] Reconcile from `SessionManager` at `agent_settled` and on reconnect/missed revision.
- [x] Add bounded outbound queues, update coalescing, client caps, and slow-client disconnects.

### Phase 3 — custom-tool-first web rendering (can run in parallel with late Phase 2 using fixtures)

- [ ] Implement timeline shell and generic safe renderer.
- [ ] Match compact `bash`, `edit`, and `write` information behavior first.
- [ ] Add Agentflow tool adapters and semantic snapshot presentation.
- [ ] Add background tool adapters and job status/detail presentation.
- [ ] Add questionnaire result rendering.
- [ ] Add remaining stock built-in renderers.
- [ ] Add Markdown, selective syntax highlighting, images, expansion controls, and responsive phone layout.
- [ ] Port relevant exporter and local renderer security/truncation fixtures.

### Phase 4 — boxed composer, controls, and session polish (depends on Phases 2–3)

- [ ] Implement the responsive boxed composer based on `.pi/agent/extensions/boxed-editor.ts`: usage/cost, provider/model, colored thinking level, shortened cwd, multiline input, and mobile-safe sticky placement.
- [ ] Implement idle prompt and explicit busy steer/follow-up modes.
- [ ] Implement abort, busy/idle/reconnect state, model/thinking/cwd/session display, and command acceptance feedback.
- [ ] Preserve active branch ordering and reconcile ephemeral finals without visible duplication.
- [ ] Add read-only tree only if active-branch usage proves insufficient.

### Phase 4b — composer completion (separate milestone after core composer)

- [ ] Add `/` completion from `pi.getCommands()` for extension commands, prompt templates, and skills that are actually invokable through web prompting; do not suggest TUI-only built-in commands.
- [ ] Add `@` completion through the installed `@ff-labs/pi-fff` provider so web results retain FFF indexing, fuzzy/frecency/git-aware ranking, directory results, 20-result cap, and quoted-path insertion semantics; do not build a competing `node:fs` scanner.
- [ ] Establish the smallest stable integration seam with pi-fff. Prefer a public/event-bus completion broker or exported singleton service that reuses its existing finder; the installed 0.10.1 package currently keeps `getMentionItems` and `createFffMentionProvider` private, so do not create a second native finder that could duplicate indexing or contend for FFF database locks.
- [ ] Preserve cancellation/debouncing, authenticated request bounds, cwd/session-generation invalidation, and FFF's existing fallback behavior when its lookup is unavailable.
- [ ] Implement keyboard and touch navigation, selection replacement, escape dismissal, active-descendant accessibility, and mobile popup positioning.
- [ ] Refresh command candidates after reload/session replacement and invalidate path candidates when cwd/generation changes.
- [ ] Keep completion as a lightweight custom popover around the native textarea; adopt a full editor dependency only if selection/replacement behavior proves insufficient.

### Phase 5 — Agentflow dashboard (depends on provider bridge and stable protocol)

- [ ] Add Agentflow's provider bridge without exposing `RunEngine` directly.
- [ ] Render run list/detail, nodes, phases, tool calls, output, errors, usage/cost, sessions, and artifacts.
- [ ] Stream coalesced snapshot updates.
- [ ] Support cancel and steer with explicit confirmation/targeting where needed.
- [ ] Verify dashboard state survives browser reconnect via a fresh provider snapshot.

### Phase 6 — background dashboard (can parallelize with Phase 5 after bridge stabilization)

- [ ] Add background provider bridge using bounded serialized job DTOs.
- [ ] Render running/recent jobs, elapsed time, output tail, terminal cause, delivery health, monitor counters, and artifact paths.
- [ ] Support stop and bounded tail refresh.
- [ ] Preserve existing completion/event delivery semantics and avoid consuming results merely by viewing them.

### Phase 7 — remote hardening and release verification (depends on integrated UI)

- [ ] Document localhost and `tailscale serve` usage.
- [ ] Complete CSP, authentication, Origin, unsafe Markdown/URL, oversized payload, malicious filename/output, and slow-client tests.
- [ ] Verify normal shutdown, `/reload`, `/new`, `/resume`, `/fork`, TUI, RPC, reconnect, and port release.
- [ ] Audit generated `.pi/agent/extensions/herdr-agent-state.ts` interaction without editing it.
- [ ] Run stable integrated review and fix actionable findings.

## Dependency graph and parallel work

- Phases 0 → 1 → 2 establish the protocol contract and are sequential.
- Renderer implementation in Phase 3 can proceed from captured fixtures while Phase 2 transport details are finalized.
- Phase 4 needs both stable state and renderers.
- Agentflow and background provider changes share the capability bridge contract; after that contract is fixed, Phases 5 and 6 can be implemented independently.
- Phase 7 follows integration because its tests exercise lifecycle and all transports together.

## Initial acceptance criteria

- A normal `pi` invocation exposes one authenticated loopback web UI for that exact session, announces its canonical URL once at startup, offers `/copy-remote-url` for a directly usable authenticated link, and cleans it up on every supported lifecycle transition.
- Browser rendering presents at least the same core information as the local compact/custom TUI renderers for the custom tool set, with safe generic fallback for unknown tools.
- Streaming assistant/tool state remains correlated and reconnectable without blocking Pi event handlers.
- Browser prompt, explicit steer/follow-up, and abort work in both TUI and RPC hosts, through a responsive composer recognizably matching the local boxed editor's structure.
- Agentflow and background dashboards consume bounded provider DTOs and support their core control actions without importing or exposing private runtime state.
- No public-internet hosting claim, global daemon, full TUI emulation, or arbitrary TUI renderer execution is introduced.
