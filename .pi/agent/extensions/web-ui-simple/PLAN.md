# Web UI Simple and Remote Session Infrastructure Plan

## Product direction

`.pi/agent/extensions/web-ui-simple/` is the canonical Pi browser UI and the place where future session-UI development happens.

That choice is intentional rather than temporary:

- its HTML-exporter-derived transcript is the desired visual design;
- it is already useful as a minimal standalone extension;
- its behavior has been developed and reviewed incrementally;
- new capabilities should preserve that UI rather than replacing it with a more elaborate application shell;
- the existing `.pi/agent/extensions/web-ui/` is a source of proven implementation ideas, tests, and bounded algorithms, not the product to converge onto.

The richer `web-ui` extension remains disabled. We may port narrowly selected mechanisms from it, but should not wholesale-copy its component hierarchy, navigation, visual language, WebSocket protocol, or dashboard shell into `web-ui-simple`.

The remote process manager will be a separate Node/TypeScript project, provisionally `<repo>/remote-session-daemon/`, outside the extension directory. The extension remains responsible for one live Pi session; the daemon owns machine-level launch policy, subprocess supervision, stable routing, and Tailscale-backed authorization.

Related design material is kept with the extension rather than at repository root:

- [`docs/REMOTE_SESSION_INFRA_PLAN.md`](docs/REMOTE_SESSION_INFRA_PLAN.md) — detailed daemon and managed-session architecture;
- [`docs/ADDITIONAL_DETAILS.md`](docs/ADDITIONAL_DETAILS.md) — earlier boundary, security, and base-path requirements;
- [`docs/SSE_TRAFFIC_ANALYSIS.md`](docs/SSE_TRAFFIC_ANALYSIS.md) — measured full-snapshot transport costs;
- [`docs/SLASH_COMMAND_DISPATCH.md`](docs/SLASH_COMMAND_DISPATCH.md) — current Pi command-dispatch limitations.

## Design principles

1. **Preserve the current appearance.** Transcript typography, HTML-exporter rendering, disclosure behavior, composer layout, and minimal single-session shape are product requirements.
2. **Port mechanisms, not UI architecture.** Reuse bounded projection, transport, security, rendering, and testing lessons from `web-ui` without adopting its visual structure.
3. **Keep standalone mode excellent.** Local and per-session Tailscale links continue to work without the daemon.
4. **Add managed mode explicitly.** Managed mode is opt-in, disables extension-owned Tailscale Serve, and trusts only a loopback proxy carrying a per-child capability.
5. **Prefer SSE plus command POSTs.** This already matches the simple extension and avoids unnecessary WebSocket/proxy complexity. Adopt WebSockets only for a demonstrated requirement.
6. **Bound all remote-facing work.** Transcript windows, update frames, uploads, completion results, provider snapshots, request bodies, queues, and logs need explicit limits.
7. **Do not duplicate Pi semantics.** Use public Pi APIs for prompts, model changes, and images. Keep slash dispatch blocked until Pi exposes a canonical API.
8. **Preserve session-scoped lifecycle.** Start resources only from `session_start`; close them idempotently in `session_shutdown` across reload/new/resume/fork/quit.

## Current baseline

`web-ui-simple` already provides:

- loopback-only ephemeral HTTP serving under a random path;
- one-use fragment bootstrap credentials and a path-scoped `HttpOnly; SameSite=Strict` cookie;
- full active-branch snapshots over authenticated SSE;
- bounded same-origin input and completion POSTs;
- prompt, steer, and follow-up admission;
- canonical `@` file completion where available;
- responsive desktop/mobile composer behavior;
- HTML-exporter-derived messages, thinking, Markdown, tool results, compactions, model switches, and custom messages;
- tailored Agentflow/background/custom-tool transcript rendering;
- session-scoped Tailscale Serve in standalone mode;
- clean shutdown and 18 passing Playwright tests.

Known baseline gaps:

- `nub run check` currently stops on formatting of `docs/SSE_TRAFFIC_ANALYSIS.md`; lint, typecheck, and all Playwright tests pass independently;
- full-snapshot SSE is not viable for sustained large remote sessions;
- CDN scripts prevent a strict production CSP and offline use;
- no pagination or virtualization;
- standalone cookie authentication is unsuitable for a cross-origin managed iframe;
- no readiness FD, managed capability authentication, roles, or controlled framing;
- remaining README roadmap features are not implemented.

## What to learn from the richer `web-ui`

Use the richer extension as a donor for focused mechanisms:

| Learning | Port to `web-ui-simple` | Do not port by default |
| --- | --- | --- |
| Bounded TypeBox wire schemas and projection | Yes | Its complete protocol/component model |
| Revision, generation, reset, and resync semantics | Yes, adapted to SSE | WebSocket solely because it is already there |
| Paged history and stable row identity | Yes | Its timeline visual hierarchy |
| TanStack virtual-core integration | Yes, after stable incremental rows | Its surrounding application shell |
| Bundled local Preact/Marked/Highlight.js | Yes | A broad dependency set without need |
| Selective Highlight.js language registry | Yes | Automatic unbounded language detection |
| Bounded image transfer and explicit placeholders | Yes | Blindly forwarding unbounded inline image payloads |
| Questionnaire result normalization | Yes | Generic remote `ctx.ui.custom()` bridging |
| Provider snapshot/action boundary for dashboards | Yes, with the simple UI's design | Dashboard navigation and styling wholesale |
| CSP, `nosniff`, no-referrer, exact Origin tests | Yes | Standalone auth assumptions in managed mode |
| Client queue/backpressure tests | Yes, adapted to SSE operations | Generic transport abstraction before needed |
| Large-session fixtures and bounded-DOM tests | Yes | Screenshot parity to the richer UI |
| Safe basic unified-diff renderer | As an interim/reference | `@pierre/diffs` before product need is proven |

## Roadmap priorities

### P0 — preserve correctness and make the simple architecture scalable

#### 1. Restore a fully green baseline

- [ ] Format `docs/SSE_TRAFFIC_ANALYSIS.md` and keep `nub run check` green.
- [ ] Add a large-session fixture before changing transport or rendering.
- [ ] Record current HTML-exporter transcript and composer screenshots as visual regression references.
- [ ] Add explicit tests for reload/new/resume/fork cleanup and replacement generations.

#### 2. Restructure the client and server by responsibility without changing behavior

The current `src/index.ts`, `src/server.ts`, and approximately 2,000-line client entry have reached the point where adding transport, providers, and specialized renderers in place would obscure ownership. Reorganize before those features land, using small modules and preserving the existing output exactly.

Target shape (adjust names if implementation experience suggests a simpler split):

```text
src/
  index.ts                     extension lifecycle and Pi event wiring
  shared/
    limits.ts                  cross-boundary size/count limits
    wire.ts                    snapshots, SSE operations, commands, DTO schemas
  server/
    index.ts                   listener startup and shutdown
    auth.ts                    standalone and managed authentication
    config.ts                  validated startup configuration
    routes.ts                  static/auth/input/completion/history routes
    sse.ts                     clients, revisions, coalescing, backpressure
    snapshot.ts                session projection and live overlays
    completion.ts              mention completion adapters
    providers.ts               Agentflow/background provider registry
  client/
    index.html
    styles.css
    app.js                     thin composition root
    state/                     snapshot/update reducer and preferences
    transport/                 bootstrap, EventSource, command requests
    components/                composer, palette, status strip
    render/
      messages.js              user/assistant/custom message dispatch
      markdown.js              Marked and highlighting integration
      tool-call.js             common tool shell and expansion
      tools/
        builtins.js
        agentflow.js
        background.js
        questionnaire.js
        diff.js
```

