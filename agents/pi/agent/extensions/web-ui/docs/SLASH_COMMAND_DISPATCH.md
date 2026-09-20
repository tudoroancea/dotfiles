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
2. **A daemon that owns the typed SDK `AgentSession` can dispatch extension commands, prompt templates, and skills correctly through `session.prompt()`.** Phase 0D selects this path for managed sessions.
3. **A daemon-owned `pi --mode rpc` child has the same canonical prompt behavior** and remains the process-isolated fallback.
4. **Built-in TUI slash commands remain structured operations.** `AgentSessionRuntime` directly provides new, switch, fork, clone, import, and tree-navigation behavior that is missing or less complete in RPC.
5. **TUI mode has a public-API-based but unsupported editor-capture workaround** that reaches the real interactive submit path. It is useful as a local experiment, not a remote security boundary.
6. **Standard extension dialogs can be supplied by a daemon-owned SDK UI context.** Arbitrary `ctx.ui.custom()` is not serialized.

Executable slash support remains blocked for a normal standalone extension path, but it is feasible in daemon-managed SDK hosts and RPC fallback workers.

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

| Capability                    | Stock extension        | Managed typed SDK host                                     | RPC fallback child             | TUI editor-capture experiment |
| ----------------------------- | ---------------------- | ---------------------------------------------------------- | ------------------------------ | ----------------------------- |
| Ordinary prompt               | `sendUserMessage()`    | `session.prompt()`                                         | RPC `prompt`                   | Native submit                 |
| Prompt template/skill         | No canonical path      | `session.prompt()`                                         | RPC `prompt`                   | Native submit                 |
| Extension command             | No canonical path      | `session.prompt()`                                         | RPC `prompt`                   | Native submit                 |
| Template/skill queueing       | No canonical expansion | `prompt` with `streamingBehavior`, `steer()`, `followUp()` | `prompt`, `steer`, `follow_up` | Native behavior               |
| Command-name discovery        | `pi.getCommands()`     | bound resources/runner commands                            | `get_commands`                 | Captured provider             |
| Extension argument completion | Not exposed            | Not exposed                                                | Not exposed                    | Captured provider             |
| Built-in discovery            | Not exposed            | Not exposed                                                | Not exposed                    | Captured provider             |
| Model/thinking                | Public extension APIs  | typed session methods                                      | typed RPC commands             | Native commands               |
| Abort/compact                 | Context APIs           | typed session methods                                      | typed RPC commands             | Native commands               |
| New/switch/fork/clone/import  | Command context only   | `AgentSessionRuntime`                                      | typed RPC except import        | Native commands               |
| Tree navigation               | Command context only   | `session.navigateTree()`                                   | No typed mutation              | `/tree`                       |
| Reload                        | Command context only   | complete host-bundle replacement                           | process replacement            | `/reload`                     |
| Standard dialogs              | Current TUI only       | daemon SDK UI context                                      | RPC sub-protocol               | Current TUI only              |
| Arbitrary `ctx.ui.custom()`   | TUI only               | Not serialized                                             | Returns `undefined`            | TUI only                      |

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

## Supported solution for managed sessions: daemon-owned SDK

Phase 0D selects a daemon-owned `AgentSessionRuntime` behind a host-neutral `SessionHost` adapter. The browser does not ask an extension to call back into its own session.

```text
browser
  -> authenticated daemon/session command route
  -> daemon validates role, generation, command id, bounds, and delivery mode
  -> SessionHost invokes a public typed SDK method
  -> Pi performs canonical dispatch
  -> preflight reports admission; typed events report later completion
  -> projected session state updates the browser
```

### Prompt templates, skills, and extension commands

Call `session.prompt()` with unchanged browser input and prompt expansion enabled. Pi 0.82.1 recognizes extension commands first, otherwise emits the input event, expands skills/templates, and prompts or queues according to `streamingBehavior`.

- extension commands execute through `session.prompt()` even while the agent is busy;
- templates/skills use `streamingBehavior: "steer" | "followUp"` while busy;
- `session.steer()` and `session.followUp()` expand templates/skills but reject extension commands.

For ordinary model prompts, `preflightResult(true)` means accepted or queued, not eventual success. `preflightResult(false)` is pre-acceptance rejection. Pi 0.82.1 invokes handled extension-command preflight only after the command handler finishes, so handled responses are completion-bound and must not be assumed to precede side effects.

### Structured operations

Do not send TUI built-ins as slash text. Map daemon-owned command unions to public SDK methods:

- `abort()`, `compact()`, and retry/queue controls;
- `setModel()`, model cycling, and thinking controls;
- `AgentSessionRuntime.newSession()`, `switchSession()`, `fork()`, clone, and `importFromJsonl()`;
- `session.navigateTree()`;
- direct bounded `SessionManager` state/tree/entries access;
- session naming and other explicitly supported operations.

Terminal-oriented settings, hotkeys, trust, login/logout, selectors, copy/share, arbitrary tool execution, and user bash need dedicated product decisions.

### Admission is still a scheduler

Direct method calls remove RPC writer/correlation concerns, not browser concurrency policy. The daemon still provides one ordinary admission path per launch, generation and replay checks immediately before invocation, explicit busy-state fencing, no retry after ambiguous acceptance, and an interrupt path for dialog cancellation, abort, lease loss, unload, and stop.

### Managed reload and replacement

Managed reload is idle-only complete host-bundle replacement, never `session.reload()`:

1. verify no streaming, compaction, pending messages, or unresolved dialog;
2. fence mutations and invalidate the generation;
3. create and verify a fresh independent settings/model/loader/event-bus/session bundle from the last confirmed session;
4. swap the adapter, dispose the retired bundle, and clear only its bus;
5. publish a new host epoch and reset.

`AgentSessionRuntime` new/switch/fork/clone/import paths are destructive if replacement creation fails because the old session is torn down first. Their adapter path must fence, keep candidate bus ownership private until success, enter failed/recovery state on error, and never replay uncertain work.

The measured RPC fallback uses the same browser contracts. If isolation triggers fire, prefer a process-isolated typed SDK worker; use CLI RPC when it is the fastest safe fallback or public SDK hosting lacks a required capability.

## Standard interactive extension commands in RPC mode

RPC already has a supported extension UI sub-protocol.

Commands that call these methods can be browser-driven:

- `ctx.ui.select()`;
- `ctx.ui.confirm()`;
- `ctx.ui.input()`;
- `ctx.ui.editor()`.

A daemon-owned SDK UI context creates equivalent bounded requests and waits for a matching daemon response. Fire-and-forget notifications, status, widgets, title, and editor text become projected provider/UI operations only when the managed product supports them.

A daemon/browser bridge must scope each pending request to:

- launch id and runtime generation;
- controller identity/lease;
- request id and method;
- an explicit deadline;
- exactly one response.

It must cancel or resolve requests on browser disconnect, controller loss, timeout, abort, reload, session replacement, host unload/failure, and daemon shutdown. Managed hosts exclude Herdr; the daemon-owned UI context must still balance every pending request in `finally` across all completion and exceptional paths.

Limits:

- `ctx.ui.custom()` is not serialized by managed SDK hosts;
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

- Route executable input through the daemon's host-neutral SDK `SessionHost` adapter.
- Discover extension/template/skill commands from the bound resources/extension runner.
- Use `session.prompt()` for canonical execution of those command classes.
- Use public typed SDK methods for structured semantics.
- Implement managed reload as complete verified host-bundle/event-bus replacement; never call `session.reload()`.
- Bridge standard dialogs only after role, generation, timeout, cancellation, and exactly-once daemon UI-context cleanup exist.
- Keep `ctx.ui.custom()` and unsupported terminal-only built-ins unavailable.

### Long term

- Propose or carry a focused canonical extension input API plus typed reload.
- Remove the editor experiment once that API exists.
- Keep the SDK-owned host behind a process-neutral adapter and migrate to typed workers when measured isolation or scale triggers fire.

## Verification spikes before implementation

1. **Managed canonical dispatch fixture**
   - register one extension command;
   - add one prompt template and one skill;
   - invoke all three through SDK `session.prompt()`;
   - verify handled-command completion-bound preflight versus ordinary callback-before-settlement;
   - verify immediate, steer, follow-up, abort, post-acceptance failure, and no replay.

2. **Reload and transition fixture**
   - require an idle host and record confirmed session identity;
   - rotate the complete host bundle and event bus;
   - inject create/load/bind/verify/dispose failures for new/switch/fork/clone/import;
   - verify old-generation rejection, failed/recovery state, sibling isolation, and no replay.

3. **SDK dialog fixture**
   - invoke commands using `select`, `confirm`, `input`, and `editor`;
   - answer through the daemon UI context while ordinary admission is occupied;
   - test timeout, controller disconnect, abort, replacement, unload, and daemon shutdown;
   - assert exactly-once pending-request cleanup.

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
