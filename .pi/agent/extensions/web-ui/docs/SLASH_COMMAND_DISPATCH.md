# Pi input, command, and reload control from the Web UI

## Status and scope

This is a research note for `web-ui`, based on the installed and current Pi release,
`@earendil-works/pi-coding-agent` **0.82.1** (released 2026-07-25).

The original question was whether the browser can use current Pi APIs or RPC mode to:

- invoke prompt templates;
- invoke skills explicitly;
- invoke extension slash commands;
- invoke built-in commands such as `/reload`, `/new`, `/resume`, and `/model`;
- obtain slash and argument completions;
- complete commands that open extension UI.

The short answer is mode-dependent:

1. **A stock in-process extension still has no supported canonical input dispatcher.**
2. **A daemon that owns a `pi --mode rpc` child can dispatch extension commands, prompt
   templates, and skills correctly through RPC `prompt`.** This is the cleanest current path
   for managed sessions.
3. **RPC built-ins are structured commands, not TUI slash text.** Many important operations
   are available, but reload and some interactive operations are missing.
4. **Reload can currently be reached in managed RPC through a small extension command whose
   handler calls `ctx.reload()`, then invoking that command through RPC `prompt`.**
5. **TUI mode has a public-API-based but unsupported editor-capture workaround** that reaches
   the real interactive submit path. It is useful as a local experiment, not a remote security
   boundary.
6. **Standard extension dialogs can be bridged in RPC mode.** Arbitrary `ctx.ui.custom()`
   cannot.

This changes the earlier conclusion that all executable slash support must remain blocked. It
remains blocked for a normal standalone extension path, but it is feasible in daemon-managed RPC
sessions now.

## The three input paths are not equivalent

### `pi.sendUserMessage()` from an extension

`pi.sendUserMessage()` is intentionally literal. In 0.82.1 it calls:

```ts
session.prompt(text, {
  expandPromptTemplates: false,
  streamingBehavior: options?.deliverAs,
  images,
  source: "extension",
});
```

The call still emits the `input` event, which is why `web-ui` can use its current input hook
as an admission signal. It does **not** run extension-command recognition, skill expansion, or
prompt-template expansion.

Consequences:

- `pi.sendUserMessage("/review")` sends `/review` to the model as ordinary user text;
- `pi.sendUserMessage("/skill:foo")` does not load the skill;
- `pi.sendUserMessage("/some-extension-command")` does not invoke the handler;
- queuing one of those strings as `steer` or `followUp` does not defer command execution—it
  queues literal user text.

