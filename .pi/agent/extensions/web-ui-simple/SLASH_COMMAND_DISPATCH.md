# Slash-command dispatch from the Web UI

## Purpose

The browser composer will eventually offer `/` completion. Command discovery is already possible through `pi.getCommands()`, but discovery must not be confused with execution: the Web UI cannot currently submit slash input through the same public path used by Pi's TUI and RPC clients.

This note records the behavioral, API, lifecycle, and security constraints that must be resolved before slash completion is advertised as executable.

## Current Pi behavior

### Discovery

`pi.getCommands()` returns commands available in the current session, ordered as extension commands, prompt templates, and skills. Each item contains its invocation name, description, source, and canonical `sourceInfo` provenance.

This is sufficient for command-name completion and duplicate invocation suffixes such as `/review:1`. It is not sufficient for execution or command-specific argument completion:

- registered command handlers are not exposed;
- registered `getArgumentCompletions()` callbacks are not exposed;
- prompt-template bodies and skill bodies are not exposed through this API;
- built-in interactive commands such as `/model`, `/new`, `/resume`, `/tree`, and `/settings` are intentionally absent.

### `sendUserMessage()` is not raw interactive input

`pi.sendUserMessage()` deliberately calls Pi's prompt path with prompt/command expansion disabled and with input source `"extension"`. Sending the string `/review src/auth.ts` through this API therefore creates an ordinary user message; it does not faithfully invoke an extension command, skill, or prompt template.

Pi's internal canonical prompt path performs, in order:

1. extension-command recognition and invocation;
2. the extension `input` event;
3. skill expansion;
4. prompt-template expansion;
5. immediate prompting or steer/follow-up queueing.

Those internals are not a supported extension boundary. The Web UI must not import private `AgentSession` or `ExtensionRunner` objects, nor create a mode-specific RPC side channel back into its own Pi process.

## Desired architecture

The server should be a gateway to Pi's canonical input processing, not a second implementation of Pi's parser. The browser should send the unchanged input text with admission metadata:

```ts
interface BrowserInput {
  commandId: string;
  generation: string;
  content: string;
  delivery: "immediate" | "steer" | "follow_up";
}
```

The server may identify a leading slash for validation and presentation, but Pi must retain ownership of parsing, conflict resolution, handler invocation, input-event processing, and skill/template expansion.

A suitable public Pi capability would resemble:

```ts
const result = await pi.dispatchInput(text, {
  source: "extension",
  streamingBehavior: "steer",
});
```

The exact name is unimportant. Its contract should:

- preserve extension commands, `input` events, skills, and prompt templates;
- accept images when the composer gains attachment support;
- use Pi's canonical command conflict and invocation-name rules;
- distinguish immediate, steer, and follow-up delivery;
- provide asynchronous accepted/rejected feedback instead of swallowing errors;
- remain safe across reload and session replacement;
- report whether the input became a command, immediate prompt, steer, or follow-up.

The browser should clear its draft only after authoritative acceptance. A rejection should preserve the exact draft and indicate whether retrying is meaningful.

## Different command classes

### Extension commands

Extension command handlers execute directly and may run even while the agent is busy. Some handlers call `ctx.ui.select()`, `confirm()`, `input()`, `editor()`, or `custom()`.

A generic browser dispatcher cannot currently know which handlers require interactive UI. In TUI mode such a handler would open in the terminal, not in the browser. In RPC mode it may emit an RPC UI request to a different client. Initial browser support must therefore either:

- allow only explicitly known browser-safe extension commands; or
- clearly require terminal participation for interactive handlers.

Longer term, browser rendering of Pi UI requests needs its own protocol. Any command that genuinely waits for browser input must also participate in the repository's balanced `herdr:blocked` lifecycle, including cancellation, errors, reload, shutdown, and nested dialogs. Ordinary browser text composition is not itself a blocked scope because Pi is not synchronously waiting for it.

### Prompt templates and skills

These should be passed through Pi's canonical expansion path. Reimplementing expansion in the Web UI would duplicate parsing, resource precedence, provenance, and future Pi behavior. While Pi is busy, they need explicit steer or follow-up delivery just like ordinary prompts.

### Built-in interactive commands

Built-ins are not returned by `pi.getCommands()` and often own terminal-specific UI or session-replacement behavior. The first browser completion implementation must not imply that all TUI commands are supported.

Structured browser features are preferable for operations such as model selection, aborting, creating/switching sessions, tree navigation, and settings. Each can then have explicit admission rules, typed responses, and browser-native UI rather than pretending to be terminal command text.

## Completion constraints

The first safe completion milestone can provide command-name completion from `pi.getCommands()`, retaining `source` and `sourceInfo` for display and duplicate resolution. It cannot faithfully provide command-specific argument completion until Pi exposes a public completion operation, conceptually:

```ts
pi.getCommandCompletions({ text: "/review sr", cursor: 10 });
```

Autocomplete results are advisory and may become stale after reload or session replacement. Submission must revalidate against the current generation and current command registry.

Unknown slash input must follow Pi's canonical behavior. The Web UI should not independently decide whether it is an error or an ordinary prompt.

## Admission and protocol requirements

The authenticated server should enforce:

- a current session/runtime generation;
- unique command IDs or an idempotent replay cache;
- non-empty content and bounded payload sizes;
- valid delivery state (`immediate` only while idle, steer/follow-up only while busy), except where canonical extension-command dispatch has different rules;
- same-origin and authenticated requests under the existing random path and session cookie;
- authoritative rejection for stale autocomplete selections or torn-down runtimes.

A response should distinguish acceptance from eventual completion:

```ts
type InputResponse =
  | {
      commandId: string;
      accepted: true;
      disposition: "command" | "prompt" | "steer" | "follow_up";
    }
  | {
      commandId: string;
      accepted: false;
      error: string;
      retryable: boolean;
    };
```

Long-running command effects should continue to arrive through normal session events. The browser transport must not hold a request open until an entire agent run settles.

## Required behavioral tests

Before enabling `/` completion, tests should prove that:

- selecting and submitting an extension command invokes it rather than creating an LLM user message;
- a prompt template and a skill expand through Pi's canonical implementation;
- duplicate command invocation names dispatch to the selected canonical suffix;
- unknown and stale commands follow the documented Pi behavior;
- busy-state extension commands and busy-state prompt expansions obey their distinct rules;
- accepted input clears the draft exactly once, while rejected input preserves it;
- duplicate command IDs cannot execute a command twice;
- reload/session replacement rejects an old generation;
- an interactive extension command is either browser-supported or rejected before it creates an inaccessible wait;
- argument completion is not advertised until its semantics are actually available.

## Upstream research

Research against current Pi sources and the historical issue/PR record found no supported raw-input, `invokeCommand`, or template-expanding extension API equivalent to canonical `AgentSession.prompt()`.

### Implemented capabilities

- [`sendUserMessage()` originated as a way to send an actual user-role message](https://github.com/badlogic/pi-mono/issues/483), distinct from custom messages. Its current implementation still deliberately disables command/template expansion.
- [`getCommands()` was added by merged PR #1210](https://github.com/badlogic/pi-mono/pull/1210) as a discovery API aligned with RPC. The PR explicitly covers extension commands, templates, and skills while excluding interactive-only built-ins; it does not add invocation. [The originating request](https://github.com/earendil-works/pi/issues/1208) discussed command-aware extensions, but the merged boundary remained enumeration only.
- Current upstream [`AgentSession`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts) and [extension documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) preserve the separation between canonical prompting and literal extension-originated user messages.

### Requests for expansion or invocation

The gap has been independently reported several times:

- [#2488](https://github.com/earendil-works/pi/issues/2488) and [#2549](https://github.com/earendil-works/pi/issues/2549) reproduce agent/tool attempts to invoke session commands through `sendUserMessage()` becoming literal chat text.
- [#3294](https://github.com/earendil-works/pi/issues/3294) proposed an opt-in `expandPromptTemplates` option. It is closed `not_planned`/`no-action`, with no corresponding capability in current source.
- [#5448](https://github.com/earendil-works/pi/issues/5448) later proposed the same option for a command that would navigate the session tree. It was also closed `not_planned`/`no-action`.

Those closure labels show that opt-in expansion is not currently planned, but they are not strong evidence of a permanent architectural rejection: repository automation closes many new-contributor issues, and no maintainer statement was found declaring raw dispatch inherently unsafe.

### Lifecycle direction and actual safety evidence

The most substantive related design discussion is [#2023](https://github.com/earendil-works/pi/issues/2023?timeline_page=1). It began with another demonstration that queuing `/reload-runtime` through `sendUserMessage()` does not dispatch. The accepted upstream work shifted toward scheduling extension work only after the agent is truly idle, and the issue was completed as `pi.runWhenIdle()` on 2026-07-09. That API is not present in this extension's pinned Pi 0.82.0 dependency, whose command context instead exposes `waitForIdle()`. The upstream result supports a lifecycle-safe deferred-work direction; it does not provide generic command invocation.

Reentrancy is therefore a real, evidenced concern, especially for `/reload`, session replacement, and tree mutation while a tool or agent run still owns old state. Pi's [replacement-session callback fix](https://github.com/badlogic/pi-mono/commit/1cc303d053b46009e495c049c7c263350a57730b) invalidates stale session-bound extension objects and requires post-replacement work to use a fresh callback context.

By contrast, capability security is not documented as the reason dispatch is unavailable. Pi already warns that trusted extensions execute arbitrary code with the user's permissions. The ideas that literal delivery prevents accidental command execution of forwarded external text and avoids recursive command loops are plausible architectural inferences, not located maintainer decisions.

### Conclusion from upstream evidence

The current direction favors:

- command discovery through `getCommands()`;
- literal user-message delivery through `sendUserMessage()`;
- direct command-context operations where an extension already owns a command handler;
- settled/idle-safe scheduling for mutation;
- RPC or SDK `prompt` for external clients that genuinely own an input channel.

It does not currently offer the raw dispatcher needed by this browser extension. We should not interpret `getCommands()` as an invocability guarantee or claim that dispatch was explicitly rejected as unsafe. A new public API proposal should directly address admission, reentrancy, stale contexts, external-text safety, and accepted/rejected feedback rather than merely adding a boolean expansion flag.