- [ ] Move code in behavior-preserving steps, one responsibility at a time.
- [ ] Put Agentflow, background-process, questionnaire, built-in, and future diff renderers in clearly named renderer modules.
- [ ] Keep shared tool-shell, expansion, Markdown, path-wrapping, and truncation behavior centralized rather than copied across renderer modules.
- [ ] Separate Pi/session projection from HTTP transport so incremental SSE and paging can be tested without starting a browser.
- [ ] Separate browser transport/state from rendering so fixtures can apply snapshots and operations deterministically.
- [ ] Preserve current DOM semantics, class names, CSS, screenshots, keyboard behavior, and accessible names during the reorganization.
- [ ] Avoid a framework-style folder explosion: create a module only when it owns a real responsibility or independently testable boundary.

#### 3. Add a minimal local bundling step without redesigning the UI

- [ ] Keep the current Preact + HTM structure and existing DOM/CSS where practical.
- [ ] Replace esm.sh imports with pinned local dependencies and one small production bundle.
- [ ] Serve hashed or deterministic local assets from the extension package.
- [ ] Add a strict CSP, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- [ ] Preserve relative asset/auth/event/input/completion URLs and arbitrary base-path mounting.
- [ ] Introduce TypeScript or TypeBox only at useful boundaries; do not require a wholesale visual rewrite.

Bundling is a deployment and security improvement, not permission to change the UI.

#### 4. Replace full-snapshot streaming with a small SSE operation protocol

- [ ] Give every extension runtime a generation and every semantic update a monotonic revision.
- [ ] Send a bounded full snapshot only for initial connection, reset, unsupported transitions, or recovery.
- [ ] Append immutable persisted entries once.
- [ ] Keep partial assistant messages and live tools in a replaceable live-tail operation.
- [ ] Send metadata/theme/running state independently from transcript updates.
- [ ] Require `fromRevision` to match the browser revision; otherwise issue a reset snapshot.
- [ ] Under backpressure, coalesce replaceable status/live operations and fall back to one reset if append continuity is lost.
- [ ] Give synthetic live entries stable identities; remove generated timestamps from semantic freshness checks.
- [ ] Instrument frame count, bytes, reason, serialization time, blocked/coalesced writes, connected clients, browser parse time, and render time.

Do not add generic JSON Patch, conflict resolution, offline writes, or durable replay. Continue using authenticated SSE and bounded POST commands.

#### 5. Add bounded history and virtualization while preserving exporter rendering

- [ ] Project a bounded latest-history window into the initial snapshot.
- [ ] Add an authenticated older-history endpoint with opaque cursors and generation validation.
- [ ] Prepend pages without gaps, duplicates, or scroll jumps.
- [ ] Introduce stable row keys independent of array position.
- [ ] Virtualize only the transcript rows; keep the status/composer behavior unchanged.
- [ ] Preserve per-row thinking/tool expansion through virtual unmount/remount.
- [ ] Preserve bottom-follow behavior and the current scroll-to-bottom affordance.
- [ ] Add multi-thousand-entry tests for bounded DOM size, top-page anchoring, branch resets, and live growth.

### P1 — security and managed-session seams

These are required for remote infrastructure but should remain visually invisible in standalone use.

#### 6. Add explicit standalone and managed startup modes

- [ ] Standalone remains the default:
  - random internal path and ephemeral loopback port;
  - fragment bootstrap exchange and path-scoped cookie;
  - `/copy-url` and `/copy-remote-url`;
  - optional extension-owned per-session Tailscale Serve;
  - `frame-ancestors 'none'`.
- [ ] Managed mode reads bounded inherited configuration:
  - loopback bind/port;
  - internal and external base paths;
  - exact external origin and dashboard frame ancestor;
  - per-child proxy capability;
  - readiness FD and protocol version.
- [ ] Managed mode never starts its own Tailscale Serve.

#### 7. Add readiness and generation reporting

- [ ] Write machine-readable `ready` after every `session_start` to a private inherited FD, never stdout.
- [ ] Include protocol version, generation, loopback endpoint/base path, session ID/file metadata, and public-safe state.
- [ ] Write `stopping` during idempotent `session_shutdown`.
- [ ] Test reload/new/resume/fork endpoint churn and exceptional cleanup.
- [ ] Keep RPC stdout strictly LF-delimited JSONL.

#### 8. Add managed trusted-proxy authentication

