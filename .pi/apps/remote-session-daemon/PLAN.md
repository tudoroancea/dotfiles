# Remote Session Daemon Plan

## Scope and source of truth

This plan owns the machine-level daemon and managed cross-machine dashboard backend. It is intentionally separate from the Pi extension plan:

- session UI and standalone extension: [`../../agent/extensions/web-ui/PLAN.md`](../../agent/extensions/web-ui/PLAN.md);
- architecture, diagrams, and security rationale: [`../../agent/extensions/web-ui/docs/RPC_FIRST_REMOTE_DASHBOARD.md`](../../agent/extensions/web-ui/docs/RPC_FIRST_REMOTE_DASHBOARD.md);
- Pi RPC capability analysis: [`../../agent/extensions/web-ui/docs/SLASH_COMMAND_DISPATCH.md`](../../agent/extensions/web-ui/docs/SLASH_COMMAND_DISPATCH.md);
- migration into the dedicated repository: [`../../../PI_SETUP_REPO_MIGRATION_PLAN.md`](../../../PI_SETUP_REPO_MIGRATION_PLAN.md) before extraction, then repository-root `MIGRATION_PLAN.md` while migration is in progress.

The daemon is a root-workspace application and later a per-machine user service. It is not a Pi extension and must never be placed under `agent/extensions/`.

## Product objective

On each enrolled machine, run one daemon that lets an authorized tailnet user:

- discover reachable machines running compatible daemons;
- list approved roots and local managed sessions;
- launch or resume Pi in an approved directory;
- attach to a stable daemon-served session UI;
- prompt, steer, queue follow-ups, abort, change model/thinking, and invoke supported commands through canonical Pi RPC;
- survive browser disconnects, Pi child replacement, daemon restart, and machine sleep/reconnect without replaying ambiguous work;
- stop and recover managed sessions under explicit policy.

The daemon serves the reused session SPA itself. Managed Pi children do not run `web-ui` HTTP servers, and the dashboard does not use session iframes.

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
      process/
        supervisor.ts
        process-group.ts
        launch-state.ts
        recovery.ts
      rpc/
        jsonl-decoder.ts
        client.ts
        correlation.ts
        scheduler.ts
        commands.ts
        dialogs.ts
      projection/
        reducer.ts
        events.ts
        entries.ts
        history-index.ts
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
        fake-pi-child.ts
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

1. One daemon process per machine.
2. One `pi --mode rpc` child per managed launch.
3. Exactly one daemon parser for each child stdout and one writer abstraction for each child stdin.
4. Browser clients never see or write raw Pi RPC.
5. The daemon serves the SPA, API, SSE, and history endpoints directly.
6. `launchId` is stable routing metadata, never a credential.
7. Every mutation is authenticated, authorized, Origin-checked, generation-checked, replay-checked, bounded, and controller-lease-checked where required.
8. No command is automatically retried after an ambiguous acceptance outcome.
9. Browser slowness never blocks child stdout/stderr draining.
10. Pi session JSONL is transcript truth; daemon indexes are disposable.
11. Discovery proves reachability only; the selected daemon authenticates the browser again.
12. Remote launch/control is code execution as the daemon's Unix account; approved roots are not a sandbox.
13. Managed children set the marker that causes `web-ui` to open no listener.
14. Generic browser-driven dialogs remain disabled until a child-local Herdr lifecycle owner exists.
15. No session iframe, child reverse proxy, readiness FD, or extension reload bridge is introduced.

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
- RPC/session projection into shared DTOs;
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
| `processEpoch`              | Pi child                     | Changes on spawn/respawn                                |
| `sessionEpoch`              | Active Pi session/view       | Changes on new/switch/fork/clone or conservative reset  |
| `generation`                | Opaque client token          | Current process/session epoch combination               |
| `revision`                  | One generation               | Monotonic browser operation sequence                    |
| `sessionId` / `sessionFile` | Pi session                   | Transcript and recovery identity, not authorization     |
| browser `commandId`         | One principal/client request | Replay detection and authoritative response correlation |
| `leaseId` / `leaseEpoch`    | Controller lease             | Exclusive mutation authority                            |

