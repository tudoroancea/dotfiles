# Typed SDK hosting evaluation

## Status

Phase 0D selects multiple typed Pi SDK `AgentSessionRuntime` hosts inside the daemon for the initial product. The original one-`pi --mode rpc`-child-per-launch model remains the measured fallback and future isolation option, not the initial implementation.

This is a simple-first decision, not a commitment to keep every session in the daemon forever. The browser API and shared session UI must hide the internal host choice so a loaded session can later move to a process-isolated typed SDK worker without redesigning the product.

Evaluated against `@earendil-works/pi-coding-agent` 0.82.1.

## Why reconsider RPC children

The daemon, rather than the browser, is the sole controller in both designs. Direct SDK hosting can remove or reduce:

- child process startup and readiness negotiation;
- JSONL framing, line limits, parsing, and response correlation;
- RPC command translation;
- reconstruction of typed Pi state from serialized events and queries;
- the unbounded `get_entries` response and a second daemon-side history index;
- several ambiguous child-write/response failure boundaries.

It also gives direct typed access to:

- `AgentSession` state, events, queues, model, thinking, and compaction;
- `SessionManager` entries, tree, branch, and persisted session identity;
- `AgentSessionRuntime` new/switch/fork/import replacement flows;
- `session.reload()` and `session.navigateTree()`;
- resource diagnostics, extension runners, commands, and providers.

The typing is a primary advantage. Browser input should validate into daemon-owned command unions, then map directly to public Pi SDK methods. Runtime validation remains necessary at browser, persistence, and projected DTO boundaries, but an internal untyped RPC protocol is not needed in the SDK candidate.

## Dispatch and feature comparison

`AgentSession.prompt()` provides the canonical behavior that originally motivated RPC:

- extension command execution;
- prompt-template and skill expansion;
- ordinary prompt submission;
- steer/follow-up queueing;
- preflight acceptance notification.

RPC `prompt` calls this same method. Therefore the SDK fixes the standalone extension API limitation, but it does not have different slash semantics from RPC.

Neither SDK `prompt()` nor RPC `prompt` is the TUI built-in slash dispatcher. Managed browser operations should remain structured. TUI-only settings, login, trust, copy, hotkeys, and selector commands are not generic browser slash commands.

In-place tree navigation is directly available through the SDK and absent as a typed RPC mutation. If RPC remains selected and this becomes important, contributing a generally useful typed operation upstream is preferable to maintaining a Pi fork.

Extension argument completion is not a current decision criterion.

## Browser UI boundary

Arbitrary `ctx.ui.custom()` components should not be serialized to the browser. Questionnaire interaction, Agentflow and background-process dashboards, and similar features should be rebuilt as explicit browser components backed by bounded provider DTOs and typed actions.

Standard `select`, `confirm`, `input`, and `editor` interactions can remain a generic fallback. Managed sessions run outside the interactive Herdr TUI, so Herdr pane-state reporting is not part of the daemon host requirement.

## Reliability tradeoff

### RPC child advantage

A per-launch process provides accidental fault containment:

- a synchronous extension loop blocks one launch rather than the daemon;
- Node OOM, native crashes, fatal assertions, or `process.exit()` affect one child;
- the daemon can terminate a wedged process group;
- process-global extension state is naturally separated;
- RSS and descendants can be accounted per launch.

It is not a security sandbox against intentionally malicious same-user code. Pi extensions and the daemon run as the same Unix account.

### SDK mitigation strategy

Fatal failures are expected to be uncommon, and the first useful daemon can favor simplicity over maximum scale. Mitigations are:

- cap simultaneously loaded sessions and unload idle ones;
- persist only confirmed session identity and never volatile prompt queues;
- reopen idle sessions on demand with fresh runtime objects;
- let `systemd --user` or LaunchAgent restart the whole daemon after exit or OOM;
- make browser generation changes and reconnect automatic;
- use an external watchdog if event-loop blockage must trigger restart;
- never replay a prompt whose acceptance is uncertain;
- retain a migration path to one process-isolated SDK worker per loaded session.

A daemon restart can restore confirmed idle sessions. It cannot safely resume active model work or replay ambiguous commands.