- [ ] Accept managed traffic only from loopback with the inherited per-child capability.
- [ ] Ignore and strip browser-supplied internal identity/capability headers.
- [ ] Consume normalized principal and role only after capability validation.
- [ ] Support at least viewer and controller roles.
- [ ] Authorize every command endpoint by role and generation.
- [ ] Add replay protection for mutating command IDs.
- [ ] Validate the configured external Origin on mutations; do not use Origin as the sole authorization signal for document/SSE GETs.
- [ ] Never place internal capabilities in URLs, cookies visible to scripts, browser storage, logs, iframe messages, or transcript state.
- [ ] Permit framing only from the exact configured dashboard origin.

#### Cross-boundary hotkey and focus ownership design

Some keyboard behavior necessarily meets the extension/daemon/dashboard boundary, especially once the session UI is framed inside a machine/session dashboard. Treat this as a deliberate design task rather than letting key handlers accumulate independently.

- [ ] Inventory current session hotkeys (`i`, display toggles, `Cmd/Ctrl+K`, send/steer/follow-up modifiers) and proposed model/dashboard shortcuts.
- [ ] Classify every shortcut as session-scoped, dashboard-scoped, or Pi/TUI-derived.
- [ ] Keep transcript, composer, model, abort, and session-control shortcuts owned and authorized by the session UI.
- [ ] Keep machine selection, session-card navigation, launch, attach, and daemon operations owned by the outer dashboard.
- [ ] Document browser focus reality: the dashboard cannot reliably capture a shortcut while focus is inside a cross-origin iframe, and the child cannot own machine-wide navigation without an explicit bridge.
- [ ] Decide whether duplicated visible commands are sufficient before introducing cross-frame keyboard coordination.
- [ ] If coordination is needed, use a versioned, exact-origin `postMessage` handshake carrying only allowlisted UI intents and focus state—never credentials, proxy capabilities, prompts, or direct authorization decisions.
- [ ] Require the receiving side to perform its normal role, generation, and command admission checks; `postMessage` must not bypass HTTP authentication.
- [ ] Test focus entry/exit, iframe reload, stale generations, nested dialogs, browser-reserved shortcuts, and open-in-new-tab behavior.
- [ ] Revisit whether selected Pi keybindings should be projected to the browser through a bounded session-UI DTO; the daemon should transport configuration only when necessary, not become the keybinding authority.

### P1 — requested UI features, preserving the current design

These can proceed in parallel with managed-mode work once bundling and stable protocol boundaries exist.

#### 9. Syntax highlighting

- [ ] Port the richer extension's selective Highlight.js core registry.
- [ ] Highlight fenced code in user and assistant Markdown using existing Pi theme variables.
- [ ] Escape and render unknown languages as plain text.
- [ ] Avoid highlighting huge blocks synchronously; add a size cutoff.
- [ ] Add visual and semantic tests without changing Markdown spacing or typography.

#### 10. Questionnaire result rendering

- [ ] Normalize questionnaire args/details into the existing tool-call presentation.
- [ ] Render question count, labels, answers, custom answers, cancellation, running, and error states.
- [ ] Keep this transcript-only initially; do not claim browser answering support.
- [ ] Preserve Herdr behavior of the actual local questionnaire tool.

#### 11. Remote-safe image display

- [ ] Render user-message image blocks as well as read/tool-result images.
- [ ] Project image content into a browser-safe wire representation: retain only supported MIME metadata and image data that fit explicit count/byte limits, rather than serializing arbitrary raw session objects.
- [ ] Bound MIME type, encoded bytes, image count, and decode/render dimensions. “Projected dimensions” means dimensions accepted for browser display or thumbnailing, not silently resizing the source stored in the Pi session.
- [ ] When an image is too large, unsupported, malformed, or intentionally excluded from a history page, send a small explicit placeholder such as “image omitted: payload exceeds remote display limit” instead of transferring it or dropping it silently.
- [ ] Ensure base64 data never enters search text, logs, completion state, or diagnostic telemetry.
- [ ] Verify images through history paging, reset, SSE framing, Tailscale, and managed proxy paths.

