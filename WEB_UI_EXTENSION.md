# Pi single-session web UI extension

## Status

Design outline for a future implementation session. No implementation has started.

## Goal

Build a Pi extension that exposes the currently running Pi session through a small web UI.

The user starts Pi normally from a terminal in the desired working directory. The extension starts a session-scoped HTTP/WebSocket server, and the user opens that UI locally or from another device, for example through Tailscale.

This is intentionally not a global Pi daemon. It is a companion UI for one Pi process and one active session. It should be useful for checking progress, reviewing tool calls, and sending or aborting work from a phone without reproducing every TUI feature.

A separate daemon that starts and manages Pi instances could be built later on top of the UI and protocol validated here.

## Initial scope

### Included

- Display the active conversation branch.
- Stream assistant text and thinking as they are generated.
- Stream partial and final tool execution output, correlated by tool call ID.
- Expand or collapse individual tool calls.
- Render common built-in tools well, especially `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`.
- Provide a generic fallback for unknown and custom tools.
- Send a new user prompt while idle.
- Send explicit steering or follow-up input while Pi is running.
- Abort the current operation.
- Show basic state such as active model, thinking level, busy/idle status, cwd, and session identity.
- Reconnect after a transient network interruption or extension/session restart.
- Work when Pi is running in normal interactive TUI mode.
- Remain compatible with Pi running in RPC mode.
- Support safe localhost use and a documented Tailscale access path.

### Explicitly omitted from the first draft

- A global daemon that starts Pi in arbitrary directories.
- Managing multiple Pi processes or multiple active sessions.
- Full session browsing and session replacement from the browser.
- Full `/settings`, authentication, provider setup, package management, and extension management.
- Exact parity with arbitrary TUI components, overlays, custom editors, headers, footers, and keybindings.
- Multi-user collaboration semantics.
- Production-grade public internet hosting.

These omissions are acceptable because the first implementation is meant to validate the single-session web UI and its interaction model.

## Why implement it as an extension

A Pi extension can use public APIs to observe and control the session already running in the terminal.

Relevant event hooks include:

- `session_start`, `session_shutdown`, and `session_tree`
- `agent_start`, `agent_end`, and `agent_settled`
- `turn_start` and `turn_end`
- `message_start`, `message_update`, and `message_end`
- `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`
- `model_select` and `thinking_level_select`
- Compaction-related extension events

Relevant control and snapshot APIs include:

- `pi.sendUserMessage()`
- `pi.sendMessage()`
- `ctx.abort()`
- `pi.setModel()`
- `pi.setThinkingLevel()`
- `pi.getActiveTools()` and `pi.getAllTools()`
- `ctx.sessionManager.getEntries()`
- `ctx.sessionManager.getBranch()`
- `ctx.sessionManager.getTree()`
- `ctx.sessionManager.getLeafId()`
- `ctx.getContextUsage()`

Node built-ins and extension-owned npm dependencies are available, so the extension can host HTTP and WebSocket endpoints directly.

## Extension lifecycle

The server must follow Pi's supported extension lifecycle:

1. Do not start sockets, timers, or other long-lived resources in the extension factory.
2. Start the server in `session_start`.
3. Register an idempotent `session_shutdown` handler.
4. On shutdown, stop accepting connections, close WebSockets, clear timers, and close the HTTP server.
5. Expect a fresh extension instance after `/reload`, `/new`, `/resume`, `/fork`, or `/clone`.

The server is session-scoped rather than process-global. Restarting it during session replacement is acceptable. The browser should detect disconnection and reconnect with backoff. Once reconnected, it requests a fresh snapshot and discards stale ephemeral state.

Do not keep the server alive through `globalThis` or retain old `pi`, `ctx`, or `SessionManager` objects across replacement. Pi documents those references as stale after replacement.

## Compatibility with RPC mode

The extension design should work in both TUI and RPC modes because extension hooks and `pi.sendUserMessage()` remain active in RPC mode. The web server is an independent transport alongside RPC stdin/stdout.

RPC-specific requirements:

- Never write diagnostics or access URLs to stdout. RPC stdout must remain valid JSONL.
- Send diagnostics to stderr or an extension-owned log file.
- Do not rely on TUI-only `ctx.ui.custom()` behavior.
- Treat `ctx.ui.notify()` carefully: in RPC mode it becomes an `extension_ui_request`, not a terminal notification.
- Avoid having an external RPC controller and the browser concurrently issue conflicting commands unless command ownership is defined.
- Limit the extension to `ctx.mode === "tui" || ctx.mode === "rpc"`; print and JSON modes are too short-lived for this server.

Running in RPC mode is not required for the normal terminal-started use case, but compatibility prevents the extension from coupling itself unnecessarily to the TUI.

## Server architecture

### Suggested shape

```text
Pi process
  └─ web UI extension
       ├─ Pi event adapter
       ├─ session snapshot builder
       ├─ ephemeral stream reducer
       ├─ HTTP server
       └─ WebSocket transport
            ↕
         browser UI
```

The extension remains the authority for the currently attached Pi session. The browser does not access the filesystem or provider credentials directly.

### HTTP responsibilities

Likely endpoints:

- Static web application assets.
- Initial session snapshot.
- Optional health/version endpoint.
- Optional theme metadata endpoint.

Whether actions use HTTP mutations or WebSocket messages remains open. WebSocket commands are likely sufficient for the first draft.

### WebSocket responsibilities

Server to browser:

- Connection-ready and snapshot messages.
- Assistant streaming updates.
- Tool start/update/end messages.
- Persisted-entry reconciliation messages.
- Model/thinking/busy state changes.
- Session generation changes and shutdown notices.
- Errors that are safe to expose.

Browser to server:

- Prompt.
- Steer.
- Follow-up.
- Abort.
- Optional model and thinking changes.
- Snapshot/resync request.
- Ping/pong or application heartbeat if needed.

## State model

Persisted session entries and ephemeral execution state should remain separate.

### Persisted state

```typescript
type SessionSnapshot = {
  protocolVersion: number;
  generation: string;
  revision: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  leafId: string | null;
  entries: SessionEntry[];
  model?: ModelSummary;
  thinkingLevel?: ThinkingLevel;
  isIdle: boolean;
  activeTools: ToolSummary[];
};
```

The exact wire types should be extension-owned DTOs rather than exposing every internal Pi object unchanged. Sensitive and unnecessary fields should be omitted deliberately.

### Ephemeral state

```typescript
type LiveState = {
  partialAssistant?: AgentMessage;
  runningTools: Map<string, RunningTool>;
  isRunning: boolean;
};
```

`message_update` should replace or patch the current partial assistant message. `tool_execution_update.partialResult` is accumulated output, so the client can replace the current result for that tool call rather than append blindly.

### Persistence timing

Extension `message_end` handling can occur before the corresponding message has been appended to `SessionManager`. This is acceptable for the first draft:

- Render the final message immediately from the event.
- Treat event-derived content as ephemeral until reconciliation.
- At `agent_settled`, build a fresh persisted snapshot or fetch the latest entries from `ctx.sessionManager`.
- Replace ephemeral finalized messages with persisted entries once available.

This avoids depending on undocumented timing while keeping the UI responsive.

### Revisions and reconnection

Each connection should receive a session `generation` and monotonically increasing `revision` or event sequence number.

On any of the following, the browser should request or receive a full snapshot:

- New connection.
- Missed sequence.
- Extension/server restart.
- Session replacement.
- Unknown entry reference.
- Protocol version mismatch.

A first implementation can use full snapshots at `agent_settled`; optimization to incremental persisted-entry patches can follow only if needed.

## Important and optional event coverage

The most important live events are:

1. `message_update`
2. `tool_execution_start`
3. `tool_execution_update`
4. `tool_execution_end`
5. `message_end`
6. `agent_settled`

Missing direct extension equivalents for every `AgentSessionEvent`, such as detailed queue or retry events, are not blockers unless the UI needs to visualize them. Busy state and final reconciliation are enough for the first draft.

Later versions may add retry, compaction, and queued-message status if the public extension API provides enough information.

## Browser rendering strategy

The existing HTML exporter should be used as a behavioral and visual source, but not imported as the live application runtime.

### Public Pi APIs that can be imported safely