## Repeatable SDK spike

Canonical fixtures:

- `agent/extension-tests/test/sdk-multisession.test.ts`
- `agent/extension-tests/test/fixtures/sdk-multisession-worker.mjs`

The ordinary extension integration suite runs the worker in three fresh Node processes and compares normalized semantic results. The test is credential-free and uses a strict environment allowlist with disposable HOME, XDG, npm, Claude, session, and artifact paths. It loads the enabled repository-owned local extension profile; ignored machine-local npm/git Pi package stores are intentionally excluded so a clean checkout remains reproducible.

The worker recursively snapshots metadata for the real local extension tree before and after each run, checks repository status as supplemental evidence, removes its temporary root, and asserts no extension/disposal errors, unhandled rejections, child-process handles, active requests, background jobs, or unclosed background runtime owners remain.

### Concurrent runtime results

Two runtimes in one Node process successfully used distinct:

- sessions and extension runners;
- resource loaders;
- model and settings services;
- event buses;
- background-process runtime ownership.

Reload/replacement of runtime A left runtime B's session and service object identities, loaded extension list, diagnostics, model/provider catalogs, provider snapshots, and extension-owned disposable storage unchanged.

### Idle unload and reopen

The fixture creates a normally flushed settled persistent session without a model request, loads it into an idle SDK host, disposes the complete runtime and bus, and reopens it in a fresh host.

The reopened host retains the session ID/file, name, entries, marker, leaf, and messages. It has fresh session/services/loader/model-runtime/event-bus/extension-runner objects, is idle, has no pending messages, and emits no `agent_start`. This supports idle unloading as a resource-pressure control.

### Session replacement and event-bus ownership

`AgentSessionRuntime.newSession()`, `switchSession()`, `fork()` in both fork and clone positions, and `importFromJsonl()` all create fresh sessions, services, resource loaders, and extension runners and correctly rebind session extensions. They leave a sibling runtime unchanged.

They are not safe when the runtime factory reuses one externally owned event bus: each replacement leaves the old Agentflow and background provider listeners registered. The measured provider registrations grow from 2 to 4, 6, 8, 10, and 12 across new, switch, fork, clone, and import. Disposal still leaves all 12 registrations, crossing Node's default listener-warning threshold.

The candidate mitigation was exercised on successful replacement paths: create a fresh event bus inside every runtime-factory invocation, bind the replacement session, retire the previous complete bundle, and clear only the retired bus. The active bus stays at exactly the expected two providers after every successful replacement, each retired bus contains only its own two stale listeners before clearing and zero after clearing, and the sibling remains unchanged.

This does not prove rollback. `AgentSessionRuntime` tears down the current session before creating its replacement, so creation or binding failure is destructive. The adapter must keep candidate bus/bindings private until the runtime operation succeeds, clean the candidate on error, move the launch to a fenced failed/recovery state, and never claim that the old session remains usable. Phase 5 injects failure at create, load, bind, verify, dispose, and reconciliation boundaries.

Therefore the event bus is session-host-bundle state, not daemon-global state. Managed reload and every runtime session replacement rotate the complete loader/services/event-bus/runner/subscription bundle. `session.reload()` remains forbidden.

### Reload listener accumulation

Provider discovery reports exactly:

| State          | Registrations |
| -------------- | ------------: |
| Initial        |             2 |
| After reload 1 |             4 |
| After reload 2 |             6 |

The providers are one additional Agentflow and background registration per reload. The result repeats across fresh processes.

`session.reload()` does emit `session_shutdown` and replace the extension runner. The leak occurs because `pi.events.on()` subscribes directly to an externally owned shared event bus, subscriptions are not scoped to the extension runtime, and Pi 0.82.1 does not invalidate the old runner before replacing it. Disposing the session also leaves those listeners on the old bus. Clearing the discarded bus removes them, and constructing a whole host with a fresh loader/bus restores exactly one registration per provider.

See [`PI_EVENT_BUS_RELOAD_MRE.md`](./PI_EVENT_BUS_RELOAD_MRE.md) for the upstream minimal reproduction.