The shipped `reload-runtime.ts` example still suggests queuing `/reload-runtime` through
`sendUserMessage()`. Source inspection confirms that this example cannot dispatch the command.
The same bug has been reported repeatedly upstream, including
[#6149](https://github.com/earendil-works/pi/issues/6149) and
[#6574](https://github.com/earendil-works/pi/issues/6574).

### Canonical `AgentSession.prompt()`

The SDK/session prompt path performs the behavior we want:

1. recognize and execute extension commands;
2. emit the `input` event;
3. expand `/skill:name`;
4. expand prompt templates and arguments;
5. prompt immediately or queue as steer/follow-up;
6. report preflight acceptance.

This method is public to SDK hosts, but the current live `AgentSession` is not exposed to an
in-process extension. Creating a second SDK session inside `web-ui` would create a second
conversation, resource loader, queue, and lifecycle; it would not control the existing Pi session.

### Interactive editor submit

The TUI's editor submit handler sits above `AgentSession.prompt()`. It additionally recognizes
built-in interactive commands and user bash:

- built-ins such as `/settings`, `/model`, `/resume`, `/tree`, and `/reload`;
- extension commands;
- prompt templates and skills;
- ordinary prompts;
- `!` and `!!` user bash.

That handler is intentionally a TUI concern. RPC does not send built-in slash text through it.

## Capability matrix

| Capability                        | Stock extension                | Managed RPC child                                         | TUI editor-capture experiment    |
| --------------------------------- | ------------------------------ | --------------------------------------------------------- | -------------------------------- |
| Ordinary prompt                   | `sendUserMessage()`            | `prompt`                                                  | Native submit                    |
| Prompt template execution         | No canonical path              | `prompt`                                                  | Native submit                    |
| Skill execution                   | No canonical path              | `prompt`                                                  | Native submit                    |
| Extension command execution       | No canonical path              | `prompt`                                                  | Native submit                    |
| Extension command while busy      | No                             | RPC `prompt` executes it immediately                      | Native behavior                  |
| Template/skill steer or follow-up | No canonical expansion         | `prompt` with `streamingBehavior`, or `steer`/`follow_up` | Native behavior                  |
| Command-name discovery            | `pi.getCommands()`             | `get_commands`                                            | Captured autocomplete provider   |
| Extension argument completion     | Not exposed by `getCommands()` | Not exposed                                               | Captured autocomplete provider   |
| Built-in discovery                | Not exposed                    | Not exposed                                               | Captured autocomplete provider   |
| Model/thinking controls           | Public extension APIs          | Typed RPC commands                                        | Native commands                  |
| Abort                             | `ctx.abort()`                  | `abort`                                                   | Native shortcut/submit semantics |
| Compact                           | `ctx.compact()`                | `compact`                                                 | `/compact`                       |
| New/switch/fork/clone             | Command context only           | Typed RPC commands                                        | Native commands                  |
| Tree navigation                   | Command context only           | No typed RPC command                                      | `/tree` terminal UI              |
| Reload                            | Command context only           | No typed RPC command; bridge command works                | `/reload`                        |
| Standard extension dialogs        | Current TUI only               | Supported request/response protocol                       | Current TUI only                 |
| Arbitrary `ctx.ui.custom()`       | TUI only                       | Returns `undefined`                                       | TUI only                         |

## What `pi.getCommands()` does and does not provide

`pi.getCommands()` and RPC `get_commands` return:

- extension commands, including duplicate invocation suffixes such as `/review:1`;
- prompt templates;
- skills as `/skill:name`;
- descriptions and canonical source provenance.

They do not return:

- command handlers;
- extension `getArgumentCompletions()` callbacks;
- prompt or skill bodies;
- built-in TUI commands;
- a browser-safety or non-interactivity declaration.

The result is sufficient for command-name completion and provenance display. It is not an
invocation capability or an authorization list. Results must be tied to the current runtime
generation because reload and session replacement can change the registry.

## Supported solution for managed sessions: daemon-owned RPC

The planned daemon already launches `pi --mode rpc`. It should be the **only writer** to the
child's stdin and the **only parser** of child stdout. In that architecture the browser does not
need the extension to call back into its own session.

A suitable flow is:

```text
browser
  -> authenticated daemon/session command route
  -> daemon validates role, generation, command id, and delivery mode
  -> daemon writes one correlated RPC command to child stdin
  -> Pi performs canonical dispatch
  -> daemon returns the authoritative RPC response
  -> normal Pi/session events update the browser
```

### Prompt templates, skills, and extension commands

Use RPC `prompt` with the unchanged browser input:

```json
{
  "id": "browser-command-id",
  "type": "prompt",
  "message": "/review src/auth.ts"
}
```

Pi 0.82.1 handles extension commands first and otherwise emits the input event before skill and
template expansion. While the agent is running:

- an extension command submitted through RPC `prompt` executes immediately;
- a prompt template or skill requires `streamingBehavior: "steer" | "followUp"`;
- RPC `steer` and `follow_up` also expand templates and skills, but explicitly reject extension
  commands.

The successful RPC response means the input was accepted, queued, or handled. It is not a promise
that a later model run will succeed.

### Built-in operations

Do not send TUI built-ins as slash text. Use typed RPC commands where available:

- `abort`;
- `new_session`, `switch_session`, `fork`, and `clone`;
- `set_model`, `cycle_model`, and model discovery;
- thinking-level controls;
- `compact` and auto-compaction controls;
- queue-mode controls;
- `set_session_name`;
- `export_html`;
- state, messages, entries, tree, stats, and fork-message queries;
- direct user bash, if the product explicitly chooses to expose it.

RPC `prompt` explicitly does not execute built-in TUI commands. Missing typed operations include
reload and in-place `navigateTree`; terminal-oriented settings, hotkeys, trust, login/logout,
selectors, copy/share, and similar commands also need dedicated product decisions.

### RPC concurrency is not a scheduler

Pi's RPC line reader calls `void handleInputLine(line)`. Multiple command handlers can therefore
overlap. Request IDs correlate responses but do not provide deduplication or serialization.

The daemon must provide:

- one mutation scheduler per launch and generation;
- current-generation validation immediately before each stdin write;
- browser command-id replay protection;
- explicit busy-state admission;
- no automatic retry after an ambiguous child/daemon failure;
- a high-priority path for matching `extension_ui_response`, abort, and cancellation traffic.

Dialog responses must bypass a queue occupied by the command waiting for that dialog, or the system
will deadlock.

## Managed reload decision

`ctx.reload()` exists only on `ExtensionCommandContext`. HTTP callbacks, tools, and ordinary event
handlers receive `ExtensionContext`, and Pi 0.82.1 has no RPC `reload` command;
[#6173](https://github.com/earendil-works/pi/issues/6173) records that gap.

A narrow extension command whose handler calls `ctx.reload()` can technically be invoked through RPC
`prompt`. The RPC-first dashboard deliberately does **not** select that bridge as its managed reload
path: it has no typed reload-complete response, depends on the runtime being reloaded, and creates a
second lifecycle beside the crash/recovery path.

Managed reload is instead idle-only supervised process replacement:

1. verify no streaming, compaction, pending messages, or unresolved dialog;
2. fence new mutations and invalidate the current generation;
3. stop the old process group under a deadline;
4. spawn a fresh `pi --mode rpc` child with the same validated cwd/config and last confirmed session;
5. verify readiness and session identity through `get_state`;
6. publish a reset under a new generation.

This intentionally discards volatile extension state and queues. The daemon must never replay an
uncertain prompt. A typed upstream RPC reload operation with an explicit completion boundary would be
a reason to revisit process replacement.

## Standard interactive extension commands in RPC mode

RPC already has a supported extension UI sub-protocol.

Commands that call these methods can be browser-driven:

- `ctx.ui.select()`;
- `ctx.ui.confirm()`;
- `ctx.ui.input()`;
- `ctx.ui.editor()`.

Pi emits an `extension_ui_request` and waits for a matching `extension_ui_response`. Fire-and-forget
notifications, status, widgets, title, and editor text also arrive as extension UI requests.

A daemon/browser bridge must scope each pending request to:

- launch id and runtime generation;
- controller identity/lease;
- request id and method;
- an explicit deadline;
- exactly one response.

It must cancel or resolve requests on browser disconnect, controller loss, timeout, abort, reload,
session replacement, process exit, and daemon shutdown. These waits genuinely block Pi on a human
answer, but the external daemon cannot emit child-local `herdr:blocked` events by itself. Generic
browser answering therefore remains disabled until the waiting extension is audited to balance the
events itself or a concrete child/upstream hook can emit active/inactive in `finally` on every path.

Limits:

- `ctx.ui.custom()` returns `undefined` in RPC mode;
- component factories, custom editor components, custom headers/footers, theme manipulation, and
  direct TUI state are unavailable or degraded;
- commands using those facilities need a dedicated browser protocol or must remain terminal-only.

Until standard dialog bridging has its lifecycle tests, unsupported requests should be cancelled
rather than left hanging.

## Standalone TUI experiment: capture the custom editor

There is one unexpectedly powerful path using public TUI extension APIs.

`ctx.ui.setEditorComponent(factory)` installs an extension-provided editor. Pi's
`InteractiveMode.setCustomEditorComponent()` then wires the default editor's real `onSubmit` callback
onto that editor. If the extension retains the created `CustomEditor` instance, an HTTP callback can
later invoke its wired submission callback.

Conceptually:

```ts
let remoteEditor: CustomEditor | undefined;

ctx.ui.setEditorComponent((tui, theme, keybindings) => {
  const editor = new CustomEditor(tui, theme, keybindings);
  remoteEditor = editor;
  return editor;
});

// Later, from a local browser request:
remoteEditor?.onSubmit?.("/reload");
```

This reaches the actual interactive submit dispatcher and can therefore execute:

- prompt templates and skills;
- extension commands;
- built-in commands;
- normal prompts;
- user bash.

The same captured TUI autocomplete provider can be queried through its public
`getSuggestions()` method. Unlike `pi.getCommands()`, it contains:

- built-in command names;
- prompt templates and argument hints;
- enabled skill commands;
- extension command argument-completion callbacks;
- built-in model and login argument completion.

`web-ui` already captures the active provider with `addAutocompleteProvider()` for file
completion, so a TUI-only slash-completion spike is small.

### Why this is not a production control API

The editor path is an implementation side effect, not a documented dispatch contract:

- `onSubmit` has no authoritative accepted/rejected/disposition result;
- it races real terminal input;
- repeated remote calls can reorder or interact with the TUI's pending-input state;
- dialogs and selectors open in the terminal, not the browser;
- extension commands bypass the input event, so the current admission handshake does not cover
  them;
- another extension may own or replace the custom editor;
- replacing the default editor risks visual and behavioral conflicts;
- reload and session replacement invalidate the retained instance;
- `/reload` tears down the server handling the browser request;
- it exposes high-impact built-ins and `!` shell execution if left unrestricted.

If we spike it at all, constrain it to local standalone TUI use:

- wrap the previously configured editor factory rather than blindly replacing it;
- allow one in-flight submission;
- bind every request to the current generation;
- clear the retained editor in `session_shutdown`;
- allowlist only the command classes being evaluated;
- reject bash, trust/auth, import, quit, and other high-impact built-ins;
- return only an enqueue acknowledgement and infer eventual effects from session events;
- never expose it as the managed or tailnet authorization boundary.

This experiment is useful evidence that standalone parity is technically possible without patching
Pi, but hardening it indefinitely would be worse than adding a small upstream dispatch API.

## Other workarounds considered

### Reimplement template and skill expansion in the `input` event

Because extension-originated messages still emit `input`, `web-ui` could recognize its own
slash input and return `{ action: "transform" }` after reading template/skill files from
`sourceInfo.path`.

This can be made to work for templates and skills only. It duplicates:

- frontmatter parsing;
- template argument parsing/defaults/slicing;
- skill formatting and relative-path context;
- precedence and collision behavior;
- diagnostics and future Pi changes.

It still cannot execute arbitrary extension handlers or built-ins. It is therefore a poor fallback
unless a very narrow standalone template-only feature is urgently needed.

### Shared implementation for commands owned by this extension

For a command implemented by `web-ui`, its handler and HTTP endpoint can call a shared helper.
This is clean for operations whose helper only needs `ExtensionContext`-level capabilities.

It does not solve arbitrary third-party commands, and it does not provide `ctx.reload()`,
`newSession()`, `switchSession()`, `fork()`, or `navigateTree()` because those capabilities are only
supplied in command context.

### Cooperative event-bus APIs

Other extensions can voluntarily expose typed operations through `pi.events`. This is useful for
Agentflow/background status and purpose-built actions, but it is not generic slash dispatch.

### Inject synthetic data into RPC stdin

In RPC mode, Node code could theoretically call `process.stdin.emit("data", ...)` and trick the
existing RPC line reader into handling a synthetic command. This is private runtime manipulation:
it leaks a response to the real RPC owner, has no supported correlation path back to the extension,
and can break stream/parser assumptions. Do not use it.

### Import private runner/session internals

Package exports do not expose the current `AgentSession` or `ExtensionRunner` to an extension.
Absolute-path imports would still not yield the live instance. Monkey-patching module files or
reflecting through implementation objects is version-fragile and fails across reload.

### Spawn a second Pi or SDK session

A second process/session does not control the existing conversation and risks concurrent access to
the same session file. An SDK host is viable only if it replaces the CLI/RPC host and owns the
entire lifecycle; it is not an add-on inside this extension.

## Minimal patch and long-term upstream shape

If standalone executable slash support becomes a product requirement before upstream support, a
small maintained package patch is safer than the editor trick.

The preferred API is a canonical input operation backed by the existing `AgentSession.prompt()`:

```ts
const result = await pi.dispatchInput(text, {
  images,
  streamingBehavior: "steer",
});
```

It should:

- execute extension commands with canonical duplicate-name resolution;
- emit the normal input event;
- expand skills and templates;
- accept images;
- distinguish immediate prompt, steer, follow-up, handled input, and command;
- report authoritative preflight acceptance/rejection;
- reject stale extension runtimes;
- define reentrancy and busy-state behavior explicitly.

Built-in TUI commands should remain structured operations rather than being folded into this API.
Reload should be a separate public capability or typed RPC command.

Related upstream proposals have been closed without implementation:

- generic extension dispatch: [#5367](https://github.com/earendil-works/pi/issues/5367);
- `ExtensionAPI.executeCommand`: [#6010](https://github.com/earendil-works/pi/issues/6010);
- broad remote-control API RFC: [PR #5140](https://github.com/earendil-works/pi/pull/5140);
- RPC reload: [#6173](https://github.com/earendil-works/pi/issues/6173).

The closures mostly contain repository automation rather than a detailed maintainer design
rejection, although the resulting `no-action` labels mean we should not plan around imminent
upstream support.

## Recommended product decision

### Standalone mode

- Keep ordinary prompt/steer/follow-up through `sendUserMessage()`.
- Add command-name completion from `pi.getCommands()` if useful, but label it as discovery until an
  executable path is selected.
- Optionally spike captured TUI autocomplete and editor submission locally to measure viability.
- Do not ship generic executable raw slash input over tailnet using the editor workaround.
- Use public structured extension APIs for model, thinking, abort, compaction, and extension-owned
  actions.

### Managed mode

- Route executable input through the daemon's sole RPC controller.
- Use `get_commands` for extension/template/skill discovery.
- Use RPC `prompt` for canonical execution of those three command classes.
- Use typed RPC operations for built-in semantics.
- Implement managed reload as supervised process replacement plus verified session resume; do not
  require a reload bridge extension.
- Bridge standard extension dialogs only after role, generation, timeout, cancellation, and a
  child-local Herdr lifecycle owner exist.
- Keep `ctx.ui.custom()` and unsupported terminal-only built-ins unavailable.

### Long term

- Propose or carry a focused canonical extension input API plus typed reload.
- Remove the editor experiment once that API exists.
- Consider an SDK-owned host only if the browser becomes the primary Pi mode and the project is
  willing to replace, rather than supplement, the CLI/RPC lifecycle.

## Verification spikes before implementation

1. **Managed canonical dispatch fixture**
   - register one extension command;
   - add one prompt template and one skill;
   - invoke all three through RPC `prompt`;
   - verify extension command execution versus expanded user text;
   - verify immediate, steer, and follow-up behavior.

2. **Reload replacement fixture**
   - require an idle child and record its confirmed session identity;
   - stop and respawn the process, resuming the same validated session;
   - verify old-generation rejection and stable-route `503` during replacement;
   - verify no queued or ambiguously accepted prompt is replayed.

3. **RPC dialog fixture**
   - invoke commands using `select`, `confirm`, `input`, and `editor`;
   - answer through `extension_ui_response` while the mutation scheduler is occupied;
   - test timeout, controller disconnect, abort, reload, and process exit;
   - assert balanced Herdr blocked events.

4. **TUI editor-capture spike**
   - preserve the existing editor appearance and any prior editor factory;
   - invoke a template, skill, extension command, benign built-in, and reload;
   - test concurrent terminal input and two rapid browser submissions;
   - verify that reload clears the retained editor and reconnects to a new generation;
   - discard the approach if it conflicts with other custom-editor extensions or cannot provide
     reliable admission semantics.

5. **Completion fixture**
   - compare `pi.getCommands()`, RPC `get_commands`, and captured TUI autocomplete;
   - cover duplicate extension names, template argument hints, disabled skill commands, extension
     argument callbacks, stale generations, and built-in omission.