## Process model

Spawn directly without shell or PTY:

```text
pi --mode rpc [--session <validated-session>] [fixed validated options]
```

```text
fd 0  RPC JSONL input, daemon-only writer
fd 1  RPC JSONL output, daemon-only parser
fd 2  bounded diagnostics, never protocol
```

Requirements:

- canonical approved cwd resolved by root alias plus relative path;
- curated environment and fixed allowlisted arguments;
- dedicated Unix process group;
- stdout/stderr draining begins immediately;
- strict LF-only framing with `StringDecoder`; do not use Node `readline`;
- hard line, pending-correlation, queue, stderr-ring, and process limits;
- protocol-invalid or oversized output fails the child closed;
- stdin EOF, graceful signal, deadline, and process-group termination are tested;
- browser disconnect never stops a child.

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
- [ ] Consume the shared package's frozen protocol version, generation/revision, snapshots/operations, history cursors, command responses, and provider capability DTOs.
- [ ] Define only daemon-owned API wrappers such as launch routing, host capabilities, roots, discovery, leases, and lifecycle responses.
- [ ] Verify independent clean install of daemon plus local shared dependency.
- [ ] Run daemon producer conformance against shared golden fixtures and expected reducer states without importing extension code.

#### 0B. RPC fidelity and bounds

- [ ] Build representative real-session fixtures covering messages, thinking, tools, custom entries, images, compactions, branches, model changes, retries, queues, and Agentflow/background output.
- [ ] Compare RPC events and `get_entries` with standalone projection output.
- [ ] Measure realistic and adversarial RPC line sizes.
- [ ] Measure initial and suffix `get_entries` response sizes.
- [ ] Define hard line/session thresholds and explicit degraded-history behavior.

#### 0C. Tailscale ingress spikes

- [ ] Verify Serve identity headers on supported Tailscale versions and identity classes.
- [ ] Verify incoming spoofed copies are stripped on the actual Serve path.
- [ ] Document the initial single-user/local-host trust assumption for direct loopback bypass.
- [ ] Verify SSE flush behavior, reconnect, idle timeouts, and heartbeats through Serve.
- [ ] Verify MagicDNS navigation and exact browser origins.
- [ ] Verify `tailscale status --json` fields used by discovery and version-tolerant parsing.

Exit criteria:

- no unresolved blocker in shared package installation, RPC fidelity, or Serve streaming/identity;
- explicit hard bounds exist before child/API implementation.

### Phase 1 — package skeleton and fake-child harness

- [ ] Create daemon package, lockfile, strict TypeScript config, formatting, lint, typecheck, and test scripts.
- [ ] Add validated configuration for:
  - loopback listener;
  - approved roots;
  - role mapping;
  - child command/path;
  - capacity and rate limits;
  - persistence path;
  - discovery limits;
  - supported Pi/Tailscale versions.
- [ ] Build a deterministic fake Pi RPC child supporting:
  - startup and `get_state`;
  - correlated responses and interleaved events;
  - prompt acceptance/rejection;
  - streaming messages/tools;
  - dialogs;
  - oversized/invalid lines;
  - delayed responses and ambiguous exit;
  - switch/new/fork/clone;
  - graceful/wedged shutdown.
- [ ] Implement strict LF JSONL decoder with UTF-8 chunk-boundary tests.
- [ ] Implement bounded stderr draining and diagnostics ring.
- [ ] Implement process-group start/stop primitives.
- [ ] Verify the daemon can run from a clean workspace install without the extension being imported at runtime.

Exit criteria:

- protocol and process primitives are exhaustively testable without launching real Pi;
- invalid framing and resource exhaustion fail predictably.

### Phase 2 — one-child local supervisor

#### 2A. Launch policy

