# Remote Pi Session Infrastructure Plan

## Objective

Enable an authorized user on a private Tailscale network to choose a machine and an approved folder, start or resume a Pi session there, and attach to the session-scoped UI in `.pi/agent/extensions/web-ui-simple/` without turning that extension into a process manager.

This is a follow-on architecture plan. It preserves the extension's standalone local/tailnet workflow while defining a separate managed mode for host-agent launches.

## Recommendation

Build two deliberately separate layers:

1. **Pi web UI extension** — remains inside one Pi process and owns one session's browser protocol, snapshot, streaming state, and controls.
2. **Per-machine host agent (the system-wide daemon)** — a small unprivileged Node/TypeScript service supervised by `systemd --user` on Linux or a LaunchAgent on macOS. There is one on each machine that should be remotely usable; no daemon centrally controls the other machines. Each local daemon validates launch requests, starts one `pi --mode rpc` subprocess per session, tracks its own children, and reverse-proxies stable session paths to each child's loopback web server.

Use Tailscale Serve to expose the host agent's single loopback listener over tailnet-only HTTPS. Do not expose every child's ephemeral port separately, and do not use Funnel.

```text
Browser
  ├─ dashboard.example.ts.net                 optional machine/session index
  └─ host-a.example.ts.net/_pi/
       │  Tailscale Serve: TLS + tailnet reachability + identity headers
       ▼
  host agent on 127.0.0.1:fixed-port
       ├─ launch/list/attach/stop API
       ├─ stable route /_pi/s/<launch-id>/
       ├─ RPC subprocess supervision
       └─ streaming HTTP/SSE reverse proxy
          + command POSTs and optional WebSocket upgrades
          ▼
       pi --mode rpc, cwd=/approved/project
             └─ session-scoped web UI extension on 127.0.0.1:ephemeral-port
```

A central dashboard may discover machines and iframe their stable per-host session URLs, but it should not proxy all transcript traffic by default. Direct cross-origin iframes preserve isolation: the dashboard can display a child UI but cannot read its session DOM or content.

The current `web-ui-simple` implementation already provides the correct session boundary: it starts an ephemeral loopback HTTP server in TUI/RPC mode, streams full active-branch snapshots over authenticated SSE, and closes its resources on session shutdown. Its extension-owned, per-session `tailscale serve` process is retained as a standalone convenience, not reused as the managed multi-session ingress.

## Daemon scope

The proposed host agent is the system-wide daemon originally envisioned: one long-lived daemon on a given machine, capable of starting Pi in any locally approved folder and managing all Pi children on that machine.

To make several machines remotely usable, install the same independent daemon on each one. They do not form a control hierarchy and no machine becomes a centralized authority over the others. A dashboard is only a client that knows how to contact those daemons.

Tailscale SSH remains useful for installation, upgrades, restarts, and emergency access, but it is not the normal browser API or process owner.

## Why Node/TypeScript rather than Python

Python can spawn Pi and parse JSONL, so the rough idea is technically viable. It is not the cleanest default here:

- The web UI extension, Pi APIs, RPC reference client, schemas, and existing infrastructure are TypeScript/Node-oriented.
- Shared TypeBox DTOs and protocol fixtures can be reused by the extension and host agent.
- Node can reverse-proxy HTTP and WebSocket traffic without introducing another runtime or schema implementation.
- Process spawning is not a reason by itself to add Python.

Use Python only if this must integrate with an existing Python control plane whose deployment, authentication, and supervision already solve most of the host-agent problem.

## Pi process model

### One subprocess per remote session

Launch normal Pi processes rather than embedding many `AgentSession` instances into one daemon. Process boundaries isolate:

- extension globals and reloads;
- cwd and inherited environment;
- crashes and memory growth;
- stdout/stderr and RPC framing;
- session lifecycle and signal handling.

Suggested launch shape:

```text
spawn("pi", ["--mode", "rpc", ...fixedValidatedArgs], {
  cwd: canonicalApprovedDirectory,
  env: curatedEnvironment,
  stdio: ["pipe", "pipe", "pipe", "pipe"]
})
```