- `SessionEntry`, `SessionTreeNode`, and related session types
- Extension event types
- Public model, tool, and thinking-level types
- `Theme` and selected public theme/highlighting helpers
- Built-in tool result/detail types

### Exporter internals that are private

The package export map exposes the package root and `./rpc-entry`. It does not publicly export:

- `exportSessionToHtml`
- `createToolHtmlRenderer`
- `ansiToHtml` or `ansiLinesToHtml`
- `getResolvedThemeColors`
- `getThemeExportColors`
- The exporter templates as JavaScript/CSS modules

The template assets are physically shipped, but locating and reading them through guessed package paths would rely on private layout that differs between npm and compiled-binary distributions.

### Vendoring recommendation

Vendor a deliberately extracted browser rendering layer derived from the exporter, with attribution and an upstream version note. Do not copy the complete static IIFE unchanged.

Good candidates to adapt:

- Theme token names and CSS styling.
- Tree construction, flattening, filtering, and search behavior.
- `SessionEntry` interpretation.
- Built-in tool formatting and expansion behavior.
- Markdown parsing rules and URL scheme policy.
- Syntax highlighting behavior.
- ANSI conversion if server-side TUI renderer output is later supported.
- Existing exporter security and whitespace test cases.

Replace rather than preserve:

- Base64-embedded static session data.
- The monolithic template IIFE.
- Immutable global maps and statistics.
- Inline event handlers.
- Unstructured `innerHTML` updates.
- DOM node caching designed for immutable exports.
- Static-only deep-link and download assumptions.

The vendored code should expose extension-owned rendering DTOs and components so it can evolve independently from Pi's export format.

## Web application architecture

The exact UI framework and state libraries remain open. React is a likely choice but is not required.

A reasonable separation is:

```text
web/
  protocol/
    messages.ts
    validation.ts
  state/
    session-store.ts
    live-reducer.ts
    selectors.ts
  session/
    normalize-entries.ts
    tree.ts
  renderers/
    entry.tsx
    assistant-message.tsx
    tool-call.tsx
    tools/
  markdown/
    render.tsx
    url-policy.ts
  theme/
    pi-theme.ts
  transport/
    websocket.ts
```

Snapshot fetching, mutations, and streaming do not need to use the same state primitive. Potential options include a plain reducer/store, TanStack Query plus a separate streaming reducer, TanStack DB, Zustand, or another library. Select based on the final synchronization model rather than choosing a library in advance.

## Rendering scope

### First-class built-in renderers

Prioritize:

- `bash`: command, streaming output, success/error/cancel state.
- `read`: path/range, syntax-highlighted content, images.
- `write`: path, content preview, result.
- `edit`: path and diff.
- `grep`, `find`, `ls`: compact result lists with expansion.

### Unknown and custom tools

The first draft should show:

- Tool name.
- Arguments as formatted JSON.
- Partial/final text content.
- Images when present.
- Error state.
- Details as optional expandable JSON.

Exact parity with custom TUI `renderCall` and `renderResult` is out of scope initially. A later server-side adapter could invoke trusted TUI renderers and convert ANSI output, but the required exporter helpers are private and would need to be vendored or reimplemented.

### Markdown security

Preserve the exporter's core safety behavior:

- Treat embedded HTML as text rather than executable HTML.
- Escape plain text and tool output.
- Allow-list URL schemes.
- Sanitize generated Markdown HTML.
- Do not trust model output, session content, tool output, filenames, or extension details.
- Avoid inline handlers and establish a Content Security Policy.

## Input and control behavior

### Prompting

When idle, browser input calls `pi.sendUserMessage(content)`.

When busy, the browser must make the intended behavior explicit:

- Steering: `pi.sendUserMessage(content, { deliverAs: "steer" })`
- Follow-up: `pi.sendUserMessage(content, { deliverAs: "followUp" })`

The UI should not silently guess between these modes.

### Abort

Keep the latest current session context while the session is active and call `ctx.abort()` from the HTTP/WebSocket action handler. Clear that reference during shutdown.

### Model and thinking controls

These can use public extension actions. They are optional for the first usable version; read-only display is sufficient initially.

