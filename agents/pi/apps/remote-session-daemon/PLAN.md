# Remote Session Daemon Plan

## Scope and source of truth

This plan owns the machine-level daemon and managed cross-machine dashboard backend. It is intentionally separate from the Pi extension plan:

- session UI and standalone extension: [`../../agent/extensions/web-ui/PLAN.md`](../../agent/extensions/web-ui/PLAN.md);
- architecture, diagrams, and security rationale: [`../../agent/extensions/web-ui/docs/RPC_FIRST_REMOTE_DASHBOARD.md`](../../agent/extensions/web-ui/docs/RPC_FIRST_REMOTE_DASHBOARD.md);
- Pi input/command capability analysis: [`../../agent/extensions/web-ui/docs/SLASH_COMMAND_DISPATCH.md`](../../agent/extensions/web-ui/docs/SLASH_COMMAND_DISPATCH.md);
- typed SDK evaluation, repeatable results, safeguards, and continuation state: [`docs/SDK_HOSTING_EVALUATION.md`](docs/SDK_HOSTING_EVALUATION.md);
- upstream Pi event-bus reload reproduction: [`docs/PI_EVENT_BUS_RELOAD_MRE.md`](docs/PI_EVENT_BUS_RELOAD_MRE.md);
- repository installation and workspace commands: repository-root [`README.md`](../../README.md).

The daemon is a root-workspace application and later a per-machine user service. It is not a Pi extension and must never be placed under `agent/extensions/`.

Phase 0D selects bounded in-process typed `AgentSessionRuntime` hosting for the initial daemon. All Pi SDK types stay behind a host-neutral `SessionHost` adapter so execution can later move to process-isolated typed SDK workers without changing browser, auth, persistence, or projection contracts. CLI RPC children remain a measured fallback, not the initial process model.

## Product objective

On each enrolled machine, run one daemon that lets an authorized tailnet user:

- discover reachable machines running compatible daemons;
- list approved roots and local managed sessions;
- launch or resume Pi in an approved directory;
- attach to a stable daemon-served session UI;
- prompt, steer, queue follow-ups, abort, change model/thinking, and invoke supported commands through the canonical typed Pi SDK;
- survive browser disconnects, SDK host unload/replacement, daemon restart, and machine sleep/reconnect without replaying ambiguous work;
- stop and recover managed sessions under explicit policy.

The daemon serves the reused session SPA itself. Managed SDK hosts load no `web-ui` extension or child HTTP server, and the dashboard does not use session iframes.

## Repository layout

```text
apps/
  remote-session-daemon/
    package.json
    nub.lock
    tsconfig.json
    PLAN.md
    src/
      index.ts                         composition root
      api/
        server.ts
        routes/
        schemas.ts
        errors.ts
      auth/
        tailscale-principal.ts
        roles.ts
        origin.ts
        controller-lease.ts
      config/
        schema.ts
        load.ts
        roots.ts
      discovery/
        tailscale-status.ts
        presence-probe.ts
        cache.ts
      host/
        session-host.ts                 host-neutral adapter contract
        registry.ts                     loaded/unloaded host ownership and limits
        sdk-bundle.ts                   independent Pi runtime/service/bus bundle
        sdk-host.ts                     typed SDK adapter implementation
        admission.ts                    browser admission and interrupt policy
        replacement.ts                  transition/reload bundle rotation
        recovery.ts
        dialogs.ts
      projection/
        reducer.ts
        events.ts
        entries.ts
        history.ts
        providers.ts
      state/
        launches.ts
        persistence.ts
        idempotency.ts
      web/
        main.ts                        shared client + managed transport
        managed-transport.ts
      observability/
        bounded-log.ts
        metrics.ts
        audit.ts
    test/
      fixtures/
        fake-session-host.ts
        sessions/
      unit/
      integration/
      security/
      e2e/
    service/
      systemd/
      launchd/

packages/
  pi-web-ui-client/                  sibling host-neutral dependency
```

Workspace dependency:

```json
"@dotfiles/pi-web-ui-client": "workspace:*"
```

The root `~/.pi/package.json` owns workspace installation and aggregate scripts; this package retains its own manifest and filtered checks.

The daemon imports only public exports such as `./wire`, `./client`, `./styles.css`, and test-only `./testing`. It must not import the `web-ui` extension, Agentflow runtime classes, background-process runtime classes, or any other extension implementation.

## Architectural invariants

1. One daemon process per machine and one independent complete SDK host bundle per loaded launch.
2. Loaded-host count is hard-capped; idle launches unload and reopen only from confirmed persisted identity.
3. Only the exact audited managed extension profile loads; package/project extension discovery is disabled.
4. Pi SDK objects never cross the host-neutral `SessionHost` adapter into HTTP, auth, persistence, or browser code.
5. The daemon serves the SPA, API, SSE, and history endpoints directly.
6. `launchId` is stable routing metadata, never a credential.
7. Every mutation is authenticated, authorized, Origin-checked, generation-checked, replay-checked, bounded, and controller-lease-checked where required immediately before SDK invocation.
8. Prompt preflight admission is distinct from eventual completion; no accepted or ambiguous command is automatically retried.
9. Browser slowness never blocks SDK session/tool event processing.
10. Pi session JSONL is transcript truth; projections and daemon metadata are disposable.
11. Discovery proves reachability only; the selected daemon authenticates the browser again.
12. Remote launch/control is code execution as the daemon's Unix account; approved roots are not a sandbox.
13. Until the minimal fix for Pi's extension event-bus listener leak ([earendil-works/pi#7193](https://github.com/earendil-works/pi/issues/7193)) lands upstream, `session.reload()` is forbidden and every session replacement and managed reload rotates the complete loader/services/model/event-bus/runner/subscription bundle. This whole-session-object replacement is a temporary workaround, not the intended post-fix reload design.
14. Standard browser dialogs remain disabled until the daemon-owned SDK UI context has bounded, exactly-once cleanup; arbitrary `ctx.ui.custom()` is never serialized.
15. No session iframe, child reverse proxy, readiness FD, raw RPC bridge, or extension-owned server is introduced.