The extra inherited file descriptor is a private readiness/control channel from the web UI extension to the host agent. RPC stdout must remain strict JSONL.

### RPC, not a PTY

Use `pi --mode rpc` because it already provides structured commands, events, request IDs, state queries, session switching, queues, aborts, and extension UI requests. A PTY would require terminal emulation, ANSI interpretation, resizing, prompt scraping, and hidden-dialog handling.

The host agent must implement Pi's documented LF-only JSONL parser with a `StringDecoder`; Node `readline` is not protocol-compliant because it also treats Unicode line separators as record delimiters.

### Command ownership

Avoid two independent controllers mutating one session.

- During startup, the host agent may select/resume the session and send at most one idempotency-tracked kickoff prompt.
- The current browser UI is read-only. When browser input is added, its HTTP command endpoints become the normal owner of prompt, steer, follow-up, abort, model, and thinking mutations and invoke Pi's session APIs inside the child.
- After the child reports ready, the host agent continues draining RPC stdout/stderr but does not issue competing conversation mutations.
- Stop is a host-agent lifecycle operation: request graceful shutdown/SIGTERM, wait for `session_shutdown`, then kill the process group after a deadline.

Until RPC extension dialogs are bridged to the browser, the host agent must consume `extension_ui_request` records and cancel unsupported blocking dialogs so an unattended child cannot hang. A later browser bridge must integrate balanced `herdr:blocked` events for every awaited human interaction.

## Host-agent API

Keep the API narrow and declarative. The browser must not submit executable paths, arbitrary Pi flags, environment variables, absolute cwd values, or shell strings.

Example operations:

- `GET /api/v1/host` — host identity, version, configured roots, capacity.
- `GET /api/v1/sessions` — authorized launch summaries.
- `POST /api/v1/sessions` — launch from `{ rootAlias, relativePath, resume?, name?, kickoff?, idempotencyKey }`.
- `GET /api/v1/sessions/:launchId` — status and attach URL.
- `POST /api/v1/sessions/:launchId/stop` — graceful stop.
- `GET /_pi/s/:launchId/*` — authenticated HTTP/WebSocket reverse proxy.

`launchId` is an opaque stable routing identifier, not an authorization credential.

## Folder selection and security boundary

Configure approved roots locally per host, for example:

```json
{
  "roots": {
    "work": "/Users/me/work",
    "scratch": "/Users/me/scratch"
  }
}
```

For each launch:

1. Accept `rootAlias` plus a relative path.
2. Reject absolute paths and `..` traversal.
3. Resolve the existing directory with `realpath`.
4. Verify it remains inside the canonical configured root using path-component-aware containment.
5. Reject missing directories and symlink escapes.
6. Pass the result through `spawn({ cwd })`; never interpolate it into a shell command.

This is only a **launch policy**, not a filesystem sandbox. Once Pi runs as that Unix account, its tools can access paths outside cwd. Mutually untrusted users or repositories require a dedicated OS account, container, or VM.

Pi's project trust remains independent. Remote launch authorization must not silently trust project-local extensions or configuration. Initially require trust to have been established locally or through a separate explicit administrative workflow.

## Tailscale ingress and authorization

The normal request path is browser HTTPS, not SSH:

```text
browser → https://machine-name.tailnet.ts.net → Tailscale Serve → local host agent
```

Tailscale does more than simplify registration:

- gives each machine private tailnet reachability and a stable MagicDNS name;
- terminates HTTPS for the machine's `*.ts.net` name;
- enforces grants/ACLs before traffic reaches the daemon;
- supplies authenticated caller identity metadata to the loopback backend.

Tailscale does **not** directly tell the browser which machines are running this particular daemon. Discovery is performed server-side by any known daemon: it enumerates its visible tailnet peers and probes a well-known Pi daemon presence endpoint, as specified below.

Operational rules:

- Bind the host agent and every child web server to `127.0.0.1`.
- Put one persistent Tailscale Serve HTTPS endpoint in front of the host agent.
- Restrict reachability with Tailscale grants/ACLs and perform application authorization in the host agent.
- Trust Tailscale identity or application-capability headers only on the loopback Serve hop; strip client-supplied copies before evaluating them.
- Account for shared external users and tagged devices when defining identity policy; presence of an identity header alone is not sufficient authorization.
- Do not use Tailscale Funnel.
- Verify WebSocket upgrade behavior and path rewriting against supported Tailscale client versions; current official Serve docs describe HTTP proxying but do not make those details an explicit compatibility guarantee.

Suggested roles:

- `viewer` — list and attach read-only.
- `controller` — prompt, steer, follow-up, and abort.
- `launcher` — start sessions within approved roots.
- `operator` — stop sessions and inspect host health.

Start with one renewable controller lease per session while allowing multiple viewers.

## Proxy and iframe model

The host agent maps a stable route such as `/_pi/s/<launchId>/` to the current ephemeral child endpoint. The mapping survives extension restarts within that launch.

Proxy behavior:

- support streaming HTTP/SSE without response buffering, ordinary command POSTs, and WebSocket upgrades only if a future child protocol uses them;
- apply equal or tighter body/header/buffer limits than the child extension;
- strip spoofable internal headers;
- inject a per-child internal capability plus normalized principal and role;
- return a clear temporary `503` while a child is reloading rather than routing to stale state;
- never place the internal capability in URLs, browser storage, logs, or iframe messages.

The child UI must use relative or configured-base-path URLs. The current `fetch("auth")` and `EventSource("events")` calls are already relative. In managed mode, framing is enabled only for the exact dashboard origin via CSP `frame-ancestors`; standalone mode remains non-frameable by default. Add `X-Content-Type-Options: nosniff` and a deliberate script CSP. The current CDN-loaded Preact, HTM, and Marked modules must either be allowed explicitly or, preferably before production remote control, bundled or served locally. Provide an “open in new tab” fallback.

Do not depend on the standalone fragment exchange and `SameSite=Strict` cookie inside a cross-origin dashboard iframe. Third-party-cookie restrictions make that unreliable. Managed requests instead use the proxy-to-child capability and injected principal/role; no credential is placed in iframe URLs, browser storage, or `postMessage`. Exact external `Origin` validation is required for state-changing browser requests and WebSocket handshakes. Ordinary document and SSE GETs may not carry a useful `Origin`, so they are authorized by the trusted proxy capability and normalized identity headers.

Avoid making a central dashboard a same-origin content proxy unless centralized transcript access is an explicit requirement. Such a proxy can read and control every session and therefore has a much larger security role.

## Client dashboard and Tailscale discovery

Tailscale runs below the browser at the operating-system network layer: when the user's device is connected to the tailnet, ordinary browser requests to authorized `https://*.ts.net` names are routed through Tailscale. The SPA does not need to embed a Tailscale networking SDK. There is currently no documented browser JavaScript SDK that lets a page inspect the local Tailscale client or enumerate peers. MagicDNS resolves names the application already knows; it does not enumerate names. LocalAPI, WhoIs, and `tailscale status` are native-side interfaces, while the REST API requires credentials that must never be shipped in the SPA.

### Selected discovery strategy: peer enumeration plus presence probes

Every daemon serves the dashboard and acts as a discovery broker. After the user opens any known daemon, that daemon:

1. runs the fixed command `tailscale status --json` with a timeout and output limit;
2. defensively extracts only visible peers' canonical MagicDNS names, tolerating unknown JSON fields because the documented JSON format is subject to change;
3. probes a fixed HTTPS endpoint such as `https://<peer>.<tailnet>.ts.net/_pi/daemon/v1/presence` with redirects disabled, bounded concurrency, and a short timeout;
4. accepts only a small schema-valid response with the exact `kind` marker and a supported protocol version; and
5. returns only positively identified daemons to the authenticated dashboard caller.

