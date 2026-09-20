# Editable Web UI Message Queue Plan

## Purpose

Design and implement an extension-owned pending-input broker for Web UI-originated steer and follow-up messages. The broker keeps accepted browser messages outside Pi's internal queue while they remain editable, then hands them to Pi at the normal delivery boundary.

This plan is intentionally local to this task. The implementation is now landed in the standalone extension, shared client, and daemon adapter. Keep this file through manual validation; delete it together with the final commit after the user validates the behavior.

## Product decisions

- The broker owns only messages submitted by the Web UI surface.
- The standalone Web UI and TUI are alternative surfaces. Each may have its own pending queue; neither needs to display or edit the other's not-yet-delivered messages.
- Do not intercept or replace TUI queue handling initially. In particular, do not take ownership of TUI input events or change the TUI dequeue behavior.
- A broker-owned item is independently editable and removable until it is handed to Pi.
- Once handed to Pi, the item is no longer editable through the Web UI and enters ordinary Pi delivery/transcript behavior.
- Native TUI/Pi queue messages are not editable from the Web UI.
- Do not add a TUI widget for the other surface's queue in the first implementation. Reconsider only after the standalone behavior is stable.
- Ordinary steer/follow-up messages are the primary scope. Executable slash-command parity is out of scope for standalone and remains a separate managed-mode capability.
- Start with the standalone extension because it serves a testable UI today. Adapt the daemon only after the extension behavior is proven; the daemon currently does not serve a user-testable UI.

## Current evidence and constraints

- Pi 0.84.0 exposes the public user-message API and awaited `turn_end`/`agent_end` extension boundaries, but the standalone extension surface has no per-item native queue mutation API. The broker therefore owns browser-originated rows until handoff and never claims control over TUI/native queue rows.
- Pi awaits extension handlers for `turn_end` and `agent_end`; Pi's current implementation supports messages queued by an `agent_end` handler triggering continuation.
- Standalone currently calls `pi.sendUserMessage()` immediately and maintains a speculative `LiveSessionProjection.pendingInputs` mirror.
- Shared wire DTOs already contain bounded pending-input rows and queue operations. Browser mutation commands, capability advertisement, and host responses still need to be designed and tested.
- Broker records must retain the complete admitted Pi payload, including images, even if the display row contains only text.

## Target behavior

```text
browser command
  -> standalone admission/replay/generation checks
  -> broker owns stable item ID and full payload
  -> browser receives authoritative queue snapshot/update
  -> inline edit/remove operates on broker-owned item
  -> turn_end releases eligible steer item(s)
  -> agent_end releases eligible follow-up item(s)
  -> Pi receives the final payload through its public API
  -> broker removes the item from the editable queue
```

The exact release batch policy must be verified against Pi's configured steering/follow-up modes. Prefer a serialized release policy that keeps later broker items editable for as long as possible while preserving order and Pi's documented delivery semantics.

## Implementation phases

### Phase 1 — Contract and lifecycle spike

- [x] Add host-local standalone and daemon broker models with stable IDs, ordered items, delivery mode, full payload, and held/releasing/handed-off state transitions.
- [x] Define enqueue, replace, remove, snapshot, release, reset, FIFO, and failure-restore semantics.
- [x] Use closed `queue-edit` and `queue-remove` mutation commands with existing command-response envelopes.
- [x] Add explicit capabilities and per-row editability/version metadata.
- [x] Confirm bounds for item count, text, image bytes/pixels, command replay, body readers, and retained broker memory.
- [x] Add public-hook lifecycle coverage for serialized steer release at `turn_end` and follow-up release at `agent_end`; the installed Pi API's fire-and-forget standalone handoff limitation is documented in the owning Web UI plan.

### Phase 2 — Standalone broker integration

- [x] Change standalone busy browser submissions to enqueue in the broker rather than immediately call `pi.sendUserMessage()`.
- [x] Keep idle immediate prompts on the existing direct path.
- [x] Release one broker item through the public standalone API at each verified lifecycle boundary.
- [x] Restore on synchronous public-API handoff failure; retain failed async handoff limitations explicitly because Pi 0.84.0 returns `void` at the extension boundary.
- [x] Clear or fail broker items explicitly on replay reset, compaction, retry/abort boundaries, session tree changes, model changes, shutdown, and runtime replacement.
- [x] Remove the current text-matching settlement path for broker-owned rows. Native Pi/TUI messages are not falsely settled by duplicate text.
- [x] Keep broker ownership separate from Pi's native queue and do not register a global input interceptor.

### Phase 3 — Browser editing experience

- [x] Render broker-owned pending rows as independent items rather than one combined editor.
- [x] Add per-item edit mode with save/cancel, fixed item-version fencing, focus restoration, and draft preservation on rejection/conflict.
- [x] Add per-item removal through the closed queue mutation command.
- [x] Preserve delivery mode, FIFO order, and complete attachments during text edits.
- [x] Remove rows at handoff and mark releasing rows non-editable so the transition is clear.
- [x] Keep the normal composer behavior and TUI-originated queue behavior unchanged.

### Phase 4 — Standalone protocol and adversarial tests

- [x] Add TypeBox schemas and bounded request/response handling for broker mutations.
- [x] Add generation, command-epoch, replay, authentication, and stale-session checks at the mutation boundary.
- [x] Test independent editing of adjacent items and duplicate text.
- [x] Test edit versus release, remove versus release, edit versus reset, reconnect/retry during mutation, rejected commands, and ambiguous HTTP/network delivery.
- [x] Test mixed steer/follow-up FIFO order, multiple queued items, TUI-originated/native read-only rows, aborts, compaction, retries, model changes, replay resets, and shutdown.
- [x] Add browser coverage for inline editing, mobile layout, keyboard behavior, accessibility, focus, and draft preservation.
- [x] Run standalone package checks, clean-install/deployment checks, and the complete Chromium/WebKit suite before daemon adaptation.

### Phase 5 — Managed-host adapter, after standalone validation

- [x] Add an independent broker to the daemon's host abstraction without making the shared browser package depend on daemon or Pi runtime code.
- [x] Map release to awaitable public typed SDK steer/follow-up APIs; ordinary brokered text remains literal and managed command policy remains separate.
- [x] Keep managed browser command allowlisting and dialog/security policy separate from ordinary brokered text.
- [x] Add daemon broker state, image payload, shared DTO, API, transport, projection, and unit/conformance coverage.
- [x] Test the daemon host independently even though the daemon UI is not currently available for manual testing.

## Explicit non-goals

- Mutating Pi's private internal queue after admission.
- Editing or deleting TUI-native pending messages.
- Synchronizing the standalone broker queue with the TUI queue before transcript delivery.
- Reimplementing Pi's TUI dequeue hotkey.
- Reordering messages or converting steer to follow-up in the first version.
- Generic executable slash commands in standalone mode.
- A new Pi upstream API or changes to installed Pi sources.

## Acceptance criteria

- Every broker-owned browser message has an independent stable identity and can be edited without changing neighboring items.
- The final edited payload, including attachments, is what Pi receives if the edit completes before handoff.
- No broker item is silently lost across rejection, reset, teardown, or a failed release.
- Edit and release races have deterministic outcomes and are covered by tests.
- TUI behavior remains unchanged, and the product clearly treats TUI and Web UI pending queues as separate surface-local state.
- Standalone behavior is verified before daemon work begins.
