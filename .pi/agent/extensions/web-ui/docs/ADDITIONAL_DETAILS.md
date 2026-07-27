> **Architecture note:** [`RPC_FIRST_REMOTE_DASHBOARD.md`](./RPC_FIRST_REMOTE_DASHBOARD.md) now defines the managed dashboard. Its daemon serves the SPA directly, so the managed child-proxy, iframe, readiness-FD, and trusted-proxy seams anticipated below are no longer target requirements. The standalone lifecycle, hostile-content, transport-limit, exact-Origin, and base-path guidance remains applicable to `web-ui`.

## Requirements to account for now

### 1. Preserve the extension/daemon boundary

- The extension must remain scoped to **one Pi process and one active session**.
- Do not add process spawning, cwd selection, session registries, machine discovery, Tailscale commands, or daemon persistence.
- A future system-wide daemon will manage Pi subprocesses and reverse-proxy the extension.
- The extension should work normally without that daemon.

### 2. Make everything base-path safe

The future daemon will likely expose sessions at paths such as:

```text
/_pi/s/<launch-id>/
```

Therefore:

- Do not assume the application is mounted at `/`.
- Static asset URLs must be relative or generated from a configured base path.
- HTTP API routes must account for the base path.
- WebSocket URLs must account for the base path.
- Client-side reconnect logic must preserve the base path.
- Redirects and `Location` headers must not accidentally redirect to the origin root.
- Authentication cookies, if used, must be scoped to the configured session path.
- Service workers should not be introduced; their path scope would add unnecessary complexity.
- Add tests that run the complete application beneath a non-root path.

### 3. Centralize server runtime configuration

Avoid scattering environment lookups and defaults throughout the server. Have one validated runtime configuration object that can eventually support:

- bind address;
- port, including ephemeral port `0`;
- public/external origin;
- base path;
- authentication mode;
- allowed browser origins;
- framing policy.

For the standalone extension:

- Default bind address remains `127.0.0.1`.
- Default port can remain ephemeral or extension-configured.
- Do not bind to `0.0.0.0` by default.
- Do not invent a remotely reachable URL when one has not been configured.

Future managed-mode fields do not need to be implemented yet, but the configuration shape should be extensible without rewriting the server.

### 4. Put authentication behind a small boundary

Standalone authentication should still use the planned single-use fragment bootstrap flow, but transport code should not contain authentication logic everywhere.

Prefer an interface conceptually like:

```typescript
authenticateHttp(request): Principal | AuthFailure
authenticateWebSocket(request): Principal | AuthFailure
authorize(principal, command): boolean
```

For now, the principal can simply represent an authenticated standalone controller.

This should later allow a daemon-proxy mode to provide a validated Tailscale identity or controller role without changing the WebSocket protocol and event reducer.

Do not implement trusted-proxy authentication yet.

### 5. Do not trust proxy headers now

- Standalone mode must ignore `X-Forwarded-*`, Tailscale identity headers, and custom principal headers.
- Do not infer authentication from a request arriving on loopback.
- A future managed mode must explicitly opt into trusting one local reverse proxy.
- Any future proxy mode will need to strip spoofable incoming headers and authenticate the proxy separately.

### 6. Keep Origin validation configurable and exact

- Validate `Origin` on browser HTTP mutations and WebSocket upgrades.
- Do not use wildcard origins.
- Standalone mode should allow only its configured/canonical origin.
- Keep the allowed-origin policy centralized so a future daemon-served dashboard origin can be configured.
- Do not automatically trust every `*.ts.net` origin.
- Avoid combining authentication and CORS into the same mechanism.

### 7. Default to non-frameable content

Use a restrictive default such as:

```text
Content-Security-Policy: frame-ancestors 'none'
```

- Do not enable arbitrary iframe embedding now.
- Keep framing policy configurable so a future same-origin or explicitly approved dashboard can enable it.
- Do not depend on iframe `postMessage`.
- Do not send credentials or commands through `postMessage`.
- Do not add third-party-cookie workarounds.

The likely first daemon dashboard will be served from the same machine origin, which should minimize iframe and cookie problems.

### 8. Keep browser URLs proxy-compatible

- Derive WebSocket protocol from the page URL: HTTPS should produce `wss:`.
- Do not hard-code `localhost`, the listening port, or `ws://`.
- Browser code should derive API and WebSocket endpoints from its current document location and base path.
- The internal listening endpoint and browser-visible endpoint must be treated as different concepts.
- Avoid leaking internal loopback addresses into browser snapshots or rendered content.