The presence response contains public-safe discovery data only: `kind`, protocol version, an opaque daemon-instance ID, machine display name, API base path, and start time. It must not expose sessions, cwd values, models, users, capabilities, credentials, or proxy secrets. Candidate URLs come only from local Tailscale status and never from browser input.

Use simple bounded polling rather than a new streaming protocol initially:

- refresh discovery every 15–30 seconds and cache results for 10–15 seconds;
- probe at most eight peers concurrently with a 2–3 second per-peer timeout;
- cap the candidate peer count and presence body size, initially 256 peers and 4 KiB;
- disable redirects and validate content type, schema, marker, and protocol version;
- use Tailscale's online state only to prioritize probes, never as proof that the daemon is running;
- treat a successful presence probe as reachability evidence, not control authorization—the selected daemon still applies its normal identity, role, and generation checks;
- report failure generically because a timeout cannot reliably distinguish policy denial, DNS failure, Tailscale disconnection, host outage, and daemon outage.

The browser calls the seed daemon's authenticated discovery endpoint and does not scan peers itself. This avoids cross-origin probing, CORS-based discovery leaks, and dependence on a browser Tailscale API. The browser may still connect directly to a selected daemon or iframe its session UI under the existing exact-origin policy.

This design has one unavoidable bootstrap requirement: the user must initially open one known daemon URL. Every daemon can serve that dashboard, so there is no designated registry host; keeping a second bookmark is sufficient for the first version if the usual seed is offline.

### Deferred alternatives

Keep these alternatives available next to the selected design, but do not implement them initially:

1. **Shared Tailscale Service for bootstrap.** All eligible daemon hosts advertise one `svc:pi-dashboard` service so the user has one stable URL routed to an available daemon. The selected daemon still performs peer enumeration and presence probes because the Service hides the physical backend list. This removes seed bookmarks but requires tag-based host identities, service definition, advertisement approval or auto-approval, compatible clients, and lifecycle management.
2. **Server-side Tailscale inventory.** A trusted backend uses least-privilege OAuth credentials to list devices or Tailscale Service hosts and returns filtered candidates. It still needs presence probes to prove the daemon is running, and adds credential storage and rotation.
3. **Tailnet-hosted heartbeat registry.** Daemons register expiring, non-secret presence records with one private registry. This avoids peer scans but adds another service, authentication, heartbeat and expiry rules, persistence, and a new failure domain.
4. **Static host list.** Keep configured URLs only as a manual fallback or test fixture. It is operationally simple but not automatic and becomes stale.
5. **Machine tags.** A `tag:pi-daemon` can narrow candidates in a large tailnet, but tags express machine identity rather than live process presence and can change device ownership semantics. A presence probe remains required.
6. **Tailscale endpoint collection.** Do not depend on it while it remains an alpha, opt-in monitoring feature without a documented application-facing discovery contract. A detected HTTP port would not by itself identify the Pi daemon protocol.

A practical first dashboard would have:

- a machine sidebar showing discovered daemon URLs, last successful probe, and a manual fallback entry;
- a root/project picker populated by the selected daemon, not by Tailscale;
- a launch/resume form;
- session cards with cwd, model, state, owner, and stop/open actions;
- one main cross-origin iframe for the selected session;
- an explicit “open in new tab” action and a generic “connect this device to Tailscale or check policy” diagnostic.

For direct API calls from a Vercel origin, each daemon must allow that exact origin through CORS. Cross-origin iframes do not require CORS, but they do require the child CSP to allow the exact dashboard origin. Tailscale supplies network reachability and backend identity; normal browser CORS, CSP, iframe, and cookie rules still apply.

## Minimal changes to the current web UI extension

Preserve two explicit startup modes and the current session-scoped lifecycle:

1. **Standalone mode — current default**
   - Keep the ephemeral loopback port and random path, one-use fragment bootstrap exchange, path-scoped cookie, `/copy-url`, and `/copy-remote-url` behavior.
   - The extension may continue starting its own per-session foreground `tailscale serve` process in this mode.
   - Default to `Content-Security-Policy: frame-ancestors 'none'`.