## Package and UI integration boundary

The daemon and extension share browser presentation, not backend implementation.

### Shared package provides

- versioned browser DTO schemas and agreed limits;
- reducer and session view model;
- transcript/composer/status/dialog components;
- renderers, preferences, hostile-content handling, and styles;
- mock transport and deterministic contract fixtures.

### Daemon provides

- `ManagedSessionTransport` browser adapter;
- typed SDK/session projection into shared DTOs;
- daemon HTTP/SSE/history endpoints;
- managed capability advertisement;
- machine/session dashboard shell around the shared session view.

### Integration acceptance

- daemon producer output validates at runtime against shared schemas;
- equivalent extension/daemon fixtures reduce to equivalent browser state;
- final daemon assets contain no runtime path to the extension package;
- browser host differences are represented by capability flags and transport behavior, not scattered product forks.

## Identity model

| Identifier                  | Lifetime                     | Purpose                                                 |
| --------------------------- | ---------------------------- | ------------------------------------------------------- |
| `daemonId`                  | Installation                 | Stable daemon identity in presence results              |
| `daemonBootId`              | Daemon process               | Detect daemon restart                                   |
| `launchId`                  | Managed launch slot          | Stable route and persisted launch identity              |
| `hostEpoch`                 | Loaded SDK host bundle       | Changes on load, unload/reopen, reload, or recovery     |
| `sessionEpoch`              | Active Pi session/view       | Changes on new/switch/fork/clone or conservative reset  |
| `generation`                | Opaque client token          | Current host/session epoch combination                  |
| `revision`                  | One generation               | Monotonic browser operation sequence                    |
| `sessionId` / `sessionFile` | Pi session                   | Transcript and recovery identity, not authorization     |
| browser `commandId`         | One principal/client request | Replay detection and authoritative response correlation |
| `leaseId` / `leaseEpoch`    | Controller lease             | Exclusive mutation authority                            |

## Session-host model

A loaded launch owns one complete bundle:

```text
SessionHost adapter
  AgentSessionRuntime + current AgentSession
  SettingsManager + ModelRuntime
  ResourceLoader + ExtensionRunner
  private EventBus + provider bindings
  daemon subscriptions + projection state
```

Requirements:

- canonical approved cwd resolved by root alias plus relative path;
- one independent settings/model/loader/event-bus bundle per loaded launch;
- `noExtensions: true` with only repository-owned Agentflow and background-process entry points;
- SDK extension bindings use mode `rpc` with daemon-owned UI/command actions;
- all Pi SDK types remain inside `SessionHost`;
- loaded-host, memory, queue, projection, history, image, tool-output, and log limits;
- idle unload disposes the full bundle and retains only confirmed persisted session identity;
- reopen creates fresh objects and a new generation without emitting `agent_start` or replaying prompts;
- every new/switch/fork/clone/import replacement creates a fresh services/loader/event-bus/runner binding and clears only the retired bus;
- browser disconnect never stops or unloads an active host by itself;
- external OS supervision handles daemon-wide fatal exit or OOM.

The initial exact managed extension profile is:

```text
agent/extensions/agentflow/src/index.ts
agent/extensions/background-processes/src/index.ts
```

TUI-only, standalone-server, Tailscale, notification/focus, Herdr, automatic naming, optional package, and project extensions are excluded until separately audited. Questionnaire needs a narrower split rather than blanket exclusion: its model-callable tool definition and result contract must remain available to managed sessions, while its current `ctx.ui.custom()` TUI component stays local. Before advertising managed questionnaire capability, refactor or adapterize `questionnaire.ts` so the audited managed profile loads the core tool registration and routes bounded requests through the shared questionnaire contract with daemon-owned exactly-once cleanup; until then the current two-extension profile remains intentionally questionnaire-incapable. A host-neutral adapter preserves migration to one process-isolated typed SDK worker per loaded session when revisit conditions fire.

## Browser/API topology

Each daemon serves the same application under a stable path such as:

```text
/_pi/                                  SPA
/_pi/api/v1/host                       host capabilities
/_pi/api/v1/discovery                  public-safe discovered daemons
/_pi/api/v1/roots                      authorized approved-root summaries
/_pi/api/v1/sessions                   local launch summaries/create
/_pi/api/v1/sessions/:launchId         local launch details
/_pi/api/v1/sessions/:launchId/events  projected SSE
/_pi/api/v1/sessions/:launchId/history bounded history pages
/_pi/api/v1/sessions/:launchId/command explicit command route
/_pi/api/v1/sessions/:launchId/lease   controller lease
/_pi/api/v1/sessions/:launchId/stop    lifecycle operation
/_pi/api/v1/sessions/:launchId/dialog  later-phase dialog response
/_pi/daemon/v1/presence                public-safe daemon marker
```

