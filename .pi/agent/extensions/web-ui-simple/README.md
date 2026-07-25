# Web UI (simple)

A deliberately tiny, read-only browser companion for the current Pi session. It
serves a single-column transcript that mirrors Pi's HTML exporter — user and
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
progresses. While Pi is running, the status bar
mirrors the rotating message selected by `working-word.ts`. It is **read-only** —
there is no composer, command input, or any way to act on the session from the
browser.

### Display preferences

Five transcript details are hidden/collapsed by default and can be toggled with
plain single-key hotkeys (no modifier). The same toggles are shown as a clickable
legend in the status bar. Each choice is persisted to `localStorage`, with a
host-scoped cookie carrying it across the server's ephemeral ports:

| Key | Toggles                                                |
| --- | ------------------------------------------------------ |
| `t` | thinking blocks (default collapsed)                    |
| `e` | full tool-call output (default collapsed)              |
| `s` | message timestamps (default hidden)                    |
| `m` | model / thinking-level switch entries (default hidden) |
| `p` | effective system prompt (default hidden)               |

Hotkeys are ignored while a modifier is held (so browser shortcuts such as
`Cmd/Ctrl+T` still work).

## How it works

- **Static assets** (`web/index.html`, `web/app.js`, `web/styles.css`) are served
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
  sends `{ header, entries, leafId, sessionName, isRunning, workingWord, theme, systemPrompt }`
  for the current branch. In-progress assistant messages and running tool executions are
  overlaid as synthetic entries until they are persisted. The browser follows
  Pi's configured theme; automatic light/dark pairs follow the browser color
  scheme.
- The server closes cleanly on `session_shutdown`.

## Scope / intentionally omitted

This extension is the minimal read-only milestone. It does **not** include the
exporter's sidebar/session tree or metadata/tool-map header, and it deliberately
omits browser input, pagination, virtualization, WebSockets, public internet
access, dashboards, provider controls, a broad security/CSP layer, and any
configuration system. Syntax highlighting is not included; code blocks render as
plain monospaced text. The browser must be online and trusts the pinned Preact,
htm, and marked modules served by esm.sh; this is the explicit tradeoff of the
requested no-build-tools route for this minimal milestone.

## Development checks

The extension intentionally has no `package.json`. Run the formatter and linter
without installing project dependencies:

```sh
nubx -y oxfmt .
nubx -y oxlint --deny-warnings index.ts web/app.js
```

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
- [ ] add a small command line centered on the screen invoked via cmd-k to modify certain display settings backed up to local storage (toggle tool expansion, thinking showing)
- [ ] input box:
  - [ ] initial support for sending messages via a sticky text input are at the bottom (with ability to both steer and queue via opt+enter and ctrl+enter, enter just creating a new line)
  - [ ] rendering of additional information: cwd, context usage, session cost, model and thinking level.
  - [ ] global hotkey to focus the input box
  - [ ] file autocompletions via @ (both in TUI and RPC modes by inspecting how the pi-fff extension implements it)
  - [ ] command autocompletions support via /
- [ ] questionnaire tool rendering
- [ ] notification system (like in `.pi/agent/extensions/notify.ts`) . I am not yet clear on what it takes to be able to send notifications (need a pwa?) or if we have to deal with a permission prompt for every new session server
- [ ] image support compatible with remote machines:
  - [ ] display images then in the user messages (there seem to be already some support for this in the read tool calls but it's unclear if it would work over the network)
  - [ ] ability to attach images in the input box
- [ ] agentflow and background processes dashboards with status bar below the text input
- [ ] allow to change models with opt-m (needs to be able to show the model selectors offered in pi, at first only the selected models not all of them)
- [ ] add a git diff visualizer using @pierre/diffs

> NOTE: when complexity becomes big enough to justify more type safety (e.g. via the usage of ts bindings of preact and other libs, or using typebox to verify the server updates) we should also think about a very minimal bundling step.