2. **Managed startup configuration**
   - Read an opt-in, bounded configuration from inherited environment plus a private extra FD.
   - Include loopback bind/port, external origin/base path, exact allowed frame ancestor, internal proxy capability, and readiness FD.
   - Do not start extension-owned `tailscale serve`; the host agent's fixed Serve endpoint is the only managed ingress.

3. **Readiness protocol**
   - After every `session_start`, write one machine-readable record to the readiness FD containing protocol version, generation, loopback endpoint and internal base path, session ID/file metadata, and public-safe status.
   - Write `stopping` during idempotent `session_shutdown`.
   - Never use stdout; RPC owns it. Existing human-readable stderr diagnostics are not a machine protocol.

4. **Base-path-safe browser assets and transport**
   - Retain relative asset, auth, SSE, and future command URLs.
   - Scope standalone cookies/bootstrap state to the configured path.
   - Avoid assumptions that the UI is mounted at `/`; let the host agent map the stable external launch path to the current internal endpoint and generation.

5. **Trusted-proxy authentication mode**
   - Accept managed requests only from loopback carrying the inherited per-child capability.
   - Consume proxy-injected principal and role after capability validation.
   - Validate the configured external Origin on mutations and WebSocket handshakes, not as the sole authorization signal for document/SSE GETs.
   - Enforce viewer/controller permissions on child command endpoints when browser input is introduced.
   - Keep standalone one-use fragment bootstrap authentication separate; do not rely on its `SameSite=Strict` cookie in dashboard iframes.

6. **Controlled framing and browser policy**
   - Default to `frame-ancestors 'none'` in standalone mode.
   - In managed mode allow exactly the configured dashboard origin.
   - Validate any optional `postMessage` origin and never transfer credentials or commands through it.
   - Add explicit security headers and make the CDN dependency compatible with the chosen CSP or replace it with locally served assets.

7. **No host-agent behavior in the extension**
   - Do not add host discovery, Pi subprocess spawning, cwd selection, persistent registries, or cross-session management.
   - Tailscale CLI spawning remains a standalone transport convenience only; managed mode disables it.
   - Continue starting resources only in `session_start` and closing them in `session_shutdown`.

The current implementation is `.pi/agent/extensions/web-ui-simple/index.ts`. Its loopback server, relative browser URLs, authenticated full-snapshot SSE stream, and shutdown lifecycle are the foundation for these seams; it is no longer a skeleton.

## Host-agent state and recovery

Persist only small manager metadata atomically with owner-only permissions:

- launch ID and creator identity;
- canonical root alias/relative path and cwd;
- creation/last-attach timestamps;
- desired idle policy;
- current Pi session ID/file;
- launch idempotency state.

Pi's JSONL session remains the conversation source of truth. Do not duplicate transcripts in a host-agent database.

Lifecycle rules:

- Browser disconnect does not stop a child.
- Explicit stop and configurable idle TTL govern cleanup.
- Enforce per-host running-session, memory, and launch-rate limits.
- On `/reload`, `/new`, `/resume`, or `/fork`, keep the stable launch ID while updating the child endpoint/generation from readiness records.
- On host-agent crash/reboot, prefer starting a fresh idle Pi process and resuming the validated session file rather than adopting unknown orphan state.
- Never automatically replay a kickoff prompt whose acceptance outcome is unknown.
- Do not automatically resume active model work after reboot.

## Delivery phases

### Phase A — one-host proof using existing primitives

- [x] Implement the single-session read-only transport spike: loopback HTTP, full-snapshot SSE, one-use bootstrap authentication, and clean session shutdown.
- [x] Prove direct per-session tailnet access with extension-owned Tailscale Serve as a standalone convenience.
- [ ] Manually start `pi --mode rpc` in a selected cwd and confirm the extension can report structured readiness over a private FD without touching RPC stdout.
- [ ] Put a fixed local proxy in front with Tailscale Serve and verify HTTP/SSE flushing, command POST forwarding, Origin policy, and iframe behavior on supported clients; test WebSocket upgrades only if the child adopts them.
- [ ] Validate graceful shutdown and extension reload endpoint/generation churn.