Until Pi or every affected extension provides balanced cleanup, managed reload must replace the complete session-host bundle and clear/discard its bus rather than repeatedly call `session.reload()`.

## Is an upstream Pi fix worthwhile?

Yes. `pi.events` is part of `ExtensionAPI`, Pi already has an `ExtensionRunner.invalidate()` stale-context mechanism, and the shared event bus may be externally supplied. Requiring every extension to remember and manually dispose every `pi.events.on()` subscription is an easy lifecycle footgun. Pi 0.82.1 also fails to invoke that invalidation mechanism on the reproduced reload path.

Pi can fix this generically by wrapping `pi.events.on()` per loaded extension/runtime, retaining its unsubscribe callbacks, and invoking them during runner invalidation after shutdown. Reload, normal disposal, and session replacement must all invalidate the discarded runner. Pi must not clear the entire shared bus because the host or sibling runtimes may own unrelated listeners.

Our own extensions can still use explicit cleanup defensively, but that does not replace the value of an upstream ownership guarantee.

## Exact managed extension profile

The initial managed profile uses `noExtensions: true` with exactly these explicit repository-owned paths:

- `agent/extensions/agentflow/src/index.ts`
- `agent/extensions/background-processes/src/index.ts`

It excludes auto-discovered global/project extensions, optional npm/git packages, `web-ui`, boxed editor/header/footer/status UI, questionnaire TUI, notification/focus handling, Herdr, automatic session naming, tool-selector UI, and diagnostic commands. Built-in coding tools remain daemon policy; the measurement fixture disables them only to isolate host overhead.

The SDK host binds extensions in public `rpc` mode with daemon-owned UI and command actions, not `json` mode. A credential-free capability probe calls Agentflow status, launches a background job, stops it through the extension tool, and reads its final status. This closes the mode-compatibility concern: background-process tools intentionally reject `json` and `print`, but work through the SDK with `rpc` bindings without importing `runRpcMode`.

Optional package/project extensions remain disabled until separately audited for multi-runtime lifecycle, process-global state, UI behavior, and fatal-failure risk.

## Plumbing and history comparison

Both candidates still need browser authentication, authorization, leases, replay protection, bounded projection, SSE backpressure control, generation fencing, and a daemon-owned admission scheduler.

The SDK candidate removes the RPC-only layers:

- child process startup/readiness and process-group supervision;
- strict JSONL decoding, line limits, protocol desynchronization handling, and stderr draining;
- request-ID allocation, response correlation, and stdin writer locking;
- command serialization and reconstruction of typed Pi state from responses/events;
- an unbounded `get_entries` transfer and duplicate daemon-side parsing/index pressure for a loaded session.

The SDK adapter maps validated daemon command unions directly to public typed methods and reads durable entries/tree state from `SessionManager`. Browser history pages and projected payloads remain bounded; direct access does not permit forwarding the full entry array or remove degraded-history limits. A disposable file index is deferred unless large-session measurements prove that slicing the already loaded manager state or loading an idle host on demand is insufficient.

The RPC candidate retains stronger per-launch failure containment but requires all of the removed layers plus fake-child and protocol-boundary tests.

## Startup, memory, handles, and blast radius

`agent/extension-tests/test/fixtures/sdk-rpc-process-model-worker.mjs` measures counts 1, 4, and 8 with the exact two-extension profile, disposable credential-free directories, no model requests, bounded stderr, and complete cleanup. One observed macOS/Node 26.5 run produced:

| Hosts | SDK startup | SDK process RSS before → ready | RPC startup | Sum of RPC child RSS |
| ----: | ----------: | -----------------------------: | ----------: | -------------------: |
|     1 |      382 ms |                  160 → 283 MiB |      414 ms |              218 MiB |
|     4 |   7 ms warm |                  283 → 284 MiB |      541 ms |              880 MiB |
|     8 |  13 ms warm |                  284 → 290 MiB |      585 ms |            1,738 MiB |

The SDK 1-host row includes cold module/extension loading; later rows add warm runtimes in the same process. RPC rows start fresh children concurrently. These are guardrail measurements, not statistically stable performance claims: the workload uses in-memory empty sessions and disables all tools, V8 retains allocated RSS after disposal, and active `ChildProcess` handle snapshots can lag closed children. The repeatable fixture therefore asserts topology, positivity, readiness, no final child handles, and cleanup rather than brittle timing or RSS thresholds.