#### 12. Agentflow and background-process status area

- [ ] Add a compact status strip below the composer, matching the existing visual language.
- [ ] Use provider registration/snapshot boundaries learned from `web-ui` rather than scraping transcript entries.
- [ ] Start with bounded read-only summaries and drill-down panels.
- [ ] Add actions only after controller roles, command replay protection, and generation checks exist.
- [ ] Do not mark autonomous background work as Herdr blocked.

#### 13. Image attachments

- [ ] Add bounded picker/paste/drop support to the current composer.
- [ ] Preview and remove attachments before submission.
- [ ] Use Pi's public image-capable message APIs.
- [ ] Enforce count, byte, MIME, and dimension limits before entering Pi or the transcript protocol.
- [ ] Preserve the exact draft and attachments on rejection; clear only after authoritative acceptance.
- [ ] Require controller authority in managed mode.

#### 14. Model switching with `Opt-M`

- [ ] Add a small selector visually consistent with the existing command palette.
- [ ] List selected/configured and authenticated models first; avoid an unbounded catalog.
- [ ] Use public Pi model APIs, not `/model` text dispatch.
- [ ] Require controller authority, current generation, and normally idle state.
- [ ] Return authoritative accepted/rejected feedback and update snapshot metadata through normal events.

### P2 — after the stable managed origin and primary workflow

#### 15. Browser notifications

- [ ] Notify for completed/failed turns and questions only when the page is not visible/focused.
- [ ] Request browser permission through an explicit user action, not automatically on every session load.
- [ ] Use the stable managed host origin so permission persists across sessions.
- [ ] Keep standalone ephemeral-origin notifications optional because repeated permission prompts are likely.
- [ ] Do not add a PWA/service worker unless closed-page delivery is explicitly required.

#### 16. Git diff visualizer

- [ ] First port or adapt the richer extension's safe bounded unified-diff renderer.
- [ ] Preserve plain-text fallback and transcript virtualization.
- [ ] Evaluate `@pierre/diffs` only if side-by-side review, file navigation, or other concrete workflows justify the bundle and layout cost.
- [ ] Add truncation and large-diff performance tests before enabling rich rendering by default.

### Blocked pending Pi support or a dedicated design

#### Slash-command autocomplete and dispatch

- [ ] Keep `/` completion disabled as an executable feature until Pi exposes a supported canonical raw-input dispatcher and command argument-completion API.
- [ ] Do not import private Pi internals, duplicate template/skill expansion, or create a competing RPC controller.
- [ ] When upstream support exists, require accepted/rejected disposition, generation validation, idempotent command IDs, and safe handling of interactive commands.

#### Generic browser interaction bridge

- [ ] Initially cancel unsupported blocking RPC dialogs in daemon-launched sessions so children cannot hang.
- [ ] Standard `select`/`confirm`/`input`/`editor` bridging may be designed later.
- [ ] Arbitrary `ctx.ui.custom()` cannot be generically serialized; questionnaire answering would need a dedicated protocol or an upstream capability.

## Remote daemon project

Create the daemon as a separate repository-level project, provisionally:

```text
<repo>/remote-session-daemon/
  package.json
  src/
    api/
    auth/
    config/
    process/
    proxy/
    rpc/
    state/
  test/
  service/
    systemd/
    launchd/
```

It must not live inside `web-ui-simple` and must not turn the extension into a process manager.

### Daemon Phase A — contracts and isolated host core

Can start immediately in parallel with extension work.

- [ ] Define strict TypeBox schemas for host config and launch/list/attach/stop DTOs.
- [ ] Define the versioned readiness record jointly with `web-ui-simple`.
- [ ] Implement approved root aliases and relative-path resolution.
- [ ] Table-test absolute paths, `..`, missing directories, symlink escapes, and prefix-confusion paths.
- [ ] Implement strict LF-only RPC JSONL parsing with `StringDecoder`; do not use Node `readline`.
- [ ] Build a fake Pi child for readiness, RPC, crash, slow-output, and shutdown tests.
- [ ] Implement bounded stdout/stderr draining and process-group lifecycle primitives.
- [ ] Keep project trust separate from approved cwd; initially require prior local/admin trust.