The first cross-machine version uses top-level navigation to the selected daemon. Transcript and mutation APIs remain same-origin with the owning machine. Do not add transcript CORS or central proxying.

## Implementation phases

### Phase 0 — contracts and feasibility gates

#### 0A. Shared package and protocol

- [ ] Contribute managed requirements to the `@dotfiles/pi-web-ui-client` schema work without defining a competing wire contract.
- [x] Consume the shared package's Phase 3 draft core contracts for generation/revision, snapshots/operations, history cursors, and command responses during daemon Phases 3–5; do not define a competing wire contract. Adopt capabilities, images, providers, notifications, and degraded-history contracts only when their owning phases land; they do not block Phase 3 command admission or Phase 4 core projection.
- [ ] Define only daemon-owned API wrappers such as launch routing, host capabilities, roots, discovery, leases, and lifecycle responses.
- [ ] Verify independent clean install of daemon plus local shared dependency.
- [ ] Run daemon producer conformance against shared golden fixtures and expected reducer states without importing extension code.

#### 0B. SDK projection fidelity and bounds

- [x] Build representative real-session fixtures covering messages, thinking, tools, custom entries, images, compactions, branches, model changes, retries, queues, and Agentflow/background output.
- [ ] Compare typed SDK events and direct `SessionManager` entries/tree state with standalone projection output. Source-side SDK fidelity is complete. The shared Phase 3 core schemas and conformance seed are available; remaining daemon producer parity is owned by Phases 4A and 5A. Later image, provider, capability, notification, and degraded-history parity follows the corresponding shared contracts and is not a Phase 3 blocker.
- [x] Measure realistic and adversarial entry, message, image, and tool-result sizes.
- [x] Measure loaded-session entry counts/RSS and bounded history-page projection sizes.
- [x] Define hard session/page/projection thresholds and explicit degraded-history behavior.

#### 0C. Tailscale ingress spikes

- [ ] Verify Serve identity headers on supported Tailscale versions and identity classes.
- [ ] Verify incoming spoofed copies are stripped on the actual Serve path.
- [x] Document the initial single-user/local-host trust assumption for direct loopback bypass.
- [ ] Verify SSE flush behavior, reconnect, idle timeouts, and heartbeats through Serve.
- [ ] Verify MagicDNS navigation and exact browser origins.
- [x] Verify `tailscale status --json` fields used by discovery and version-tolerant parsing.

#### 0D. Typed SDK versus RPC process model

