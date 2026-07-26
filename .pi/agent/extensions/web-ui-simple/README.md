# Web UI (simple)

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
[`SLASH_COMMAND_DISPATCH.md`](SLASH_COMMAND_DISPATCH.md).

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

## Development checks

Install the local development dependencies and run the complete check:

```sh
nub install
nubx playwright install chromium
nub run check
```

The Playwright suite launches the real authenticated HTTP/SSE server and production browser assets with deterministic session snapshots. Its assertions use accessible browser behavior rather than Preact component internals.

## Roadmap

- [x] improve scroll behavior: stick to the bottom or stay fixed
- [x] hotkey support for collapse/expand thinking (default collapsed), expanding/collapsing tool calls (default collapse), showing/hiding timestamps (default hide), showing/hiding model/thinking level switches (default hide), showing/hiding the effective system prompt (default hide)
      -> implemented natively with a tiny Preact context + `localStorage` + a single `document` keydown listener (no extra dependencies). See "Display preferences" above.
- [x] keep the global background lighter than tool backgrounds in light themes, matching the TUI
- [x] fix the markdown rendering of the thinking (use marked)
- [x] dynamically change the window title to `π – <session title>`
- [x] tool call rendering parity for our custom setup: custom edit/write tool rendering, pi-fff, Agentflow, and background-processes tools
- [x] add working word that changes exactly as in `.pi/agent/extensions/working-word.ts`
- [x] tailscale server command spawned in parallel with the node HTTP server and split the copy URL command into two: `/copy-url` for local usage and `/copy-remote-url` for other machines on the tailnet
- [x] fix thinking expansion behavior: when clicking on a collapsed thinking block only this one should be expanded, not all (same behavior that currently exists on the tool calls)
- [x] add a small command line centered on the screen invoked via cmd-k to modify certain display settings backed up to local storage (toggle tool expansion, thinking showing)
      -> implemented as an accessible `Cmd/Ctrl+K` command palette whose items derive directly from the shared `PREFS` list, toggling all five persisted display preferences via `PrefsContext` (no new persistence). See "Display preferences" above.
- [x] input box:
  - [x] initial support for sending messages via a sticky text input at the bottom (with ability to steer and queue via opt+enter and ctrl/cmd+enter, enter just creating a new line)
  - [x] rendering of additional information: cwd, context usage, session cost, model and thinking level.
  - [x] global `i` hotkey to focus the input box
  - [x] file autocompletions via @ in both TUI and RPC modes using Pi's canonical autocomplete provider behavior
  - [ ] slash-command autocomplete and dispatch via `/` — **deferred** while the initial input box ships without slash-command support. Revisit only when Pi exposes a supported canonical raw-input/command-dispatch API (or we agree on an equally safe boundary); discovery through `pi.getCommands()` alone is insufficient. See [`SLASH_COMMAND_DISPATCH.md`](SLASH_COMMAND_DISPATCH.md).
- [x] restructure the code a bit into a `src` folder with the `index.ts` entrypoint, `server` ts code and `client` js/css/html assets
- [ ] add Highlight.js syntax highlighting to fenced code blocks in user and assistant messages, matching Pi's reference HTML exporter and existing theme variables
- [ ] questionnaire tool rendering
- [ ] notification system (like in `.pi/agent/extensions/notify.ts`) . I am not yet clear on what it takes to be able to send notifications (need a pwa?) or if we have to deal with a permission prompt for every new session server
- [ ] image support compatible with remote machines:
  - [ ] display images then in the user messages (there seem to be already some support for this in the read tool calls but it's unclear if it would work over the network)
  - [ ] ability to attach images in the input box
- [ ] agentflow and background processes dashboards with status bar below the text input
- [ ] allow to change models with opt-m (needs to be able to show the model selectors offered in pi, at first only the selected models not all of them)
- [ ] add a git diff visualizer using @pierre/diffs

> NOTE: when complexity becomes big enough to justify more type safety (e.g. via the usage of ts bindings of preact and other libs, or using typebox to verify the server updates) we should also think about a very minimal bundling step.