### Session controls

`newSession`, `switchSession`, `fork`, and `navigateTree` are available only on command contexts, not arbitrary server callbacks. They are deliberately omitted from the first draft.

If added later, possible approaches include extension-owned commands invoked through Pi, or a new public Pi API. Do not design the first protocol around an indirect command workaround until needed.

## Tailscale and security

The default server must bind only to loopback.

Recommended remote path:

1. Extension listens on `127.0.0.1`.
2. User exposes it with `tailscale serve`, gaining Tailscale identity and HTTPS without binding Pi directly to every interface.

Alternative direct binding to a Tailscale address may be supported later but should not be the default.

Minimum safeguards:

- Generate a strong per-run access token or use another explicit authentication mechanism.
- Avoid putting long-lived secrets in query strings where they enter history and logs.
- Validate `Origin` for browser requests and WebSocket upgrades.
- Use secure cookies only when served over HTTPS.
- Bound message, image, and tool-output sizes.
- Limit connected clients and outbound buffering.
- Redact server errors before sending them to the browser.
- Never expose provider credentials or environment variables.
- Make JSONL/session download opt-in because a session can contain system prompts, paths, abandoned branches, and sensitive tool output.
- Document that browser actions have the same filesystem and shell authority as the Pi process.

Tailscale reduces network exposure but does not replace application authorization, especially on a shared tailnet.

## Backpressure and performance

Extension event handlers participate in Pi's lifecycle ordering. They must not wait for slow browser clients.

- Convert events to bounded in-memory messages quickly.
- Broadcast without awaiting individual socket drains inside Pi event handlers.
- Coalesce high-frequency text/tool updates to an animation-frame-like interval if needed.
- Disconnect clients that exceed bounded queues.
- Send accumulated partial tool results as replacements.
- Start with full persisted snapshots at settlement; optimize only after measuring real sessions.
- Consider tree or message virtualization only if long sessions demonstrate a need.

## Suggested project structure

```text
pi-web-ui/
  package.json
  src/
    index.ts                  # Extension entry point
    server/
      server.ts
      websocket.ts
      auth.ts
      protocol.ts
      snapshot.ts
      event-adapter.ts
    shared/
      wire-types.ts
    web/
      ...
  test/
    lifecycle.test.ts
    protocol.test.ts
    event-reducer.test.ts
    renderer-fixtures.test.tsx
    security.test.ts
  vendor/
    README.md                 # Upstream source/version and sync notes
```

Whether frontend assets are prebuilt and embedded, copied beside the extension, or served from a package directory remains open.

## Implementation phases

### Phase 1: transport spike

- [ ] Create a minimal extension package.
- [ ] Start an HTTP/WebSocket server from `session_start`.
- [ ] Close it idempotently from `session_shutdown`.
- [ ] Serve a minimal page.
- [ ] Broadcast `message_update` and tool execution events.
- [ ] Send prompts and abort from the page.
- [ ] Confirm behavior in both TUI and RPC modes.
- [ ] Confirm reconnect after `/reload`.

This phase validates the central extension-hosted-server assumption and should be completed before substantial UI work.

### Phase 2: protocol and state model

- [ ] Define versioned snapshot and event DTOs.
- [ ] Implement generation/revision handling.
- [ ] Separate persisted entries from partial assistant/tool state.
- [ ] Resnapshot at `agent_settled`.
- [ ] Add reconnect and missed-sequence recovery.
- [ ] Add bounded buffering and client limits.

Phase 2 depends on the transport spike but can proceed independently from visual renderer work once wire fixtures exist.

### Phase 3: vendored rendering foundation

- [ ] Record the exporter source version and attribution.
- [ ] Extract/adapt tree and `SessionEntry` logic.
- [ ] Adapt theme tokens and CSS.
- [ ] Implement safe Markdown rendering.
- [ ] Implement built-in tool renderers.
- [ ] Implement generic custom-tool fallback.
- [ ] Port relevant exporter fixtures and security tests.

This can run in parallel with Phase 2 using saved session/event fixtures.

### Phase 4: usable single-session UI