- [ ] Accept only root alias plus relative path.
- [ ] Reject absolute paths, `..`, missing directories, symlink escapes, and prefix-confusion paths.
- [ ] Canonicalize with `realpath` and component-aware root containment.
- [ ] Keep project trust separate from cwd approval; initially require prior local/admin trust.
- [ ] Pass cwd through direct spawn, never a shell string.
- [ ] Use fixed validated Pi arguments and curated environment.
- [ ] Set the managed marker that disables `web-ui` server startup.

#### 2B. Launch state machine

- [ ] Implement `starting`, `ready`, `running`, `transitioning`, `restarting`, `stopping`, `stopped`, and `failed` states.
- [ ] Allocate stable launch ID and new process epoch on spawn.
- [ ] Treat first successful correlated `get_state` as readiness.
- [ ] Verify resumed session identity before publishing ready.
- [ ] Keep commands fenced until readiness and reconciliation finish.
- [ ] Handle child exit and startup timeout without leaking process descendants.

#### 2C. Basic local API

- [ ] Implement bounded local-only host, roots, launch, list, detail, and stop routes.
- [ ] Return stable status and generation without exposing credentials, environment, or raw diagnostics.
- [ ] Keep authentication test-only/local during this phase; do not expose remote mutation yet.

Exit criteria:

- one local managed launch can start, report ready, remain alive without a browser, stop gracefully, and fail closed.

### Phase 3 — RPC gateway and command scheduling

#### 3A. Correlation and single writer

- [ ] Allocate daemon RPC request IDs and correlate exactly one terminal response.
- [ ] Bound pending requests, response deadlines, and completed replay records.
- [ ] Implement a short byte-writer lock covering one complete JSONL record only.
- [ ] Never hold the writer lock while waiting for an RPC response.

#### 3B. Scheduler lanes

- [ ] Ordinary lane: one mutation awaiting authoritative response at a time.
- [ ] Interrupt lane: dialog response/cancel, abort, abort-bash/retry, and lifecycle stop.
- [ ] Allow interrupt writes while ordinary requests wait, without byte interleaving.
- [ ] Fence admission during abort, transition, restart, and reconciliation.
- [ ] Bound queue count/bytes per launch and principal.

#### 3C. Browser command surface

- [ ] Implement prompt, steer, follow-up, and abort.
- [ ] Implement `get_commands` discovery and canonical slash execution through RPC `prompt`.
- [ ] Implement typed model/thinking/compaction and safe session operations incrementally.
- [ ] Do not expose arbitrary RPC bash, arbitrary session paths, environment, Pi flags, or export paths initially.
- [ ] Require browser command ID, generation, and authoritative response.
- [ ] Persist/retain only bounded idempotency metadata; never retry ambiguous acceptance.
- [ ] Distinguish accepted/queued/handled from eventual model completion.

Exit criteria:

- concurrent browser requests cannot create competing stdin writers or reorder ordinary mutations;
- dialog cancellation and abort cannot deadlock behind an ordinary request.

### Phase 4 — projection and daemon-served session UI

#### 4A. Live projection

- [ ] Reduce RPC events into shared browser DTOs.
- [ ] Treat `agent_settled`, not `agent_end`, as fully idle.
- [ ] Maintain bounded live assistant/tool overlays.
- [ ] Reconcile durable entries after turns and uncertainty boundaries.
- [ ] Project queue, retry, compaction, model, thinking, cost, and running state.
- [ ] Validate all outbound data against shared runtime schemas.
- [ ] Replace unsupported/oversized data with explicit placeholders.

#### 4B. SSE operation stream

- [ ] Serve bounded initial/reset snapshots.
- [ ] Append durable entries once and replace live/status operations.
- [ ] Attach generation and monotonic revision to every operation.
- [ ] Maintain a bounded replay ring where useful.
- [ ] Coalesce replaceable operations for slow clients.
- [ ] Reset on lost durable continuity; disconnect clients that cannot accept a reset.
- [ ] Ensure browser behavior cannot backpressure child draining.

