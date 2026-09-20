# Pi Web UI

A deliberately tiny browser companion for the current Pi session. It serves a
single-column transcript that mirrors Pi's HTML exporter — user and
assistant messages, thinking, Markdown, images, bash execution, tool calls with
results, compactions, branch summaries, model changes, and custom messages.

The browser attaches through a versioned incremental protocol: a bounded initial
window is followed by persisted appends and replaceable live, metadata, queue,
theme, and running-state operations over Server-Sent Events (SSE). Older history
loads through authenticated, opaque-cursor pages, and transcript rows are
virtualized. The browser client, wire schemas, renderers, and stylesheet live in the host-neutral
[`@dotfiles/pi-web-ui-client`](../../../packages/pi-web-ui-client) package and are
bundled locally with Vite into a self-contained, offline production asset. Remote
access uses the system `tailscale` CLI.

## Usage

In **TUI** and **RPC** modes, the loopback server starts lazily when `/copy-url`
or `/copy-remote-url` is first run. It binds only to `127.0.0.1` on an ephemeral
port under a random path. `/copy-remote-url` also starts a foreground
`tailscale serve` proxy on first use. Both resources are stopped with the session,
and the proxy is available only to devices permitted by the tailnet's access
controls.

- In TUI, notifications report copied links and when a requested tailnet proxy is ready.
- In RPC, running either copy command returns the complete authenticated URL in a
  notification instead of using the host clipboard.

Use one of the two copy commands:

```
/copy-url
/copy-remote-url
```

`/copy-url` copies a loopback link for a browser on the same machine.
`/copy-remote-url` starts Tailscale Serve on first use and copies its HTTPS link
for another machine on the tailnet; the command waits up to fifteen seconds for
Serve to come up and asks you to retry shortly if it does not.
Both links contain a fresh one-time authentication code in the URL fragment,
for example `http://127.0.0.1:<port>/<random-path>/#code=<one-time>`. Up to eight
unredeemed codes remain valid for two minutes; each is invalidated on first use.
Paste the chosen link into a browser. The page renders live and updates as the session
progresses. While Pi is running, the status bar mirrors the rotating message
selected by `working-word.ts`.

### Message input

A sticky composer at the bottom sends ordinary user messages through Pi's public
`sendUserMessage()` API. Enter inserts a newline. `Option+Enter` sends while idle
or steers a running turn; `Ctrl+Enter`/`Cmd+Enter` sends while idle or queues a
follow-up while Pi is running. The visible button sends (or steers) on a normal
tap/click. Right-click it on desktop or long-press it on mobile to open explicit
Send / Steer / Queue choices. The editor starts at one line and grows with its
content on desktop; on mobile it stays one line while idle and expands into the
visual space above the keyboard while focused. Accepted steering and follow-up
messages remain listed above the editor until Pi begins delivering them; a
rejected request keeps the exact draft and shows the reason.

Press plain `i` outside an editable control to focus the composer, and `Escape`
inside it to unfocus (a first `Escape` only dismisses open completions). Typing
`@`
opens file completion backed by Pi's current autocomplete provider in TUI mode.
RPC mode uses Pi's managed `fd`, a system `fd`, or a bounded filesystem fallback.
Arrow keys
move through results, Tab inserts the active result, Escape dismisses them, and
results can also be clicked.

Press `?` outside the editor to open a cheat sheet dialog listing every keyboard
shortcut, including the display hotkeys below. `Escape` or a backdrop click
closes it, and while it is open the plain-key hotkeys stay quiet.

The composer mirrors the TUI footer: context usage and accumulated cost interrupt
the upper-left border, model and thinking level sit on the upper-right border,
and the compact cwd interrupts the lower-right border. Slash commands are
intentionally not supported; see
[`SLASH_COMMAND_DISPATCH.md`](./docs/SLASH_COMMAND_DISPATCH.md).

### Display preferences

Five transcript details are hidden/collapsed by default and can be toggled with
plain single-key hotkeys (no modifier) or from the `Cmd/Ctrl+K` command palette.
Each choice is persisted to `localStorage`, with a host-scoped cookie carrying it
across the server's ephemeral ports:

| Key | Toggles                                                |
| --- | ------------------------------------------------------ |
| `t` | thinking blocks (default collapsed)                    |
| `e` | full tool-call output (default collapsed)              |
| `s` | message timestamps (default hidden)                    |
| `m` | model / thinking-level switch entries (default hidden) |
| `p` | effective system prompt (default hidden)               |

Hotkeys are ignored while a modifier is held (so browser shortcuts such as
`Cmd/Ctrl+T` still work). Press `?` outside the editor for a cheat sheet listing
all of them.