### 9. Keep public URL discovery separate from bind information

The extension may listen at:

```text
127.0.0.1:<ephemeral-port>
```

while the browser-visible URL could eventually be:

```text
https://machine.tailnet.ts.net/_pi/s/<launch-id>/
```

Therefore:

- Do not construct the public URL solely from `server.address()`.
- Keep the configured external URL separate from the internal listener.
- The startup announcement and `/copy-remote-url` should use the configured external URL when present.
- Logs and health responses must never include bootstrap credentials.
- RPC stdout must never contain either URL or diagnostics.

### 10. Keep the protocol independent of HTTP topology

The WebSocket/session protocol should identify:

- protocol version;
- session generation;
- revision;
- session ID;
- command ID;
- command acceptance or rejection.

It should not identify sessions using:

- TCP ports;
- internal listener addresses;
- iframe identity;
- browser origin;
- future daemon launch IDs.

A future daemon launch ID is routing metadata outside the Pi session protocol.

### 11. Treat session generation as ephemeral

A future daemon may keep one stable external route while the extension restarts internally.

The extension must already handle:

- `/reload`;
- `/new`;
- `/resume`;
- `/fork`;
- `/clone`;
- server restart;
- port change;
- new extension instance;
- stale browser connections.

On restart:

- generate a new extension/session generation;
- reject commands carrying a stale generation;
- reconnect with a fresh snapshot;
- never retain old `pi`, `ctx`, or `SessionManager` references;
- close old HTTP and WebSocket resources idempotently.

### 12. Preserve strict Pi lifecycle behavior

- Start sockets, timers, and subscriptions only during `session_start`.
- Do not start long-lived resources in the extension factory.
- Shut down idempotently during `session_shutdown`.
- Stop accepting connections before final cleanup.
- Close WebSockets, clear timers, unsubscribe providers, and close the HTTP server.
- Handle partial-startup failure without leaking a bound port.
- Keep shutdown safe when startup never completed.
- Avoid module-level or `globalThis` state that survives extension replacement.

### 13. Preserve RPC compatibility

The future daemon will probably launch:

```text
pi --mode rpc
```

Therefore:

- Never write anything except RPC JSONL to stdout.
- Send diagnostics to stderr or a bounded extension-owned log.
- Do not rely on TUI-only behavior.
- Do not use `ctx.ui.custom()` for required browser operation.
- Start the web server only in TUI and RPC modes.
- Do not leave a server running in print or JSON mode.
- Test startup, prompting, streaming, abort, reload, and shutdown in RPC mode.

### 14. Do not add a daemon kickoff concept

- The extension should not expect a parent daemon to supply an initial prompt.
- The browser remains responsible for sending the first prompt.
- Do not add prompt idempotency or daemon-command ownership fields to the extension protocol.
- Keep normal browser command acceptance IDs, since those are independently useful.

### 15. Avoid premature multi-user design

For the initial extension:

- Treat authenticated browser clients as equivalent controllers.
- Do not add viewer/controller/launcher/operator roles yet.
- Do not add controller leases.
- Do not add collaborative editing semantics.
- Keep authorization centralized enough that roles could be introduced later.
- Retain the existing client-count and queue limits.

### 16. Make health information bounded and non-sensitive

A future daemon will need to know whether the child UI is healthy, but the current extension only needs a safe health endpoint.

It may expose:

- extension/protocol version;
- readiness;
- generation;
- busy/idle state;
- optional non-secret session identifier.

It must not expose:

- bootstrap credentials;
- provider credentials;
- environment variables;
- system prompts;
- session transcript;
- arbitrary filesystem paths beyond what the authenticated UI already needs;
- internal proxy capabilities.

Whether readiness is later sent over a pipe, file, socket, or polling endpoint should remain undecided.

### 17. Do not implement readiness signaling yet

Do not currently add:

- inherited readiness file descriptors;
- readiness files;
- daemon sockets;
- process registration;
- orphan adoption.

The extension should expose a clean server-start result internally and a safe authenticated or deliberately minimal health endpoint. We can choose the parent/child readiness mechanism when implementing the daemon.

### 18. Maintain strong transport limits

Preserve the limits already defined in `src/shared/limits.ts`, including:

- request/header limits;
- inbound WebSocket message limits;
- prompt limits;
- snapshot limits;
- tool text and image limits;
- client count;
- outbound queue limits;
- bootstrap credential lifetime.

Additionally:

- apply limits before expensive parsing;
- bound unauthenticated requests more strictly where practical;
- coalesce high-frequency updates;
- disconnect slow clients;
- never await browser drains inside Pi event handlers;
- ensure the future reverse proxy can apply equal or tighter limits.

### 19. Keep content hostile by default

All of the following remain untrusted:

- model Markdown;
- tool output;
- filenames and paths;
- tool arguments and details;
- session content;
- custom extension payloads;
- URLs and images.

Continue with:

- escaped embedded HTML;
- DOMPurify after Markdown rendering;
- URL-scheme allowlisting;
- no inline scripts or event handlers;
- strict CSP;
- bounded image handling;
- no direct ANSI-to-HTML trust path;
- generic renderers that do not execute arbitrary TUI renderer code.

### 20. Keep control commands explicit

The browser protocol must distinguish:

- idle prompt;
- busy steering;
- busy follow-up;
- abort.

Do not guess steer versus follow-up.

Commands should receive:

- immediate acceptance or rejection;
- a correlated command ID;
- normal subsequent session events for actual completion or failure.

A successful acceptance response must not imply that the resulting model operation completed successfully.

### 21. Keep extension dialogs out of scope, but fail predictably

The standalone extension does not need to bridge arbitrary RPC `extension_ui_request` dialogs into the web UI yet.

However:

- Do not claim that all Pi extensions are remotely interactive.
- Questionnaire result rendering does not imply browser-side questionnaire answering.
- Any future awaited browser confirmation must use balanced `herdr:blocked` active/inactive events in `finally`.
- Autonomous HTTP, WebSocket, proxy, and dashboard activity must not mark Herdr as blocked.

### 22. Keep dashboard-provider bridges process-local and serializable

Agentflow and background-process providers should continue to expose only:

- bounded serializable snapshots;
- subscriptions;
- explicitly allowed control actions.

They must not expose:

- runtime instances;
- abort controllers;
- session managers;
- credentials;
- arbitrary filesystem APIs;
- daemon/process-management capabilities.

This remains true when the extension is eventually reverse-proxied.

### 23. Prefer same-origin composition later

Do not build the dashboard now, but avoid choices that would prevent the future daemon from serving:

```text
https://machine.tailnet.ts.net/_pi/
https://machine.tailnet.ts.net/_pi/s/<launch-id>/
```

Same-machine, same-origin composition is likely preferable to a Vercel dashboard because it avoids:

- public-to-private Local Network Access restrictions;
- CORS for normal same-host operations;
- third-party iframe cookie problems;
- unnecessary cross-origin framing configuration.

Cross-machine navigation can initially use normal links or “open in new tab.”

### 24. Add focused future-compatibility tests now

Alongside the existing lifecycle and security tests, include:

- serving under a non-root base path;
- static assets under that base path;
- API and WebSocket connection under that base path;
- `wss:` derivation from an HTTPS-visible page;
- path-scoped authentication state;
- no absolute-root redirects;
- exact Origin rejection;
- spoofed proxy/Tailscale headers having no effect;
- `frame-ancestors 'none'` by default;
- public URL differing from internal bind address;
- no stdout output in RPC mode;
- reconnect after extension generation changes.

## Explicitly defer

The agent should **not** implement any of these as part of the simple extension:

- the system-wide daemon;
- Python or Node subprocess management;
- Tailscale Serve setup;
- Tailscale LocalAPI, WhoIs, REST, OAuth, or `tsnet`;
- machine discovery or registration;
- a Vercel or tailnet dashboard;
- reverse-proxy code;
- readiness FD/file/socket protocols;
- root alias or cwd policy;
- daemon launch IDs;
- daemon persistence or crash recovery;
- initial kickoff prompts;
- multi-user roles or controller leases;
- cross-machine iframe orchestration;
- remote handling of arbitrary RPC dialogs.

The most important immediate additions beyond the existing [`PLAN.md`](../PLAN.md) are therefore: **base-path safety, centralized bind/public URL configuration, an authentication module boundary, exact configurable Origin policy, proxy-compatible browser URLs, restrictive default framing, and tests for all of those.**