#### 4C. Managed SPA

- [ ] Bundle shared client/styles into daemon-owned assets.
- [ ] Implement `ManagedSessionTransport` against daemon APIs.
- [ ] Mount shared session view inside a minimal machine/session shell.
- [ ] Add local session list, launch form, attach, stop, and reconnect states.
- [ ] Preserve shared session UI DOM/accessibility behavior.
- [ ] Add open-in-new-tab/deep links to local sessions.
- [ ] Set strict CSP, `nosniff`, no-referrer, and `frame-ancestors 'none'`.

Exit criteria:

- one local daemon-served browser can launch, view, prompt, stream, abort, and stop a real Pi child without any child HTTP server;
- equivalent shared fixtures render the same session UI as standalone mode.

### Phase 5 — bounded history and session transitions

#### 5A. Bounded MVP history

- [ ] Permit full initial `get_entries` only under measured hard limits.
- [ ] Return explicit degraded-history state for oversized sessions.
- [ ] Use `get_entries(since=<known-id>)` only for expected bounded suffixes.
- [ ] Never forward unbounded entry responses directly to browsers.

#### 5B. Production history index

- [ ] Build a disposable version-checked index over the exact validated Pi session JSONL file.
- [ ] Record compact entry metadata, parent relationships, and file offsets.
- [ ] Bound file size, line size, entry count, memory, rebuild time, and concurrent indexes.
- [ ] Seek/project only bounded requested pages.
- [ ] Use opaque browser cursors bound to session identity, branch/index epoch, and next position.
- [ ] Rebuild or return degraded state on schema/version/mismatch.
- [ ] Keep Pi JSONL as source of truth and persist no duplicate transcript database.

#### 5C. Session transitions

- [ ] Implement typed new/switch/fork/clone operations with admission fencing.
- [ ] Honor Pi cancellation responses.
- [ ] Verify state/history/commands before publishing a new session epoch.
- [ ] Publish one reset under the new generation.
- [ ] Conservatively reconcile after extension commands that may mutate session/runtime state.

#### 5D. Reload and recovery replacement

- [ ] Define managed reload as idle-only process replacement.
- [ ] Require no streaming, compaction, pending messages, or unresolved dialog by default.
- [ ] Invalidate old generation, stop child, spawn with last confirmed session, verify `get_state`, and reset.
- [ ] Never replay volatile queues or uncertain prompts.
- [ ] Test crash at every stop/spawn/readiness/reconciliation boundary.

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
- [ ] Recheck immediately before RPC write.
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
- [ ] Do not persist leases, prompts, raw RPC events, tool output, credentials, or ambiguous commands for replay.

#### 8B. Restart recovery

- [ ] Revalidate roots, cwd, trust, and session identity on daemon restart.
- [ ] Do not adopt unknown orphan children.
- [ ] Start a fresh idle child for desired-running launches and resume only confirmed sessions.
- [ ] Mark interrupted/recovered state visibly.
- [ ] Never resume active model work or replay kickoff prompts automatically.

#### 8C. Capacity and service packaging

- [ ] Add child count, launch rate, memory, queue, history-index, idle TTL, and diagnostic limits.
- [ ] Package `systemd --user` and macOS LaunchAgent definitions.
- [ ] Test upgrade/restart, host sleep/wake, process descendants, disk-full, malformed persistence, and cleanup.
- [ ] Decide whether active runs need a macOS power assertion only after measured sleep behavior.

Exit criteria:

- daemon restart and machine reboot produce bounded, understandable recovery without duplicate work;
- service packaging is reproducible on supported hosts.

### Phase 9 — dialogs, notifications, and optional fleet summaries

#### 9A. Standard RPC dialogs

Phase 1 behavior is prompt cancellation so unattended children cannot hang.

Enable browser answering only when:

- [ ] requests are scoped to launch, generation, RPC request ID, principal/lease, and deadline;
- [ ] exactly one terminal response/cancel is possible;
- [ ] response/cancel uses the interrupt lane;
- [ ] timeout, disconnect, takeover, abort, restart, exit, and shutdown all clean up;
- [ ] late and duplicate responses are rejected;
- [ ] an audited extension or child/upstream hook owns balanced local `herdr:blocked` active/inactive events in `finally` across every path.

`ctx.ui.custom()` remains unsupported generically.

#### 9B. Notifications

- [ ] Project settled, failed, pending-question, and child-unavailable events.
- [ ] Request browser permission explicitly.
- [ ] Notify only when hidden/unfocused.
- [ ] Do not add PWA/push until closed-page delivery is required.

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
- queue/body/header/line/image/history limits;
- absolute cwd, traversal, symlink escape, and root prefix confusion;
- arbitrary executable/flag/env/session-path rejection;
- discovery redirects, malformed JSON/status, excessive peers, slow peers, and browser target injection;
- child protocol desynchronization and oversized output;
- slow/disconnected SSE clients;
- ambiguous prompt acceptance followed by child/daemon crash;
- reload/session transition races;
- secret/transcript omission from logs, audits, presence, URLs, and persistence.

## Parallel execution map

### Track A — shared UI contract

Coordinate with `web-ui` Phases 0–3:

- local dependency spike;
- wire schemas and fixtures;
- managed transport interface;
- producer parity tests.

### Track B — host core

Can proceed against fake child before shared UI is complete:

- configuration and root policy;
- JSONL parser/correlation;
- process groups and supervisor;
- launch state and persistence primitives.

### Track C — RPC control

Follows parser/supervisor:

- scheduler lanes;
- commands and replay protection;
- transition/recovery semantics.

### Track D — projection/history

Can start with shared fixtures and captured RPC logs:

- event reducer;
- browser operations;
- history limits/index;
- daemon producer contract tests.

### Track E — ingress/discovery

Can proceed independently through local spikes:

- Serve identity/SSE validation;
- role/origin policy;
- presence/status probing;
- machine navigation.

### Sequential gates

1. No remote mutation before Track B/C and auth security gates pass.
2. No large-session claim before bounded history behavior passes.
3. No generic browser dialogs before child-local Herdr ownership exists.
4. No simultaneous fleet summary CORS before top-level navigation is evaluated in use.

## Deferred or excluded

- embedding many `AgentSession` instances instead of process isolation;
- child HTTP servers or reverse proxying `web-ui`;
- PTY/terminal emulation;
- direct imports from Pi extension runtime implementations;
- arbitrary browser-submitted Pi flags, cwd paths, environment, shell, or session paths;
- central transcript proxy/registry without an explicit new product requirement;
- session iframes and cross-frame messaging;
- automatic replay after ambiguous outcomes;
- orphan adoption;
- multi-user collaboration semantics;
- containers/VMs until mutually untrusted workloads require them;
- cross-workspace deep imports that bypass declared package exports.

## Completion criteria

The initial daemon product is complete when:

- the daemon package installs, checks, and runs from a clean root workspace checkout;
- it consumes only public exports from `@dotfiles/pi-web-ui-client`;
- approved local roots can launch, supervise, attach to, and stop isolated RPC children;
- the daemon is the only RPC writer/parser and exposes no raw RPC to browsers;
- the daemon-served SPA reuses the canonical session UI and supports bounded transcript streaming/history;
- prompt/steer/follow-up/abort/model/thinking and supported command/session operations have authoritative admission semantics;
- reload/recovery use verified process replacement without prompt replay;
- Tailscale ingress, target-side roles, exact Origin, leases, and replay protection gate remote control;
- discovery finds compatible peers without becoming authorization or SSRF;
- top-level navigation reaches and independently authorizes the selected daemon;
- persistence/reboot recovery is bounded and does not adopt/replay uncertain work;
- security, slow-client, large-history, crash, transition, and cleanup tests pass;
- unsupported blocking dialogs cancel predictably until the Herdr-safe bridge is implemented.