- [ ] Conversation timeline with partial streaming.
- [ ] Individual tool expansion.
- [ ] Responsive phone layout.
- [ ] Prompt/steer/follow-up editor.
- [ ] Abort control and busy state.
- [ ] Model/thinking display.
- [ ] Connection/reconnect state.
- [ ] Optional read-only session tree.

### Phase 5: remote-use hardening

- [ ] Loopback-only default.
- [ ] Authentication and origin checks.
- [ ] Document `tailscale serve` setup.
- [ ] CSP and Markdown/XSS review.
- [ ] Payload/output limits.
- [ ] Slow-client and disconnect tests.
- [ ] Verify no RPC-mode stdout contamination.

### Phase 6: optional follow-ups

- [ ] Model and thinking controls.
- [ ] Better custom tool renderer support.
- [ ] Queue/retry/compaction visualization.
- [ ] Read-only abandoned branch browsing.
- [ ] Session-control commands if a clean public mechanism is identified.
- [ ] Separate daemon for starting and managing Pi instances.

## Verification strategy

### Extension lifecycle

- Normal startup and shutdown.
- `/reload` cleanup and rebinding.
- New/resumed/forked session cleanup.
- Port-release failure and retry behavior.
- Exceptional startup after partial resource allocation.
- WebSocket cleanup on session shutdown.

### Event correctness

- Streaming text and thinking.
- Parallel interleaved tools correlated by `toolCallId`.
- Accumulated partial tool results.
- Tool success, error, image, and cancellation.
- Final persisted snapshot after settlement.
- Reconnect during and after a turn.

### Mode compatibility

- Interactive TUI mode remains responsive.
- RPC mode stdout remains strict JSONL.
- Browser commands work in TUI and RPC modes.
- Print and JSON modes do not leave a server running.

### Security

- Markdown script and unsafe URL fixtures.
- Malicious filenames, tool arguments, and tool output.
- Oversized messages and images.
- Missing/invalid authentication.
- Invalid WebSocket origin.
- Slow-client buffer exhaustion.

### Herdr lifecycle integration

When implementing the extension, audit interaction with the generated `.pi/agent/extensions/herdr-agent-state.ts` authority and never edit that generated file.

The autonomous HTTP/WebSocket server and event broadcasting are not blocked human-input scopes. If a future feature makes Pi await a browser approval or other human decision, emit balanced local `herdr:blocked` active/inactive events with cleanup in `finally`, including cancellation, disconnect, reload, shutdown, and exceptional paths.

## Open questions

1. Which HTTP/WebSocket framework, if any, should the extension use?
2. Which frontend framework and build system should be used?
3. Which state layer best fits snapshots plus high-frequency ephemeral updates: a custom reducer, TanStack DB, TanStack Query plus another store, Zustand, or something else?
4. Should static frontend assets be embedded, copied into the package, or served from a resolved package directory?
5. What is the smallest authentication flow that remains convenient from a phone?
6. Should `tailscale serve` be the only documented remote path for the first version?
7. Should multiple browser clients be read-only except for one controller, or can all authenticated clients issue commands?
8. Should the first version expose only the active branch or also a read-only full session tree?
9. How closely should web rendering track Pi's TUI versus the existing HTML exporter?
10. Should custom TUI tool renderers eventually be rendered server-side, or is structured generic rendering sufficient?
11. How should Pi theme colors be obtained without importing private exporter helpers?
12. Should the server restart on every session replacement, or should a later Pi API provide a process-scoped extension service lifecycle?
13. Is full-snapshot reconciliation at every `agent_settled` sufficient for expected session sizes?
14. Should command requests receive immediate acceptance responses, completion responses, or both?
15. How should browser control interact with a simultaneous external RPC controller?
16. Which exporter tests and fixtures can be reused directly under the repository license, and what attribution should the vendored directory carry?

## Relevant Pi sources

- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/docs/rpc.md`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/export-html/index.ts`
- `packages/coding-agent/src/core/export-html/template.js`
- `packages/coding-agent/src/core/export-html/template.css`
- `packages/coding-agent/src/core/export-html/tool-renderer.ts`
- `packages/coding-agent/src/core/export-html/ansi-to-html.ts`
- `packages/coding-agent/package.json`
- `packages/server/`