The evidence is sufficient without a current concurrency SLA: SDK incremental warm-host cost is materially smaller in this bounded empty-session profile, while RPC costs roughly one full Node/Pi process per loaded session. Phase 1 must set an initial loaded-host cap and repeat cold/warm medians with realistic tools and session sizes before release.

The fatal-failure probe deliberately registers `/crash` calling `process.exit(42)`. With two SDK runtimes, the hosting process exits and both are lost. With two RPC children, only the targeted child exits and its sibling still answers `get_state`. This is the accepted initial tradeoff, mitigated by the exact trusted profile, loaded-host caps, external OS supervision, generation reset/reconnect, confirmed-idle persistence, and no prompt replay.

## Prompt admission

A handled extension command invokes SDK `preflightResult(true)` exactly once, but Pi 0.82.1 invokes it only after the extension command handler completes; the fixture records `handler-start`, `handler-end`, `preflight:true`, then prompt resolution. This matches RPC's “handled immediately” response semantics but is completion-bound for extension commands. An ordinary prompt rejected for missing model authentication invokes `preflightResult(false)` exactly once.

For ordinary model prompts, the daemon must start `session.prompt()` without awaiting eventual model completion, publish authoritative admission only from preflight, and report later failure or settlement through events. A credential-free accepted-model fixture is still an implementation gate. The daemon must not assume extension-command preflight precedes handler side effects.

## Required initial safeguards for an SDK daemon

1. One independent settings/model/resource-loader/event-bus bundle per loaded session.
2. A daemon-specific extension profile rather than the full TUI/standalone profile.
3. Exclude or centralize standalone `web-ui` serving and Tailscale ownership.
4. Exclude terminal notification/focus integrations and Herdr pane reporting.
5. Rebuild rich extension UI as shared web components and provider DTOs.
6. Persist confirmed Pi session identity; never persist volatile queues for replay.
7. Unload idle sessions under session-count and memory policy.
8. Reopen unloaded sessions with fresh runtime objects and a new browser generation.
9. Replace the whole runtime/loader/bus for managed reload until scoped event-bus cleanup is available and verified.
10. Supervise the daemon externally and make clients reconnect across daemon boot/generation changes.
11. Bound transcript projection, browser queues, images, tool output, logs, and loaded runtime count.
12. Preserve a host-neutral session adapter so process-isolated SDK workers remain an incremental future change.

## Decision and remaining implementation gates

The Phase 0D decision is **typed in-process SDK hosting for the initial daemon**. No remaining evidence gap is process-model blocking under the exact-profile, trusted-code, bounded-concurrency assumptions.

The following are implementation/release gates rather than reasons to postpone the decision:

1. Keep all Pi SDK types behind a host-neutral `SessionHost` adapter shared by fake, in-process, and future worker implementations.
2. Repeat cold/warm RSS and latency measurements with realistic tools, persisted sessions, and explicit loaded-host limits.
3. Test OS-supervised daemon restart, persisted launch reconciliation, browser reconnect, generation reset, and absence of prompt replay once the daemon skeleton exists.
4. Exercise accepted ordinary prompts, callback-before-settlement ordering, queued steer/follow-up, post-acceptance failure, abort, and replacement fencing with a model fixture.
5. Keep complete host-bundle rotation as the permanent boundary unless an installed Pi version passes the scoped event-bus reload MRE.
6. Re-run the exact-profile, replacement, capability, admission, disposal, and failure fixtures for every Pi upgrade.

## Revisit conditions after an SDK decision

Move session execution to process-isolated SDK workers if measurements or operation show that:

- one runtime can block or exhaust the daemon often enough to harm usability;
- target concurrency exceeds safe in-process memory limits;
- extension profiles cannot be made multi-runtime safe;
- per-session hard termination or accounting becomes a product requirement;
- native dependencies create unacceptable daemon-wide crash risk.

The browser transport, authorization, projections, and shared UI should not change when crossing that boundary.
