# Pi Web UI

A deliberately tiny browser companion for the current Pi session. It serves a
single-column transcript that mirrors Pi's HTML exporter — user and
assistant messages, thinking, Markdown, images, bash execution, tool calls with
results, compactions, branch summaries, model changes, and custom messages.

There is no build step, no npm server dependency, and no wire protocol: every
relevant Pi event simply re-broadcasts a fresh full snapshot of the active branch
over Server-Sent Events. Remote access uses the system `tailscale` CLI.

## Usage

The server starts automatically at `session_start` in **TUI** and **RPC** modes
and binds to loopback only (`127.0.0.1`, ephemeral port) under a random path. In
parallel, the extension starts a foreground `tailscale serve` proxy on the same
ephemeral port. The proxy is stopped with the session and is available only to
devices permitted by the tailnet's access controls.

- In TUI, notifications report the local server and when the tailnet proxy is ready.
- In RPC, stderr reports diagnostic base URLs. Running either copy command returns
  the complete authenticated URL in an RPC notification instead of using the host
  clipboard.

Use one of the two copy commands:

```
/copy-url
/copy-remote-url
```

`/copy-url` copies a loopback link for a browser on the same machine.
`/copy-remote-url` copies the HTTPS Tailscale Serve link for another machine on
the tailnet; while Serve is starting, the command asks you to retry shortly.
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

Press plain `i` outside an editable control to focus the composer. Typing `@`
opens file completion backed by Pi's current autocomplete provider in TUI mode.
RPC mode uses Pi's managed `fd`, a system `fd`, or a bounded filesystem fallback.
Arrow keys
move through results, Tab inserts the active result, Escape dismisses them, and
results can also be clicked.

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
`Cmd/Ctrl+T` still work).

`Cmd/Ctrl+K` opens a small command palette centered in the viewport that lists all
five preferences above (each with its single-key hotkey) and toggles them. It is
an accessible modal dialog: arrow keys / `Tab` move between commands, `Enter`/`Space`
toggles the focused command, `Escape` or a backdrop click closes it, focus is
trapped while open, and the plain-key hotkeys are suppressed until it closes. The palette items derive directly from the same persisted
preferences, so it adds no storage of its own.

## How it works

- **Static assets** (`src/client/index.html`, `src/client/app.js`, `src/client/styles.css`) are served
  directly from disk. The browser loads Preact + hooks + htm + marked from a CDN
  as native ES modules — nothing is bundled or installed.
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
- **Snapshots**: on connect, after message/tool/session events, and when a small
  freshness check notices an otherwise unannounced session append, the server
  sends `{ header, entries, leafId, sessionName, isRunning, workingWord, theme, systemPrompt, metadata }`
  for the current branch. In-progress assistant messages and running tool executions are
  overlaid as synthetic entries until they are persisted. The browser follows
  Pi's configured theme; automatic light/dark pairs follow the browser color
  scheme.
- **Input**: authenticated same-origin POST endpoints accept bounded message and
  file-completion requests. Idle messages, steering messages, and queued
  follow-ups use explicit delivery modes. No browser interaction is a Herdr
  blocked scope; Pi's normal agent lifecycle remains authoritative.
- The server closes cleanly on `session_shutdown`.

## Scope / intentionally omitted

This extension remains a deliberately minimal milestone. It does **not** include
the exporter's sidebar/session tree or metadata/tool-map header, and it
intentionally omits slash-command dispatch, pagination, virtualization,
WebSockets, public internet access, dashboards, provider controls, a broad
security/CSP layer, and any configuration system. Syntax highlighting is not
included; code blocks render as plain monospaced text. The browser must be online
and trusts the pinned Preact,
htm, and marked modules served by esm.sh; this is the explicit tradeoff of the
requested no-build-tools route for this minimal milestone.

## Planning and architecture

- [`PLAN.md`](./PLAN.md) tracks the standalone extension and reusable `packages/pi-web-ui-client` work.
- [`../../../apps/remote-session-daemon/PLAN.md`](../../../apps/remote-session-daemon/PLAN.md) separately tracks the machine-level daemon implementation.
- [`../../../../PI_SETUP_REPO_MIGRATION_PLAN.md`](../../../../PI_SETUP_REPO_MIGRATION_PLAN.md) tracks the one-time move from the current dotfiles-owned symlink into a dedicated `~/.pi` repository.
- [`docs/RPC_FIRST_REMOTE_DASHBOARD.md`](./docs/RPC_FIRST_REMOTE_DASHBOARD.md) defines the current daemon-owned RPC architecture for the cross-machine dashboard.
- [`docs/REMOTE_SESSION_INFRA_PLAN.md`](./docs/REMOTE_SESSION_INFRA_PLAN.md) preserves the earlier extension-server/iframe design and the infrastructure rationale that remains useful.
- [`docs/ADDITIONAL_DETAILS.md`](./docs/ADDITIONAL_DETAILS.md) records supporting base-path, security, and lifecycle requirements.
- [`docs/SSE_TRAFFIC_ANALYSIS.md`](./docs/SSE_TRAFFIC_ANALYSIS.md) measures the current full-snapshot transport cost.
- [`docs/SLASH_COMMAND_DISPATCH.md`](./docs/SLASH_COMMAND_DISPATCH.md) documents the upstream command-dispatch boundary.

## Development checks

Install the local development dependencies and run the complete check:

```sh
nub install
nubx playwright install chromium
nub run check
```

The Playwright suite launches the real authenticated HTTP/SSE server and production browser assets with deterministic session snapshots. Its assertions use accessible browser behavior rather than Preact component internals.

## Roadmap

[`PLAN.md`](./PLAN.md) is the only actionable roadmap. It deliberately sequences behavior-preserving modularization, local bundling, and extraction of `packages/pi-web-ui-client` before the remaining portable features—images, questionnaire results, syntax highlighting, attachments, provider dashboards, model controls, notifications, and bounded diff rendering—are added. This keeps the standalone extension and daemon-hosted dashboard on one browser implementation instead of growing the current monolithic client in place.