- [x] Keep a repeatable, credential-free integration spike that creates at least two concurrent Pi SDK runtimes with the enabled repository-owned local extension profile.
- [x] Prove per-runtime loader, event-bus, extension-runner, session, in-place reload, whole-host replacement, and disposal behavior across repeated fresh processes.
- [x] Characterize `session.reload()` listener/resource ownership deterministically; distinguish Pi host behavior from extension cleanup defects.
- [x] Retain complete host-bundle/event-bus rotation as a temporary workaround for [earendil-works/pi#7193](https://github.com/earendil-works/pi/issues/7193) while the minimal fix is upstreamed; keep the checked-in cleanup MRE as the gate for removing the `session.reload()` ban after that fix lands.
- [x] Exercise whole-runtime replacement with a fresh loader and event bus as the candidate reload boundary.
- [x] Exercise idle unloading and reopen persisted sessions without replaying uncertain prompts.
- [x] Exercise successful `AgentSessionRuntime` new/switch/fork/import replacement paths with fresh bindings, fixed-bus leak characterization, per-replacement bus rotation, and sibling isolation; retain destructive-failure injection as a Phase 5 gate.
- [x] Complete a design-complexity comparison of typed SDK host/direct history access against RPC framing, correlation, projection, and history-index layers; retain representative fidelity/size fixtures in Phase 0B.
- [x] Measure startup latency, RSS, active handles, idle disposal, and failure blast radius at representative session counts 1, 4, and 8.
- [x] Define and exercise an exact daemon extension profile that retains Agentflow/background managed capabilities while excluding TUI-only, standalone-server, package/project, notification, and Herdr integrations.
- [x] Verify handled extension-command and ordinary preflight-rejection ordering; document that handled-command preflight follows handler completion and retain accepted-model callback-before-settlement coverage as a Phase 3 gate.
- [x] Verify the exact profile through public SDK `rpc`-mode bindings by calling Agentflow status and launching/stopping/inspecting a background job.
- [x] Record the typed in-process SDK decision and update process-dependent plan and architecture sections; retain a host-neutral process-isolated worker migration path.

Exit criteria:

- no unresolved blocker in shared package installation or Serve streaming/identity;
- the process-model decision is supported by repeatable fixtures rather than one-off inspection;
- explicit hard bounds exist before session-host/API implementation.

### Phase 1 — package skeleton and fake-host contract

- [x] Create daemon package, lockfile, strict TypeScript config, formatting, lint, typecheck, and test scripts.
- [x] Add validated configuration for:
  - loopback listener;
  - approved roots;
  - role mapping;
  - exact managed extension paths and supported Pi version;
  - loaded-host, memory, queue, history, and rate limits;
  - idle-unload policy;
  - persistence path;
  - discovery limits;
  - supported Tailscale versions.
- [x] Define daemon-owned `SessionHost` state, command, admission, event, transition, bounded-history, and disposal contracts with no Pi SDK types in public signatures.
- [x] Build a deterministic fake `SessionHost` supporting:
  - load/readiness and state;
  - prompt accepted/rejected/handled separately from completion;
  - streaming messages/tools and settled state;
  - queues, abort, dialogs, model, thinking, and compaction;
  - delayed admission and ambiguous host loss;
  - switch/new/fork/clone/import;
  - unload, replacement, restart, and failed disposal.
- [x] Build the SDK bundle factory with independent settings/model/loader/event-bus ownership and exact loaded-path assertions.
- [x] Build balanced host subscriptions/provider bindings and idempotent full-bundle disposal.
- [x] Verify the daemon can run from a clean workspace install without importing the standalone `web-ui` extension.

Exit criteria:

- host/admission/lifecycle primitives are exhaustively testable without a model request;
- SDK types cannot escape the adapter boundary and resource exhaustion fails predictably.

### Phase 2 — one-host local registry

#### 2A. Launch policy

- [x] Accept only root alias plus relative path.
- [x] Reject absolute paths, `..`, missing directories, symlink escapes, and prefix-confusion paths.
- [x] Canonicalize with `realpath` and component-aware root containment.
- [x] Keep project trust separate from cwd approval; initially require prior local/admin trust.
- [x] Pass only the canonical cwd and validated session target into the SDK bundle factory.
- [x] Disable automatic extension/package/project discovery and assert the exact loaded profile.
- [x] Keep project trust separate from cwd approval and expose no generic trust prompt remotely.

#### 2B. Launch state machine

- [x] Implement `unloaded`, `loading`, `ready`, `running`, `transitioning`, `unloading`, `restarting`, `stopping`, `stopped`, and `failed` states.
- [x] Allocate stable launch ID and new host epoch on load/reopen.
- [x] Treat successful bundle creation, exact-profile binding, diagnostics check, and session identity verification as readiness.
- [x] Verify resumed session ID/file before publishing ready.
- [x] Keep commands fenced until readiness and reconciliation finish.
- [x] Dispose partially created bundles on startup failure without touching sibling hosts.
- [x] Unload an idle host under capacity policy and reopen it with fresh objects, no pending messages, no `agent_start`, and no replay.

#### 2C. Basic local API

- [x] Implement bounded local-only host, roots, launch, list, detail, and stop routes.
- [x] Return stable status and generation without exposing credentials, environment, or raw diagnostics.
- [x] Keep authentication test-only/local during this phase; do not expose remote mutation yet.

Exit criteria:

- one local managed launch can load, report ready, remain alive without a browser, unload/reopen, stop gracefully, and fail closed.

### Phase 3 — typed SDK adapter and command admission

#### 3A. Adapter boundary

- [x] Keep Pi SDK consumption inside the private `SdkSessionHost` adapter implementation and its complete `sdk-bundle.ts` object owner.
- [x] Map daemon-owned validated command unions directly to public `AgentSession`/`AgentSessionRuntime` methods.
- [x] Subscribe once to the current session and rebind atomically after replacement.
- [x] Bound pending admissions, command deadlines, and completed replay records.
- [x] Return daemon DTOs only; never expose raw SDK state, events, extensions, or managers.

#### 3B. Admission and interrupt paths

- [x] Ordinary path: one mutation awaiting authoritative admission at a time.
- [x] Interrupt path: dialog response/cancel, abort, retry cancellation, lease revocation, unload, and lifecycle stop.
- [x] Start `session.prompt()` without awaiting eventual completion and answer only from exactly-once preflight acceptance/rejection.
- [x] Fence admission during abort, transition, unload, restart, and reconciliation.
- [x] Bound queue count/bytes per launch and principal.

#### 3C. Browser command surface

- [x] Implement prompt, steer, follow-up, and abort.
- [x] Implement command discovery from the bound extension/resources and canonical slash execution through `session.prompt()`.
- [x] Implement typed model/thinking/compaction and safe session operations incrementally.
- [x] Do not expose arbitrary SDK tool execution, session paths, environment, loader configuration, or export paths initially.
- [x] Require browser command ID, generation, and authoritative admission response.
- [x] Persist/retain only bounded idempotency metadata; never retry ambiguous acceptance.
- [x] Distinguish accepted/queued/handled from later failed/completed/settled events.

Implementation notes:

- The shared `SessionCommandSchema` and command/error response envelopes are used unchanged for prompt, steer, and follow-up. Model and thinking use the shared bounded capability, strict command union, and dedicated response envelope from Phase 5C of the Web UI plan, mapped to typed SDK host operations on the same explicit command route. Abort and compaction retain the closed daemon-owned control envelope until their shared profiles are designed.
- One per-launch controller provides first-in, first-out ordinary admission, a bypassing interrupt lane, per-launch/per-scope count and UTF-8 byte bounds, and generation fencing. Replay metadata stores hashes and bounded public results rather than command content; after 4,096 unique IDs the epoch rejects new work instead of forgetting an accepted ID.
- The pinned extensions currently register only TUI dashboard commands. Bundle readiness asserts that exact command profile, discovery advertises only an explicit browser-safe allowlist (currently empty), and known unsupported slash commands are rejected before SDK dispatch. Ambient smoke commands, including reload, fail readiness as profile drift.
- SDK prompt preflight settles admission independently from the lifecycle-owned eventual task. Stop/abort cancel late acceptance, manual compaction, and active runs; disposal waits under a deadline for all owned SDK operations and fails closed rather than publishing stopped while work remains.

Exit criteria:

- concurrent browser requests cannot reorder ordinary mutation admission;
- prompt admission is not confused with completion, and dialog cancellation/abort cannot deadlock behind an ordinary operation.

### Phase 4 — projection and daemon-served session UI

#### 4A. Live projection

- [x] Reduce typed SDK session events into shared browser DTOs.
- [x] Treat `agent_settled`, not `agent_end`, as fully idle.
- [x] Maintain bounded live assistant/tool overlays.
- [x] Reconcile durable `SessionManager` entries after turns and uncertainty boundaries.
- [x] Project broker-owned queue rows with stable item versions/capability and keep native SDK queue rows read-only.
- [ ] Project retry, compaction, cost, and remaining metadata state.
- [x] Validate all outbound data against shared runtime schemas.
- [x] Replace unsupported/oversized data with explicit placeholders.

Implementation note: the daemon-local live projection now covers bounded queue reads, negotiated model/thinking controls, model/thinking changes, and running/settled state. Model identity changes rotate the host and registry command epoch, fence queued old-capability commands, and fail accepted old-epoch run commands before publishing the reset so later settlement cannot be attributed to the replacement epoch. Durable append publication validates the candidate retained snapshot and envelope transactionally, reserves deterministic headroom for all bounded volatile state, falls back to a bounded latest-window reset, and reconciles every SDK message or durable-change boundary. Accepted and queued commands are retained as a bounded run-level set and completed exactly once at authoritative settlement from the final run outcome. Projection operation failures and bounded reconciliation exhaustion fence the registry generation and close attachments. Retry detail, compaction detail, authoritative cost, current working-word, and filesystem metadata remain unavailable in the shared core envelope/host-neutral read boundary, so the combined metadata criterion remains unchecked.

#### 4B. SSE operation stream

- [x] Serve bounded initial/reset snapshots.
- [x] Append durable entries once and replace live/status operations.
- [x] Attach generation and monotonic revision to every operation.
- [x] Maintain a bounded replay ring where useful.
- [x] Coalesce replaceable operations for slow clients.
- [x] Reset on lost durable continuity; disconnect clients that cannot accept a reset.
- [x] Ensure browser behavior cannot backpressure SDK session/tool event processing.

#### 4C. Managed SPA

- [x] Bundle shared client/styles into daemon-owned assets.
- [x] Implement `ManagedSessionTransport` against daemon APIs.
- [x] Mount shared session view inside a minimal machine/session shell.
- [x] Add local session list, launch form, attach, stop, and reconnect states.
- [x] Preserve shared session UI DOM/accessibility behavior.
- [x] Add open-in-new-tab/deep links to local sessions.
- [ ] Add the host-owned installable-app manifest/icons and dependency-free pass-through/static-asset-only service worker specified by the Web UI plan.
- [ ] Keep authenticated HTML, API/commands, SSE, transcript/history, attachments, and private images out of Cache Storage; reconnect and reset authoritatively after mobile suspension.
- [x] Set strict CSP, `nosniff`, no-referrer, and `frame-ancestors 'none'`.

Implementation note: the first managed slice serves a committed, freshness-checked daemon bundle at `/_pi/`, uses canonical `/_pi/sessions/:launchId` deep links, and mounts the shared client without changing its transcript or composer DOM. The managed transport implements validated SSE, prompt admission, and ambiguous-delivery behavior. Until their owning phases land, older-history paging and completion reject locally without issuing a request, image references resolve to no URL, and the shell states these limits explicitly rather than fabricating capabilities. Static routing is a positive allowlist so missing assets and API routes never fall through to HTML; fixed-name assets and authenticated surfaces remain `no-store`. Installability, mobile suspension coverage, and any Cache Storage allowlist remain open.

#### 4D. Managed pending-input broker

Implemented broker adapter (2026-07-31):

- `SdkSessionHost` owns a daemon-local ordered broker for browser-originated busy steer/follow-up text. It admits rows outside Pi, advertises the shared `pendingInputBroker` capability, preserves stable item IDs/item versions, supports strict edit/remove commands, and releases one steer at `turn_end` or one follow-up at `agent_end` through awaitable public SDK methods.
- Native Pi queue rows remain projected as `editable: false`; they are never targeted by browser mutations. Host replacement, unload, disposal, and failed release restore or explicitly fail broker-owned commands without replaying uncertain prompts.
- The daemon `/command` route accepts the shared queue mutation union with the existing generation/epoch/replay/security fences, and `ManagedSessionTransport` reuses its authoritative command-response/ambiguous-delivery behavior. Shared reducer/client fixtures remain host-neutral.

- [x] Add the daemon broker state machine, bounded text memory, stable IDs, item-version mutation fencing, release serialization, and failed-handoff restore.
- [x] Add SDK host lifecycle release, native queue read-only projection, transitions/disposal cleanup, API parsing/dispatch, managed browser transport, and unit coverage.
- [x] Retain and release bounded image-bearing broker payloads through the typed SDK; transcript image references/resolution remain owned by Phase 4E.

#### 4E. Binary image resources

- [ ] Project images as shared bounded references or explicit omission placeholders, never inline base64 in snapshots, operations, or history pages.
- [ ] Resolve opaque, non-authorizing image IDs through an authenticated same-origin per-launch endpoint with viewer authorization and generation/session checks.
- [ ] Keep projected JSON entry/page/frame limits independent from binary image resource-byte, count, dimension, pixel, resolver-state, and response-concurrency limits.
- [ ] Validate signatures, MIME, dimensions, and bounds before response; initially exclude SVG and unsupported animation.
- [ ] Send verified content type/length, `nosniff`, same-origin resource policy, and private revalidation or stricter caching without logging IDs, paths, URLs, or bytes.
- [ ] Bound resolver lifetime and unloaded-history behavior; return an explicit unavailable placeholder rather than loading or retaining unbounded image state.

Exit criteria:

- one local daemon-served browser can launch, view, prompt, stream, abort, unload/reopen, and stop a real SDK host without any extension-owned HTTP server;
- equivalent shared fixtures render the same session UI as standalone mode.

### Phase 5 — bounded history and session transitions

#### 5A. Bounded manager-backed history

- [ ] Read durable entries/tree state only through the `SessionHost` adapter.
- [ ] Slice and project only bounded history pages from the already loaded `SessionManager` state.
- [ ] Use opaque browser cursors bound to session identity, branch epoch, and next position.
- [ ] Return explicit degraded-history state for oversized sessions.
- [ ] Never forward an unbounded entries array directly to browsers.

#### 5B. Large and unloaded sessions

- [ ] Measure realistic session load RSS/time, entry count, line size, images, and page projection.
- [ ] Load an idle host on demand only under capacity policy and unload it after bounded history work.
- [ ] Bound concurrent history loads, file/session size, entry count, memory, and projected bytes.
- [ ] Keep Pi JSONL as source of truth and persist no duplicate transcript database.
- [ ] Add a disposable version-checked file-offset index only if measurements prove manager-backed paging/on-demand loading insufficient; keep the browser cursor contract unchanged.

#### 5C. Session transitions

- [ ] Implement typed new/switch/fork/clone/import operations with admission fencing.
- [ ] Honor Pi cancellation responses.
- [ ] Create fresh services/loader/model/event-bus/runner/subscriptions for every replacement and clear only the retired bus.
- [ ] Verify state/history/commands and exact extension profile before publishing a new session epoch.
- [ ] Publish one reset under the new generation.
- [ ] Conservatively reconcile after extension commands that may mutate session/runtime state.
- [ ] Prove sibling host identity/provider/storage state remains unchanged.

#### 5D. Reload and recovery replacement

- [ ] Until the upstream fix for [earendil-works/pi#7193](https://github.com/earendil-works/pi/issues/7193) lands and passes the checked-in MRE, define managed reload as idle-only complete host-bundle replacement and never call `session.reload()`; treat replacement of the session object as a temporary workaround.
- [ ] Require no streaming, compaction, pending messages, or unresolved dialog by default.
- [ ] Invalidate old generation, create/verify a fresh bundle from the last confirmed session, atomically swap, dispose the old bundle, clear its bus, and reset.
- [ ] Never replay volatile queues or uncertain prompts.
- [ ] Test failure at every create/bind/verify/swap/dispose/reconciliation boundary.

Exit criteria:

- browser memory/network remain bounded for large supported sessions;
- transitions never accept stale-generation work;
- reload and crash recovery share one tested replacement path.

### Phase 6 — managed authentication, roles, and leases

#### 6A. Ingress identity

- [ ] Bind daemon listener to loopback.
- [ ] Put one persistent Tailscale Serve endpoint in front of it; never Funnel.
- [ ] Parse/normalize supported Tailscale identity headers only under the documented local-host trust assumption.
- [ ] Deny missing, tagged, shared, or malformed identities unless local policy maps them explicitly.
- [ ] Document that loopback alone does not prevent another local process/user from forging headers.
- [ ] Before multi-user-host support, add and verify a non-spoofable ingress boundary or reject that deployment mode.

#### 6B. Authorization

- [ ] Map principals to viewer, controller, launcher, and operator roles.
- [ ] Enforce authorization on every route and mutation.
- [ ] Require exact external Origin on state changes.
- [ ] Use no mutating GETs, wildcard CORS, or origin reflection.
- [ ] Keep launch IDs/session IDs non-secret and non-authorizing.
- [ ] Add per-principal launch/mutation rate limits and bounded audit events without transcript content.

#### 6C. Controller lease

- [ ] Allow multiple viewers and one renewable controller lease per launch.
- [ ] Scope lease to principal, lease ID/epoch, launch, and generation.
- [ ] Recheck immediately before SDK invocation.
- [ ] Invalidate on generation change, expiry, authorization loss, explicit release, or daemon restart.
- [ ] Define visible takeover behavior without collaborative-editing complexity.

Exit criteria:

- remote mutation remains disabled until ingress, authorization, Origin, replay, generation, and lease tests pass;
- local trust limitations are explicit rather than overstated.

### Phase 7 — machine discovery and navigation

#### 7A. Presence

- [ ] Serve only kind marker, protocol version, daemon ID/boot/start time, canonical machine display/name, and fixed API base.
- [ ] Expose no sessions, cwd, users, models, roles, credentials, capabilities, or transcript data.
- [ ] Bound body and schema strictly.

#### 7B. Candidate discovery

- [ ] Run fixed `tailscale status --json` without a shell, under timeout/output cap.
- [ ] Tolerate unknown/missing fields and pin/test supported versions.
- [ ] Extract only canonical candidate MagicDNS names.
- [ ] Never accept browser-provided probe targets.
- [ ] Probe only fixed HTTPS presence paths with TLS validation and redirects disabled.
- [ ] Cap at 256 candidates, eight concurrent probes, 2–3 seconds each, and 4 KiB bodies initially.
- [ ] Single-flight/cache results for 10–15 seconds and poll from browser every 15–30 seconds.
- [ ] Return positive schema-valid results and generic failures.

#### 7C. Browser navigation

- [ ] Show discovered machine links and last successful observation.
- [ ] Keep manual host entry and cached last-known links.
- [ ] Navigate top-level or open a new tab to the selected daemon.
- [ ] Let the selected daemon independently authenticate and authorize the browser.
- [ ] Do not use iframes, forward seed identity, or proxy transcript/control traffic.

Exit criteria:

- a user can open any known daemon, discover peers, navigate to another machine, and independently attach there;
- discovery cannot become SSRF or authorization.

### Phase 8 — persistence and operations

#### 8A. Metadata persistence

- [ ] Persist owner-only metadata atomically:
  - daemon identity;
  - launch ID/creator;
  - root alias plus relative path/canonical validation data;
  - desired running/stopped state;
  - launch idempotency;
  - last confirmed session ID/file;
  - bounded timestamps/status.
- [ ] Do not persist leases, prompts, raw SDK events, tool output, credentials, or ambiguous commands for replay.

#### 8B. Restart recovery

- [ ] Revalidate roots, cwd, trust, and session identity on daemon restart.
- [ ] Do not adopt unknown extension-owned background processes or volatile runtime state.
- [ ] Keep desired-running launches unloaded until attach/policy requires them, then create a fresh idle host and resume only confirmed sessions.
- [ ] Mark interrupted/recovered state visibly.
- [ ] Never resume active model work or replay kickoff prompts automatically.

#### 8C. Capacity and service packaging

- [ ] Add loaded-host count, launch rate, RSS/event-loop, queue, history-load, idle TTL, and diagnostic limits.
- [ ] Package `systemd --user` and macOS LaunchAgent definitions.
- [ ] Test upgrade/restart, host sleep/wake, extension-owned process descendants, disk-full, malformed persistence, and cleanup.
- [ ] Decide whether active runs need a macOS power assertion only after measured sleep behavior.

Exit criteria:

- daemon restart and machine reboot produce bounded, understandable recovery without duplicate work;
- service packaging is reproducible on supported hosts.

### Phase 9 — dialogs, notifications, and optional fleet summaries

#### 9A. Standard SDK dialogs

Phase 1 behavior is prompt cancellation so unattended hosts cannot hang.

Enable browser answering only when:

- [ ] requests are scoped to launch, generation, daemon dialog request ID, principal/lease, and deadline;
- [ ] exactly one terminal response/cancel is possible;
- [ ] response/cancel uses the interrupt lane;
- [ ] timeout, disconnect, takeover, abort, restart, exit, and shutdown all clean up;
- [ ] late and duplicate responses are rejected;
- [ ] the daemon-owned SDK UI context cleans up every pending request in `finally` across replacement, unload, restart, and shutdown.

Managed hosts exclude Herdr, and `ctx.ui.custom()` remains unsupported generically.

#### 9B. Notifications

- [ ] Project settled, failed, pending-question, and host-unavailable as explicit bounded event operations with stable occurrence IDs; do not reconstruct them from snapshots or persist them as transcript/history.
- [ ] Retain events only in the bounded replay horizon, expire stale delivery, and preserve IDs across retransmission so reconnects and multiple tabs can deduplicate them.
- [ ] Request browser permission explicitly.
- [ ] Notify only when hidden/unfocused and suppress rather than defer an event when another visible/focused tab owns the session.
- [ ] Use the managed app's stable origin for permission and bounded receipt state.
- [ ] The installable manifest/app shell belongs to Phase 4C; defer push and closed-page notification delivery until required.

#### 9C. Optional simultaneous fleet summaries

- [ ] Add only if top-level machine navigation proves insufficient.
- [ ] Prefer browser-direct read-only summaries so target daemon authorizes the real browser principal.
- [ ] Use finite exact-origin CORS, `Vary: Origin`, bounded schemas, and no transcript/mutations.
- [ ] Do not let the seed proxy private summaries under machine identity.
- [ ] Evaluate Tailscale Service only for bootstrap/notification-origin stability.

## Security test matrix

Before remote mutation ships, cover:

- forged Tailscale headers on direct loopback and documented trust outcome;
- malformed/missing/tagged/shared identity;
- exact-Origin rejection and preflight behavior;
- role denial for every operation;
- stale generation and stale lease;
- duplicate browser command IDs;
- queue/body/header/entry/image/tool-output/history/loaded-host limits;
- absolute cwd, traversal, symlink escape, and root prefix confusion;
- arbitrary extension/package/tool/loader-config/env/session-path rejection;
- discovery redirects, malformed JSON/status, excessive peers, slow peers, and browser target injection;
- SDK adapter DTO validation, oversized projection, and extension diagnostics/path drift;
- slow/disconnected SSE clients;
- accepted prompt followed by daemon-wide fatal exit, reconnect, and no replay;
- reload/session transition races;
- secret/transcript omission from logs, audits, presence, URLs, and persistence.

## Parallel execution map

### Track A — shared UI contract

Phase 3 core schemas and fixtures are no longer a sequential blocker for daemon command admission or core projection. Coordinate later feature contracts with their owning Web UI/daemon phases and the final Web UI Phase 7 freeze:

- consume the draft core wire schemas and fixtures;
- implement the managed transport interface;
- add daemon producer parity tests;
- adopt later capabilities, images, providers, notifications, and degraded-history contracts only from their shared owning phases.

### Track B — host core

Can proceed against a fake `SessionHost` before shared UI is complete:

- configuration and root policy;
- host-neutral adapter and fake host;
- SDK bundle factory, registry, capacity, unload, and disposal;
- launch state and persistence primitives.

### Track C — typed control

Follows the host adapter/registry:

- preflight admission and interrupt paths;
- commands and replay protection;
- transition/bus-rotation/recovery semantics.

### Track D — projection/history

Can start with shared fixtures and captured typed SDK event/session traces:

- typed SDK event reducer;
- browser operations;
- manager-backed history limits and optional measured index fallback;
- daemon producer contract tests.

### Track E — ingress/discovery

Can proceed independently through local spikes:

- Serve identity/SSE validation;
- role/origin policy;
- presence/status probing;
- machine navigation.

### Sequential gates

1. No remote mutation before Track B/C, exact-profile capability tests, and auth security gates pass.
2. No large-session claim before bounded history behavior passes.
3. No generic browser dialogs before daemon-owned exactly-once SDK UI cleanup exists.
4. No simultaneous fleet summary CORS before top-level navigation is evaluated in use.

## Deferred or excluded

- one CLI RPC child per launch is the measured fallback, not the initial implementation;
- process-isolated typed SDK workers remain deferred until fault/scale revisit conditions fire;
- arbitrary user/project/package extensions in managed hosts;
- child HTTP servers or reverse proxying `web-ui`;
- PTY/terminal emulation;
- direct imports from Pi extension runtime implementations;
- arbitrary browser-submitted loader config, extension paths, cwd paths, environment, shell, or session paths;
- central transcript proxy/registry without an explicit new product requirement;
- session iframes and cross-frame messaging;
- automatic replay after ambiguous outcomes;
- orphan adoption;
- multi-user collaboration semantics;
- containers/VMs until mutually untrusted workloads require them;
- cross-workspace deep imports that bypass declared package exports.

### Process-isolation revisit triggers

Move execution behind `SessionHost` to one process-isolated typed SDK worker per loaded launch if:

- a runtime can block, crash, call `process.exit`, or exhaust the daemon often enough to harm usability;
- arbitrary third-party, package, or project extensions become a managed requirement;
- measured realistic concurrency exceeds the loaded-host RSS/event-loop budget;
- per-session hard kill, CPU/RSS accounting, or independent restart becomes required;
- native dependencies create unacceptable daemon-wide crash risk.

Use CLI RPC children only if a required capability cannot be hosted through the public typed SDK or as the fastest safe fallback. Browser, auth, persistence, and projection contracts must not change when crossing this boundary.

## Completion criteria

The initial daemon product is complete when:

- the daemon package installs, checks, and runs from a clean root workspace checkout;
- it consumes only public exports from `@dotfiles/pi-web-ui-client`;
- approved local roots can load, attach to, unload/reopen, replace, and stop bounded SDK session hosts;
- only `SessionHost` consumes Pi SDK types and the daemon exposes no raw SDK objects/events to browsers;
- the daemon-served SPA reuses the canonical session UI and supports bounded transcript streaming/history;
- prompt/steer/follow-up/abort/model/thinking and supported command/session operations have authoritative preflight admission semantics distinct from completion;
- reload and every session transition use verified complete host-bundle/event-bus rotation without prompt replay;
- Tailscale ingress, target-side roles, exact Origin, leases, and replay protection gate remote control;
- discovery finds compatible peers without becoming authorization or SSRF;
- top-level navigation reaches and independently authorizes the selected daemon;
- persistence/reboot recovery is bounded and does not adopt/replay uncertain work;
- security, slow-client, large-history, crash, transition, and cleanup tests pass;
- unsupported blocking dialogs cancel predictably until the daemon-owned exactly-once SDK UI bridge is implemented;
- daemon-wide fatal exit recovery, reconnect, generation reset, and the documented process-isolated-worker revisit triggers are tested.