### Phase B — minimal host agent

- [ ] Create a Node/TypeScript service with strict schemas and a fixed local configuration.
- [ ] Implement root alias resolution and project-trust policy.
- [ ] Implement launch/list/attach/stop and one-child-per-session supervision.
- [ ] Implement strict RPC framing, bounded stdout/stderr draining, and dialog cancellation.
- [ ] Implement stable-path HTTP/WebSocket proxying and readiness-FD updates.
- [ ] Add a `systemd --user` unit and macOS LaunchAgent.

### Phase C — authentication, discovery, and multi-machine dashboard

- [ ] Apply Tailscale grants/ACLs and validate Serve identity propagation.
- [ ] Add application roles and one-controller leases.
- [ ] Add the bounded, public-safe `/_pi/daemon/v1/presence` endpoint to every daemon.
- [ ] Implement server-side peer discovery with bounded `tailscale status --json` parsing, concurrent HTTPS presence probes, caching, and generic failure states.
- [ ] Expose discovered hosts only through an authenticated daemon endpoint; never put Tailscale API credentials in the SPA or accept browser-supplied probe targets.
- [ ] Add a dashboard that uses any known daemon as its discovery seed and embeds direct per-host iframes.
- [ ] Keep a manual host entry as fallback; evaluate a shared Tailscale Service only if stable bootstrap without seed bookmarks is needed.
- [ ] Add a registry or server-side filtered inventory only if bounded peer probing becomes limiting.
- [ ] Add open-in-new-tab fallback and visible machine/cwd/controller identity.
- [ ] Audit cross-origin, CSP, header stripping, logs, discovery limits, and proxy limits.

### Phase D — recovery and hardening

- [ ] Add atomic metadata persistence and idempotent launches.
- [ ] Add idle TTL, capacity controls, rate limits, and process-group cleanup.
- [ ] Add restart-and-resume without prompt replay.
- [ ] Add audit events that omit prompts, credentials, and model/tool output.
- [ ] Test host-agent/child/proxy crashes, reboots, reloads, and stale generations.
- [ ] Decide whether remote RPC dialog handling is necessary; if so, design it with Herdr lifecycle tests.

## Prototype alternative

For proving demand on one or two machines, an SSH-only launcher is acceptable:

1. Use Tailscale SSH to invoke a fixed local launcher.
2. Validate a root alias and relative path.
3. Start a supervised Pi process (`systemd-run --user` on Linux or a small local wrapper on macOS).
4. Return the machine's stable attach URL.

Do not grow this into the final dashboard architecture. It has weak cross-platform process ownership, routing, attach/status, iframe authentication, and crash-recovery semantics.

## Main risks

- Remote session control is remote code execution as the host Unix account.
- A cwd allowlist can be mistaken for sandboxing.
- Competing RPC and web controllers can duplicate or reorder work.
- Blocking extension dialogs can deadlock unattended RPC children.
- Third-party cookie restrictions make the standalone bootstrap cookie unsuitable as managed iframe authentication.
- Incorrect CSP/framing policy or continued reliance on third-party CDN scripts can weaken the remote-control boundary.
- A central proxy or compromised host agent can expose every session it fronts.
- Kickoff acceptance has a crash window without end-to-end idempotency support from Pi.
- Session replacement changes extension generations and ephemeral ports.
- RPC and session output can contain secrets and must not be logged wholesale.

## Decision summary

The rough daemon idea works: the **per-machine host agent is the system-wide daemon**, with one independent instance on every machine that should accept remote launches. It is not a centralized cross-machine authority and should not be embedded into the web UI extension. Keep `web-ui-simple` responsible for exactly one live session and preserve its existing direct-access behavior as standalone mode. Managed mode disables extension-owned Tailscale Serve and adds only readiness, stable-base-path, trusted-proxy authorization, framing, and future command seams. Each machine's host agent remains responsible for local launch policy, supervision, stable routing, and Tailscale-backed authorization.