### Daemon Phase B — fixed proxy and one-child supervision

Integration depends on the extension's managed mode and readiness FD, but most state-machine work can begin earlier.

- [ ] Launch one `pi --mode rpc` subprocess per remote session with fixed validated arguments, approved cwd, curated environment, and a private readiness FD.
- [ ] Implement launch/list/attach/stop and a stable opaque launch ID.
- [ ] Map `/_pi/s/<launchId>/` to the latest ready child endpoint and generation.
- [ ] Proxy static HTTP, SSE without buffering, and command POSTs with equal or tighter limits than the child.
- [ ] Strip spoofable internal headers and inject capability plus normalized principal/role.
- [ ] Return temporary `503` during reload/replacement rather than routing stale state.
- [ ] Gracefully stop, wait for shutdown, then terminate the process group after a deadline.
- [ ] Drain RPC after readiness but do not issue competing conversation mutations.
- [ ] Cancel unsupported blocking `extension_ui_request` dialogs.

### Daemon Phase C — Tailscale identity and authorization

- [ ] Bind daemon and children to loopback only.
- [ ] Put one persistent Tailscale Serve endpoint in front of the daemon; never use Funnel.
- [ ] Validate identity-header behavior on supported clients and reject spoofed copies.
- [ ] Combine Tailscale grants/ACLs with application roles.
- [ ] Add viewer, controller, launcher, and operator roles.
- [ ] Add one renewable controller lease per session while permitting multiple viewers.
- [ ] Treat launch/control as remote code execution under the daemon's Unix account.

### Daemon Phase D — discovery and dashboard

