> **Design outcome:** this reconsideration is developed into the concrete architecture and diagrams in [`docs/RPC_FIRST_REMOTE_DASHBOARD.md`](./docs/RPC_FIRST_REMOTE_DASHBOARD.md).

Yes—my gut feeling is that the project has crossed the point where **an extension should no longer be the primary control plane**.

The extension route was an excellent starting point: minimal process model, direct access to the live session, straightforward event hooks, and a self-contained browser server. But Pi’s API boundary is deliberately asymmetric:

- extensions are good at observing and augmenting a session;
- RPC clients are better at owning and controlling one.

Your roadmap increasingly concerns control: canonical input dispatch, session replacement, model selection, reload, interactive dialogs, authoritative acknowledgements, and remote supervision. Those naturally belong outside the extension.

## My preferred direction

Use an **RPC-first architecture with a thin optional extension**, rather than choosing exclusively between extension and RPC.

### Daemon/RPC client owns

- prompt, template, skill, and extension-command dispatch;
- model and thinking controls;
- abort, compaction, queues;
- new/resume/fork/clone;
- authoritative request responses and idempotency;
- standard extension-dialog forwarding;
- process supervision, readiness, stable routing, and authorization;
- transcript events and state queries.

### Thin extension owns only Pi-local integrations

Potentially:

- extension-specific status providers such as Agentflow/background-process summaries;
- cooperative `pi.events` integrations;
- custom transcript or provider projection only if RPC and validated session data prove insufficient;
- a child-local lifecycle hook only if generic browser-driven dialogs require it;
- the existing standalone “attach this browser to my current TUI session” mode.

The completed design uses stock `get_state` for managed readiness and supervised process
replacement for managed reload, so neither a readiness FD nor a reload bridge is required initially.

The crucial rule would be that the extension **does not try to loop back and control its own Pi session** in managed mode. Browser mutations go to the daemon, and the daemon writes RPC stdin.

## Why I would reconsider now

The strongest signal is not merely slash commands. It is that several required operations are available only through different context classes:

- normal extension callbacks receive `ExtensionContext`;
- session replacement and reload require `ExtensionCommandContext`;
- canonical prompt expansion lives on `AgentSession`;
- built-in TUI commands live above that in `InteractiveMode`;
- RPC exposes another, generally more suitable structured control surface.

Working around each missing seam individually would preserve superficial minimalism but gradually produce a complicated system: input-event expansion, synthetic commands, editor capture, stale-context handling, reload reconnection, and custom admission logic. That is likely less minimal in practice than having one explicit RPC controller.

## What I would not do

I would not immediately rewrite everything into a browser that talks directly to raw Pi RPC.

The daemon should remain between the browser and Pi because it needs to provide:

- authentication and roles;
- stable session URLs;
- generation tracking;
- mutation serialization;
- replay protection;
- subprocess ownership;
- bounded protocol projection;
- dialog routing and cancellation.

I also would not discard the canonical `web-ui` extension. Its visual design and renderer can remain almost unchanged. This is mostly a change in **where commands and events enter the UI**, not a reason to redesign the interface.

## The product distinction that matters

There are really two modes:

1. **Companion UI for an existing interactive TUI process**  
   An extension is the only practical attachment mechanism. Some controls will remain limited unless Pi expands its extension API.

2. **Remotely launched and managed Pi session**  
   RPC should be the authoritative control interface. Making the extension the controller here would be fighting the architecture.

Trying to make both modes feature-identical is probably the trap. I would let standalone extension mode remain pleasantly minimal, while managed RPC mode provides the complete remote-session experience.

## Recommendation

Yes, I think a fresh-session architecture review is worthwhile **before implementing the large restructuring in the current plan**.

My likely outcome would be:

> Preserve `web-ui` as the UI and standalone companion extension, but make the daemon/RPC layer the primary backend for managed sessions. Reduce the extension’s managed-mode responsibilities as far as possible.

That preserves what was appealing about the extension route without forcing the whole product through an API boundary that was not designed to be a complete remote controller.
