# Web UI (simple)

A deliberately tiny, read-only browser companion for the current Pi session. It
serves a single-column transcript that mirrors Pi's HTML exporter — user and
assistant messages, thinking, Markdown, images, bash execution, tool calls with
results, compactions, branch summaries, model changes, and custom messages.

There is no build step, no server dependencies beyond Node built-ins, and no wire
protocol: every relevant Pi event simply re-broadcasts a fresh full snapshot of
the active branch over Server-Sent Events.

## Usage

The server starts automatically at `session_start` in **TUI** and **RPC** modes
and binds to loopback only (`127.0.0.1`, ephemeral port) under a random path.

- In TUI, a notification shows the base URL and copy command.
- In RPC, the URL is written to stderr.

To open it, run:

```
/copy-web-ui-simple-url
```

This copies an authenticated link
(`http://127.0.0.1:<port>/<random-path>/#code=<one-time>`) to your clipboard. Paste it into a browser on the same machine. The page renders
live and updates as the session progresses. It is **read-only** — there is no
composer, command input, or any way to act on the session from the browser.

## How it works

- **Static assets** (`web/index.html`, `web/app.js`, `web/styles.css`) are served
  directly from disk. The browser loads Preact + hooks + htm + marked from a CDN
  as native ES modules — nothing is bundled or installed.
- **Auth**: the one-time code carried in the URL fragment is POSTed to `auth`,
  which exchanges it for a random, path-scoped `HttpOnly; SameSite=Strict` cookie.
  The `events` SSE stream requires that cookie. The code is single-use; the
  fragment never reaches the server during navigation.
- **Snapshots**: on connect, after message/tool/session events, and when a small
  freshness check notices an otherwise unannounced session append, the server
  sends `{ header, entries, leafId, sessionName, isRunning, theme }` for the
  current branch. In-progress assistant messages and running tool executions are
  overlaid as synthetic entries until they are persisted. The browser follows
  Pi's configured theme; automatic light/dark pairs follow the browser color
  scheme.
- The server closes cleanly on `session_shutdown`.

## Scope / intentionally omitted

This extension is the minimal read-only milestone. It does **not** include the
exporter's sidebar/session tree or metadata/tool-map header, and it deliberately
omits browser input, pagination, virtualization, WebSockets, remote/Tailscale
networking, dashboards, provider controls, a broad security/CSP layer, and any
configuration system. Syntax highlighting is not included; code blocks render as
plain monospaced text. The browser must be online and trusts the pinned Preact,
htm, and marked modules served by esm.sh; this is the explicit tradeoff of the
requested no-build-tools route for this first local-only milestone.

## Development checks

The extension intentionally has no `package.json`. Run the formatter and linter
without installing project dependencies:

```sh
nubx -y oxfmt .
nubx -y oxlint --deny-warnings index.ts web/app.js
```

## Roadmap

- [ ] improve scroll behavior: stick to the bottom or stay fixed
- [ ] hotkey support for showing thinking and expanding tool calls
      -> might be using tanstack hotkeys and some state management library such as tanstack store to persist this state to localstorage (demo of how in `~/Documents/Codex/2026-07-25/can/outputs/tiny-atoms-experiment`)
- [ ] tool call rendering parity for our custom setup: custom edit/write tool rendering, pi-fff, agentflow and background-processes tool)
- [ ] add a small command line centered on the screen invoked via cmd-k to modify certain display settings backed up to local storage (toggle tool expansion, thinking showing)
- [ ] input box:
  - [ ] initial support for sending messages via a sticky text input are at the bottom
  - [ ] rendering of additional information: cwd, context usage, session cost, model and thinking level.
  - [ ] global hotkey to focus the input box
  - [ ] file autocompletions via @ (both in TUI and RPC modes by inspecting how the pi-fff extension implements it)
  - [ ] command autocompletions support via /
  - [ ] support for

when complexity becomes big enough to justify more type safety (e.g. via the usage of ts bindings of preact and other libs, or using typebox to verify the server updates) we should also think about a very minimal bundling step.

- [ ] tailscale server command spawned in paralle with the node http server and adjust the copy url command.