The dashboard UI can be developed against mocked daemon APIs while auth and supervision are built. The detailed strategy and alternatives are recorded in [`docs/REMOTE_SESSION_INFRA_PLAN.md`](docs/REMOTE_SESSION_INFRA_PLAN.md#client-dashboard-and-tailscale-discovery).

Selected discovery design:

- [ ] Serve a bounded, public-safe `/_pi/daemon/v1/presence` response from every daemon with an exact kind marker and protocol version.
- [ ] Let any known daemon act as the discovery seed: run bounded `tailscale status --json`, extract visible peer MagicDNS names defensively, and probe the fixed presence endpoint over HTTPS.
- [ ] Use bounded polling and caching: initially 15–30 second refreshes, 10–15 second cache lifetime, eight concurrent probes, 2–3 second timeouts, 256 candidates, and 4 KiB responses.
- [ ] Disable probe redirects, accept targets only from local Tailscale status, and return only schema-valid positive detections through an authenticated dashboard endpoint.
- [ ] Keep discovery metadata free of sessions, cwd values, models, users, credentials, capabilities, and proxy secrets.
- [ ] Treat discovery as reachability evidence only; each selected daemon still authorizes the browser principal and role normally.
- [ ] Show generic unreachable states without claiming to distinguish policy, DNS, tailnet, host, and daemon failures.
- [ ] Keep manual host entry as a fallback and use any known daemon URL for initial bootstrap.

Dashboard work:

- [ ] Populate approved roots/projects from the selected daemon.
- [ ] Add launch/resume and session cards with machine, cwd, model, state, owner, and controls.
- [ ] Embed the selected session UI as a direct cross-origin iframe.
- [ ] Add an open-in-new-tab fallback.
- [ ] Configure exact CORS and frame ancestor origins.
- [ ] Do not put Tailscale API credentials in the SPA.

Deferred alternatives, not first-version dependencies:

- [ ] Consider one shared Tailscale Service only if a stable bootstrap URL without seed bookmarks justifies tag-based hosts, approval, and service lifecycle complexity; it would not replace peer probes for listing physical machines.
- [ ] Consider a least-privilege server-side Tailscale inventory only if peer enumeration is insufficient; inventory still requires presence probes and credential management.
- [ ] Consider an expiring heartbeat registry only if bounded peer probing becomes limiting.
- [ ] Use static host lists only as fallback/test fixtures and machine tags only as an optional candidate filter; neither proves a live daemon.
- [ ] Do not depend on alpha endpoint collection for application discovery.

### Daemon Phase E — recovery and operations

- [ ] Persist small owner-only launch metadata atomically; keep Pi JSONL as transcript truth.
- [ ] Add launch idempotency, idle TTL, capacity/rate limits, and transcript-free audit events.
- [ ] On daemon restart, prefer a fresh idle Pi process resuming a validated session over adopting unknown orphan state.
- [ ] Never replay a kickoff prompt whose acceptance outcome is unknown.
- [ ] Never automatically resume active model work after reboot.
- [ ] Package as `systemd --user` and a macOS LaunchAgent after the child lifecycle stabilizes.
- [ ] Test daemon/child/proxy crashes, host reboot, stale generations, slow clients, and process cleanup.

## Parallel execution map

### Track 1 — simple UI scalability

Sequential core:

1. green baseline and visual references;
2. behavior-preserving server/client/renderer reorganization;
3. local bundling and security headers;
4. revisioned SSE operations;
5. paged history;
6. virtualization.

The current UI should remain visually stable throughout.

### Track 2 — requested UI features

After bundling, these can be developed mostly independently with separate fixtures:

- Highlight.js;
- questionnaire result rendering;
- image display;
- compact dashboard/status strip.

Image attachments and model controls should wait for authoritative command-response and role seams, but not for the full daemon.

### Track 3 — managed extension mode

Can begin after readiness/auth contracts are frozen and proceed in parallel with Track 1. It will eventually rebase onto the incremental transport rather than exposing full snapshots remotely.

### Track 4 — daemon host core

Can start immediately with schemas, filesystem policy, strict RPC parser, fake child, supervision, and service state. Stable attach/proxy integration waits for managed readiness and authentication.

### Track 5 — ingress and dashboard

- Test Tailscale Serve, SSE flushing, exact origins, iframe behavior, and spoofed headers as early spikes.
- Build dashboard UX against mocks.
- Run the cross-boundary hotkey/focus design before assigning overlapping session and dashboard shortcuts.
- Connect real launch/control only after roles and controller leases exist.

## What does not block starting the daemon

The daemon does not need to wait for:

- syntax highlighting;
- questionnaire result rendering;
- image display or attachment;
- dashboards inside the session UI;
- model selection;
- notifications;
- rich diffs;
- slash dispatch.

It does need the following before an end-to-end managed attach milestone:

- versioned readiness FD records;
- managed capability authentication;
- stable base-path behavior;
- generation changes on session replacement;
- exact framing/Origin policy;
- a transport suitable for sustained remote use.

The host-core implementation and fixed-proxy proof should therefore begin now, while the extension team builds those integration seams.

## Herdr and lifecycle requirements

- Browser composition, autonomous agent work, background jobs, daemon supervision, and notification delivery are not Herdr blocked scopes.
- Any browser flow where Pi genuinely awaits a human answer must emit local `herdr:blocked` active before waiting and balance inactive in `finally`.
- Balance must hold across answer, cancellation, timeout, abort, error, reload, shutdown, and nested interactions.
- Preserve Herdr's normal working-to-idle lifecycle and unseen-idle derivation of done; never report done directly.
- Add lifecycle tests before shipping any remote dialog bridge.

## Completion criteria

This plan is complete when:

- `web-ui-simple` retains its current visual identity while using local assets, bounded incremental transport, paged/virtualized history, and strict security headers;
- its requested feature roadmap is implemented or explicitly deferred with tested boundaries;
- standalone local/tailnet behavior remains available;
- managed mode exposes readiness, capability authentication, roles, stable base paths, and controlled framing;
- `remote-session-daemon/` independently launches and supervises approved Pi children, reverse-proxies stable session URLs, and integrates with Tailscale identity;
- a static-host dashboard can launch, attach, view, control, and stop sessions without centralizing transcript traffic;
- crash, reload, stale-generation, authorization, and Herdr exceptional-cleanup tests pass.