`Cmd/Ctrl+K` opens a small command palette centered in the viewport that lists all
five preferences above (each with its single-key hotkey) and toggles them. It is
an accessible modal dialog: arrow keys / `Tab` move between commands, `Enter`/`Space`
toggles the focused command, `Escape` or a backdrop click closes it, focus is
trapped while open, and the plain-key hotkeys are suppressed until it closes. The palette items derive directly from the same persisted
preferences, so it adds no storage of its own.

## How it works

- **Static assets**: `src/web/` (`index.html`, `main.ts`, `standalone-transport.ts`)
  is bundled by Vite (`nub run build`) into `dist/client/`, which the server serves
  from disk. Preact, Marked, and DOMPurify are pinned local dependencies bundled
  into one self-contained asset — no CDN and no runtime network imports. Every asset
  reference is relative so the app mounts under the server's random base path. A
  strict `Content-Security-Policy` (`default-src 'none'`; `script-src`/`style-src`/
  `connect-src 'self'`; `img-src 'self' data: https:`; `frame-ancestors 'none'`)
  plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  `X-Frame-Options: DENY` are sent on every response. The theme is applied through
  the CSSOM (CSS custom properties on the document element) rather than an injected
  stylesheet, so no `'unsafe-inline'` is required.
- **Tailnet proxy**: `tailscale serve` terminates HTTPS on the machine's tailnet
  address and forwards to the loopback server. Each session uses its own
  ephemeral HTTPS port, so concurrent Pi sessions do not replace one another's
  Serve configuration. If Tailscale is absent or disconnected, local access
  continues to work.
- **Auth**: the one-time code carried in the URL fragment is POSTed to `auth`,
  which exchanges it for a random, path-scoped `HttpOnly; SameSite=Strict` cookie.
  The `events` SSE stream requires that cookie. Codes are single-use, expire after
  two minutes, and are capped at eight outstanding links; the fragment never
  reaches the server during navigation.
- **Session operations**: the initial attach and continuity recovery send the latest
  bounded branch window with a runtime generation and monotonic revision. Strict
  persisted suffixes append once; live assistant/tool overlays and metadata, queue,
  theme, and running state replace independently. Revision gaps recover through a
  bounded reset. Authenticated history pages are count- and byte-bounded and use
  tamper-resistant cursors that remain valid across strict tail appends but rotate
  on branch/reset transitions. The browser virtualizes transcript rows while
  preserving stable row identity, disclosure state, bottom-follow, and prepend
  anchoring. Automatic light/dark theme pairs follow the browser color scheme.
- **Input**: authenticated same-origin POST endpoints accept bounded message and
  file-completion requests. Idle messages, steering messages, and queued
  follow-ups use explicit delivery modes. No browser interaction is a Herdr
  blocked scope; Pi's normal agent lifecycle remains authoritative.
- The server closes cleanly on `session_shutdown`.

## Scope / intentionally omitted

This extension remains deliberately compact. It does **not** include the
exporter's sidebar/session tree or metadata/tool-map header, and it intentionally
omits slash-command dispatch, WebSockets, public internet access, dashboards,
provider controls, and any configuration system. Syntax highlighting is not
included; code blocks render as plain monospaced text.

## Planning and architecture

- [`PLAN.md`](./PLAN.md) tracks the standalone extension and reusable `packages/pi-web-ui-client` work.
- [`../../../apps/remote-session-daemon/PLAN.md`](../../../apps/remote-session-daemon/PLAN.md) separately tracks the machine-level daemon implementation.
- [`docs/RPC_FIRST_REMOTE_DASHBOARD.md`](./docs/RPC_FIRST_REMOTE_DASHBOARD.md) retains its legacy filename but defines the current daemon-owned typed SDK architecture for the cross-machine dashboard.
- [`docs/REMOTE_SESSION_INFRA_PLAN.md`](./docs/REMOTE_SESSION_INFRA_PLAN.md) preserves the earlier extension-server/iframe design and the infrastructure rationale that remains useful.
- [`docs/ADDITIONAL_DETAILS.md`](./docs/ADDITIONAL_DETAILS.md) records supporting base-path, security, and lifecycle requirements.
- [`docs/SSE_TRAFFIC_ANALYSIS.md`](./docs/SSE_TRAFFIC_ANALYSIS.md) records the former full-snapshot transport cost that motivated Phase 3.
- [`docs/SLASH_COMMAND_DISPATCH.md`](./docs/SLASH_COMMAND_DISPATCH.md) documents the upstream command-dispatch boundary.

## Development checks

Install the local development dependencies and run the complete check:

```sh
nub install
nubx playwright install chromium webkit
nub run check                              # whole workspace
nub run --filter pi-web-ui check           # this extension only (adds the bundle freshness gate)
```

The extension check runs format, lint, typecheck, the committed-bundle freshness
gate (`build:check`), and the Playwright suite. Common individual commands:

```sh
nub run --filter pi-web-ui build           # rebuild the committed dist/client bundle
nub run --filter pi-web-ui build:watch     # continuously rebuild while developing the UI
nub run --filter pi-web-ui build:check     # fail if the committed bundle is stale
nub run --filter pi-web-ui test:deployment # clean offline workspace install + package/bundle checks
nub run --filter pi-web-ui test:e2e        # Playwright against deployment-like built assets
nub run --filter pi-web-ui test:headed     # same suite, headed browser
nub run --filter pi-web-ui mock            # serve the committed bundle with the mock server
nub run --filter pi-web-ui preview         # rebuild first, then the same mock server
nub run --filter @dotfiles/pi-web-ui-client test   # host-neutral schema/fixture/format tests
```

The Phase 0 desktop/mobile visual references and DOM/accessibility inventory are
stored in `test/baselines/`.

### Mock server

`mock/server.mjs` replaces the server the TUI normally spawns. It serves the
committed `dist/client/` bundle over loopback and streams a scripted transcript as
protocol v1 envelopes, so the production browser client connects unmodified and every
tool call can be inspected without a live Pi session. Authentication is intentionally
skipped and everything is served from `/` rather than a random base path: this is a
local-only developer aid, not the shipped server.

```sh
nub run --filter pi-web-ui mock -- --speed=0.25          # quarter speed, ephemeral port
nub run --filter pi-web-ui mock -- --port=4173 --loop    # fixed port, replay forever
```

| Flag               | Meaning                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--speed=<factor>` | Playback rate. `1` (the default) is the authored timing; `0.25` is quarter speed, so every wait takes four times as long. Must be positive. |
| `--port=<number>`  | Listening port. `0` (the default) picks an ephemeral port, printed on stdout with the step and entry counts.                                |
| `--loop`           | When the sequence finishes, restart it from a fresh generation instead of resting on the final pending turn.                                |

The timeline itself is `toolShowcaseScenario()` in
`packages/pi-web-ui-client/src/testing/tool-showcase.ts`, exported from the shared
package's `"./testing"` entry so any other host (tests, Playwright, the daemon) can
replay the same sequence. It is host-neutral data: the pacing is `delayMs` per step
and the server owns the timers, the speed factor, the generation and revision numbers
and the append anchors. Edit that module to change what is rendered; edit
`mock/server.mjs` only for transport behaviour.

Every tool of this setup appears first as a call without a result (pending) and then
settled a beat later, which is the transition worth watching. Streaming tools emit
partial results in between (`isPartial` live-tail rows, as the host's live projection
does), agentflow runs progress `queued -> running -> completed` with a growing tool
list, and the sequence also carries failing tools, a failed and an aborted agentflow
run, a live background run, a multi-node workflow run, an unknown tool for the generic
fallback, every non-tool entry kind, and the running/metadata/queue operations. It
ends mid-turn on a pending call so the live states stay on screen.

The server also answers the rest of the transport contract, so the composer is live:
`POST input` and `input-image` append the submitted message (attachments become
resolvable `image/<id>` references), `POST complete` returns `@` suggestions,
`POST queue` edits and removes pending inputs, and `POST history` serves one older
page. Frames are validated with the shipped `isServerEnvelope` before they are
written, so a timeline the browser would reject fails loudly on the server instead.

While changing `packages/pi-web-ui-client/src/` or `src/web/`, keep `build:watch`
running in a second terminal or a coding-agent background process. Vite then rewrites
the committed `dist/client/` bundle after each change; reload the browser to use the
new assets. Stop the watcher when UI development ends, then run `build:check` before
committing.

**Artifact policy:** the production bundle in `dist/client/` is committed. Because
the Vite build is deterministic for the pinned toolchain, `build:check` rebuilds
into a temporary directory and byte-compares it against the committed assets, so a
stale bundle fails the check. Run `nub run build` and commit `dist/client/` after
changing the client, `src/web/`, or the pinned browser dependencies. From the
repository root, use `nub run --filter pi-web-ui build`.

The Playwright suite verifies the committed bundle in its global setup and launches
the real authenticated HTTP/SSE server in Chromium and WebKit with deterministic
session snapshots. It also asserts the strict CSP/security headers, that no request leaves
the loopback origin, the random nested base path, and clean shutdown. Its assertions
use accessible browser behavior rather than Preact component internals.

## Roadmap

[`PLAN.md`](./PLAN.md) is the only actionable roadmap. It deliberately sequences behavior-preserving modularization, local bundling, and extraction of `packages/pi-web-ui-client` before the remaining portable features—images, questionnaire results, syntax highlighting, attachments, provider dashboards, model controls, notifications, and bounded diff rendering—are added. This keeps the standalone extension and daemon-hosted dashboard on one browser implementation instead of growing the current monolithic client in place.
