# Background Bash and Monitor Extension

## Goal

Add a Pi extension for long-running shell work that should not block the agent loop:

1. `background_bash`: launch a finite command, return immediately, retain its complete output, and wake the agent once when it exits.
2. `monitor`: launch a command whose output is an event stream, batch complete lines into bounded messages, and let the agent react while the command continues.

The initial use case is long benchmark, build, and test runs. The design should also support filtered log tails and polling scripts without turning Pi into a persistent system service manager.

## Product decisions

These decisions were confirmed before implementation:

- Use a separate `background_bash` tool rather than overriding Pi's built-in `bash` tool.
- Give `monitor` Claude Code-like live event semantics, not merely status polling for background jobs.
- Wake the agent when a background command completes.
- Terminate every managed process tree on session switch, reload, fork, new session, or exit.

Additional v1 decisions:

- The two launch tools and their management tools share one session-scoped runtime and artifact store.
- Give the agent explicit status, wait, and stop tools. Background execution is only useful if the agent can later synchronize with or cleanly terminate work it launched; human-only control would make the agent less capable than the user and force unsafe PID-level shell workarounds.
- Support TUI and long-lived RPC modes. Reject print and JSON modes because their host can exit as soon as the current turn settles.
- Target macOS and Unix-like systems first, matching the current dotfiles environment. Windows support is out of scope for v1.
- Do not support detaching an already-running foreground `bash` call with `Ctrl+B` in v1. Pi's extension API does not expose a safe way to transfer ownership of an in-flight built-in tool process.

## Research and local precedents

### Claude Code behavior

Current Claude Code documentation distinguishes two related capabilities:

- Background Bash returns a task ID immediately, writes output to a file, reports completion, supports `/tasks`, and terminates tasks when Claude Code exits.
- Monitor runs a command in the background and delivers stdout lines as events while the conversation continues. Its documented command form uses a description, a default finite timeout, and an optional persistent/session-long mode. Closely spaced lines are batched to reduce event traffic.

Sources:

- <https://code.claude.com/docs/en/interactive-mode#background-bash-commands>
- <https://code.claude.com/docs/en/tools-reference#bash-tool-behavior>
- <https://code.claude.com/docs/en/tools-reference#monitor-tool>

The design intentionally copies the lifecycle and interaction model, not Claude Code's exact internal schemas or permission system.

### Pi APIs and repository conventions

- Pi extensions register tools with `pi.registerTool()`, can inject custom messages with `pi.sendMessage()`, and must clean up session-scoped resources in `session_shutdown`.
- `createLocalBashOperations()` is the preferred execution backend. It uses Pi's shell resolution, detached process groups, process-tree cancellation, and signal handling.
- Pi's built-in Bash has no default timeout, accepts timeout values in seconds, streams combined stdout/stderr, and truncates model-visible output to the last 2,000 lines or 50 KiB.
- `.pi/agent/extensions/agentflow/src/runtime/run-engine.ts` provides the local precedent for owned abort controllers, background result consumption, idle-gated completion delivery, and bounded shutdown.
- `.pi/agent/extensions/agentflow/src/runtime/artifact-store.ts` provides the local precedent for mode-0600 files and atomic metadata replacement.
- `.pi/agent/extensions/agentflow/src/index.ts` provides the local precedent for footer status, `agent_settled` delivery flushing, and session lifecycle cleanup.
- `.pi/agent/extensions/worktrunk-statusline.ts` provides the local precedent for child-process timeout and TERM/KILL cleanup behavior.

Pi documentation consulted:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md`

## User-facing contract

### Tool: `background_bash`

Purpose: fire-and-complete execution for a command expected to terminate, such as a benchmark, full test suite, or build.

Proposed schema:

```ts
{
  command: string;
  description?: string;
  timeout?: number; // seconds; no default
}
```

Behavior:

1. Validate mode and timeout before creating a job.
2. Allocate a unique job ID and artifact directory.
3. Open the output log before spawning the command.
4. Start the command in `ctx.cwd` through Pi's local Bash operations using a runtime-owned abort controller.
5. Return immediately with the job ID, state, description, working directory, and output/metadata paths.
6. Capture the complete combined stdout/stderr stream on disk and retain only a bounded tail in memory.
7. On exit, timeout, spawn error, output-limit termination, or cancellation, atomically write terminal metadata and enqueue exactly one completion delivery for the live extension generation.
8. When Pi is idle, inject one custom completion message using `deliverAs: "followUp"` and `triggerTurn: true`. The message includes status, exit code/reason, duration, bounded tail, and the full output path.

A successful launch is a successful tool call even if the process later exits nonzero. Later failure belongs to the background job's terminal event.

Example launch result:

```text
Started background job bg_mabc123_1 (nightly benchmark).
Output: ~/.pi/agent/background-processes/<session>/<job>/output.log
```

### Tool: `monitor`

Purpose: launch a filtered event-producing command so the agent can react to progress or changes before the command exits.

Proposed schema:

```ts
{
  command: string;
  description: string;
  timeout?: number;    // seconds; default 300, maximum 3600
  persistent?: boolean; // default false; when true, no timeout
}
```

Behavior shared with `background_bash`:

- Returns immediately with a job ID and artifact paths.
- Captures complete combined output on disk.
- Owns its process independently of the originating tool call's abort signal after launch succeeds.
- Produces one terminal completion delivery.
- Is terminated during session shutdown.

Additional monitor behavior:

1. Decode output incrementally with `StringDecoder` so UTF-8 characters split across chunks are preserved.
2. Normalize CRLF, emit only complete lines during execution, and emit a final unterminated line at process exit.
3. Batch lines for 200 ms, 32 lines, or 16 KiB, whichever is reached first.
4. Give batches monotonically increasing sequence ranges so coalescing or drops are visible.
5. Sanitize terminal/control sequences before placing text in model context; preserve raw bytes in `output.log`.
6. Coalesce batches while one monitor event is already queued for the agent. At most one event per monitor may be pending in Pi's steering/follow-up queues.
7. If the agent is active, inject the coalesced event as a steering message so it can react at the next safe turn boundary. If the agent is idle, trigger a turn for the event.
8. After `agent_settled`, deliver one accumulated pending batch, if any. Never send one Pi message per output line.
9. Apply a minimum one-second interval and allow at most 30 live model-visible deliveries per job. Fold the throttling notice into delivery 30, then switch the monitor to capture-only mode until its separate terminal completion delivery. This prevents noisy or infinite commands from creating an unbounded agent loop.
10. Always include the output path and dropped/coalesced counts in event metadata.

The tool description must instruct the model to emit only meaningful, line-buffered events—for example, by filtering output with `grep --line-buffered` or polling at a reasonable interval.

### Agent management tools

Use separate, narrowly typed tools rather than one action-based schema with conditionally required fields. This follows the proven Agentflow `status`/`wait`/`cancel` split and makes each operation easier for models to discover and call correctly.

#### Tool: `background_status`

```ts
{
  jobId?: string;     // omit to list recent jobs
  tailLines?: number; // optional for one job; maximum 200
}
```

- With no ID, return compact snapshots for recent active and completed jobs.
- With an ID, return one serializable snapshot, artifact paths, delivery state, and an optional bounded recent tail.
- Never wait, stop, or consume the job's automatic completion delivery.

#### Tool: `background_wait`

```ts
{
  jobIds: string[]; // at least one
  timeout?: number; // maximum seconds to wait; does not alter job timeouts
}
```

- Wait for all requested jobs concurrently and return aggregate-bounded terminal results.
- Return immediately for already-terminal jobs.
- If the wait timeout expires, return current snapshots for unfinished jobs without stopping them and without consuming their future completion delivery.
- If the tool call is aborted, detach only the waiter; the background jobs continue.
- Atomically consume automatic completion delivery only for terminal results successfully returned by this tool, preventing a later duplicate wake.

#### Tool: `background_stop`

```ts
{
  jobIds: string[]; // at least one
}
```

- Resolve every requested ID before mutating any job, so an unknown ID cannot cause a surprising partial stop.
- Atomically claim `cancelled` as the requested terminal cause for every active target, abort their process trees, await terminal settlement, and return aggregate-bounded final results.
- Treat already-terminal jobs as idempotent no-ops and return their existing results.
- Consume pending automatic completion delivery for results returned by the stop operation.
- Report unknown IDs explicitly; never fall back to PID-based killing.

Prompt guidance should tell the agent to:

- use `background_status` for nonblocking inspection;
- use `background_wait` only when subsequent work truly depends on completion, rather than immediately blocking after every launch;
- use `background_stop` when the user asks, when a monitor is no longer needed, or when continuing the process would waste resources.

### Human control commands

Expose the same runtime operations to the user:

- `/background-tasks`: show recent jobs and their states, descriptions, durations, and output paths.
- `/background-stop <jobId>`: cancel one active job through the same stop path as the agent tool.
- `/background-tail <jobId>`: show a bounded recent tail in a TUI dialog or notification.

### TUI behavior

- Show a compact persistent widget above the editor while jobs are active, with elapsed runtime and monitor delivery health.
- Limit the widget to two summaries plus an overflow count and refresh elapsed time while it is visible.
- Clear the widget on shutdown.
- Open an interactive recent-task dashboard from `/background-tasks`, with readable details, command, output tail, artifacts, refresh, and stop actions.
- Register a custom renderer for monitor and completion messages so collapsed output stays compact and expanded output exposes the bounded payload and artifact path.
- UI is optional: all runtime behavior must work in RPC mode without a TUI; commands use concise notification fallbacks there.

## Runtime design

### Session-scoped `ProcessRuntime`

One runtime instance owns all jobs for the current extension generation.

Minimal job record:

```ts
type JobKind = "background_bash" | "monitor";
type JobStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled" | "cleanup_failed";

interface JobRecord {
  id: string;
  kind: JobKind;
  command: string;
  description?: string;
  cwd: string;
  status: JobStatus;
  createdAt: string;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  requestedTerminalCause?: "timeout" | "stop" | "shutdown" | "output_limit" | "output_error";
  outputBytes: number;
  outputPath: string;
  metadataPath: string;
  controller: AbortController;
  completion: Promise<void>;
  recentTail: BoundedTail;
  timeoutTimer?: NodeJS.Timeout;
  deliveryState: "pending" | "sending" | "sent" | "failed" | "consumed";
  monitor?: MonitorState;
  generation: number;
}
```

The runtime needs operations for launch, list/get, cancel, completion observation, delivery flush, and shutdown. State transitions are first-writer-wins; callbacks arriving after terminal settlement or generation shutdown are ignored.

### Signal ownership

- Check the tool execution signal before launch.
- Do not link a successfully launched background job to the originating tool signal. Backgrounding explicitly transfers ownership to the runtime.
- Use the runtime-owned controller for timeout, `/background-stop`, and session shutdown.
- Use `createLocalBashOperations()` so controller abort kills the process tree rather than only the shell PID.

### Output and artifacts

Suggested layout:

```text
~/.pi/agent/background-processes/<session-id>/<runtime-id>/<job-id>/
  output.log
  job.json
  owner.json
```

`runtime-id` is a random process-generation token. `owner.json` records the Pi PID, runtime ID, and start time. A runtime writes only beneath its own directory, so concurrently opening the same Pi session cannot corrupt another runtime's metadata. V1 does not rewrite another runtime's stale `running` records because PID-only liveness checks are vulnerable to PID reuse; an interrupted record remains historical evidence rather than being guessed into a terminal state.

Requirements:

- Create directories and files with user-only permissions.
- Stream output to `output.log` from the first byte; do not wait for truncation before creating an artifact.
- Keep a bounded 50 KiB/2,000-line tail for model-visible completion text.
- Never read an arbitrarily large completed log back into memory.
- Atomically replace `job.json` using a temporary file and rename.
- Store command, description, cwd, kind, timestamps, status, requested terminal cause, observed exit data, output byte count, truncation/drop counts, and paths.
- Terminate a job if its output exceeds 5 GiB and record an explicit reason, matching Claude Code's safety boundary.
- Retain completed artifacts for seven days and enforce a 20-GiB aggregate quota by deleting the oldest completed runtime directories first. Never delete an active runtime directory. Run cleanup at session start and after completion.
- Retain at most 50 compact completed records in memory; release controllers, decoders, timers, and tails after terminal delivery. Artifacts remain authoritative after in-memory eviction.

Pi's exported Bash operation combines stdout and stderr. V1 therefore preserves one arrival-ordered stream rather than promising channel identity.

### Delivery rules

Completion delivery:

- Queue terminal jobs.
- Flush only when the parent is idle.
- Move a delivery through `pending -> sending -> sent | failed` and claim it before calling `pi.sendMessage()` to prevent reentrant duplicates.
- Treat a thrown `pi.sendMessage()` as a failed at-most-once attempt: persist the failure in metadata and surface it in `/background-tasks`, but do not retry because the API does not guarantee that a throw means nothing was enqueued.
- Coalesce simultaneous completions into one custom message and one agent wake.
- Apply the 50-KiB/2,000-line limit to the final serialized coalesced message, not to each job independently. Give every job a compact summary and artifact path, then share the remaining tail budget; omitted tails are read from their artifacts.
- Flush from `agent_settled` and from a short terminal timer for the already-idle case.
- Suppress all new enqueue attempts after shutdown starts. Messages already accepted into Pi's own queue cannot be retracted by this extension and are governed by Pi's session-replacement behavior.
- Promise at-most-once delivery attempt per live extension generation, not exactly-once delivery across crashes.

Monitor event delivery:

- Keep capture batching separate from agent delivery.
- Bound the pending coalesced window to the newest 50 KiB and 2,000 lines. Drop the oldest complete lines first; record dropped line/byte counts and the missing sequence range. A split pathological line counts as one source sequence with multiple fragments.
- Permit only one queued model-visible event per monitor.
- Use sequence numbers and dropped-byte/line counters so the agent knows when to inspect the full log.
- Allow at most 30 live model-visible deliveries per monitor. Each delivery may trigger at most one automatic turn; steering deliveries count against the 30 even when they extend an existing run. Fold the capture-only throttling notice into delivery 30. The mandatory terminal completion is separate, so one monitor can trigger at most 31 automatic turns in total.
- Respect the one-second delivery interval.
- A monitor's final pending lines are folded into its completion event.

### Lifecycle

- Extension factory: register tools, commands, renderers, and handlers only. Start no processes or timers.
- `session_start`: create a fresh runtime-owned generation, run completed-artifact cleanup without rewriting foreign runtime metadata, and initialize status.
- `agent_settled`: flush eligible completion and monitor deliveries.
- `session_shutdown`: set `shuttingDown`, clear all timers/status, atomically claim `cancelled` as the requested terminal cause for active jobs, abort them concurrently, and await Pi's local Bash operation plus log closure before returning. On Unix, Pi's backend abort uses process-group `SIGKILL`, so TERM-ignoring children do not require a separate grace path. If process death or log closure still cannot be confirmed, persist `cleanup_failed` diagnostics and fail shutdown verification rather than claiming successful cleanup.
- Apply shutdown behavior to `quit`, `reload`, `new`, `resume`, and `fork`.
- Normal process-tree cleanup cannot cover `SIGKILL`, power loss, or commands that deliberately escape into another OS session/service manager; document this limitation.

## Error and boundary behavior

- Invalid timeout or unsupported mode: throw before allocating a job.
- Spawn failure: retain job artifacts and send a failed completion event.
- Nonzero exit: terminal `failed` state with exit code and output tail.
- Timeout, manual stop, output-limit stop, output-write failure, and shutdown first atomically claim a requested terminal cause before aborting. One finalizer maps that cause plus the observed exit into the terminal status, preventing abort/exit races from changing `timed_out` into `failed` or `cancelled` into `completed`.
- Manual stop/session shutdown: report `cancelled`, but do not wake the agent during shutdown.
- No output: completion says `(no output)` and still supplies the output path.
- Pathological single line: split model-visible events at 16 KiB and record that splitting occurred.
- Invalid UTF-8/control bytes: preserve raw log bytes; replace unsafe model-visible characters.
- Fast exit before launch result returns: keep launch and completion delivery ordered by deferring delivery until after the launch tool has resolved.
- Output write failure: abort the process rather than silently running without an authoritative log.
- High-volume output: test write-stream pressure. If Pi's callback-only Bash operation allows unacceptable buffering, replace only the runner layer with a direct spawn implementation that has explicit pause/resume backpressure and TERM-to-KILL escalation.

## Security model

- Commands run with the same user privileges and environment access as Pi's built-in Bash.
- This extension does not recreate Claude Code's permission rules.
- Never log environment variables or inject them into metadata.
- Sanitize model/TUI messages, but preserve the raw output artifact.
- Metadata and logs use mode `0600`; artifact directories use mode `0700`.

## Non-goals for v1

- Surviving Pi exit, reload, or session replacement.
- Reattaching to orphaned processes.
- PTY/interactive commands or password prompts.
- Exact stdout/stderr channel separation.
- Converting a running foreground Bash call with `Ctrl+B`.
- Windows process-tree support.
- WebSocket monitor sources.
- Project-specific configuration files or user-tunable batching knobs.
- Guaranteed exactly-once message delivery across crashes.

## Implementation phases

### Phase 1 — Package and runtime skeleton

- [x] Create `.pi/agent/extensions/background-processes/` with a small TypeScript package, extension entry point, and test/lint/typecheck scripts following the Agentflow package conventions.
- [x] Define job types, ID allocation, strict state transitions, generation guards, and a bounded in-memory tail.
- [x] Register lifecycle handlers but no user-facing tool behavior yet.

Dependencies: none.

Parallelism: package scaffolding and pure bounded-tail/state-machine tests can be done in parallel, then integrated.

### Phase 2 — Process execution and artifacts

- [x] Implement runtime-owned artifact creation, raw output streaming, atomic metadata checkpoints, retention/quota cleanup, and compact completed-record eviction.
- [x] Integrate `createLocalBashOperations()` with runtime-owned abort controllers and optional timeout.
- [x] Implement terminal-cause claiming, status mapping, output-size enforcement, and verified shutdown settlement.
- [x] Add real process-tree integration tests, including a shell that spawns a grandchild.

Dependencies: Phase 1 state model.

Parallelism: artifact-store implementation and process-runner tests can proceed in parallel against agreed interfaces.

### Phase 3 — `background_bash`, management, and completion delivery

- [x] Register the strict launch schema and clear tool description/prompt guidance.
- [x] Return launch metadata immediately without coupling the job to the tool signal.
- [x] Register `background_status`, `background_wait`, and `background_stop` with strict schemas and aggregate-bounded results.
- [x] Implement abortable waiters that do not abort jobs, wait-timeout behavior, idempotent stop, and atomic completion-delivery consumption.
- [x] Implement idle-gated, claimed, coalesced completion delivery and custom rendering.
- [x] Add footer status and the `/background-tasks`, `/background-stop`, and `/background-tail` commands using the same runtime operations.

Dependencies: Phase 2 execution and artifact paths.

Parallelism: tool/rendering work and delivery-state unit tests can proceed in parallel.

### Phase 4 — `monitor` event pipeline

- [x] Add incremental UTF-8 line framing, CRLF handling, final partial-line flush, control sanitization, and large-line splitting.
- [x] Add 200 ms/32-line/16-KiB capture batching, sequence ranges, bounded pending coalescing, and drop accounting.
- [x] Implement one-pending-event gating, one-second delivery interval, the 30-live-delivery budget, `agent_settled` flushing, and final-event folding.
- [x] Register the monitor schema, descriptions, renderer, and status display.

Dependencies: Phase 3 delivery infrastructure.

Parallelism: line decoder/batcher tests are independent of Pi message-delivery tests and can be developed in parallel.

### Phase 5 — Lifecycle hardening and end-to-end verification

- [x] Verify all shutdown reasons (`quit`, `reload`, `new`, `resume`, `fork`) terminate child and grandchild processes and produce no late messages.
- [x] Verify immediate-exit races, timeout/stop/output-failure terminal-cause races, simultaneous completion, reentrant delivery, repeated `agent_settled`, and throwing message delivery.
- [x] Verify status is non-consuming; wait cancellation leaves jobs running; wait timeout preserves later delivery; terminal wait consumes delivery; stop is idempotent, kills descendants, and consumes duplicate delivery.
- [x] Verify management results share one aggregate output bound when multiple job IDs are requested.
- [x] Verify same-session concurrent runtime ownership and ensure one runtime never rewrites or prunes another active runtime.
- [x] Verify TUI and RPC behavior and explicit print/JSON rejection.
- [x] Stress high-volume output for bounded model context, complete disk output, and acceptable memory use.
- [x] Run formatting, lint, typecheck, unit tests, RPC smoke tests, and a manual TUI benchmark/monitor scenario.

Dependencies: Phases 1–4.

Parallelism: test categories can run in parallel, but lifecycle fixes should be integrated and rerun as one final suite.

### Phase 6 — Persistent task widget and interactive dashboard

- [x] Replace the active-job footer summary with a compact, themed widget above the editor showing running jobs, elapsed time, monitor delivery state, and overflow.
- [x] Replace `/background-tasks` raw JSON notifications in TUI mode with a keyboard-driven recent-task list and per-job detail view.
- [x] Expose readable overview, full command, bounded output tail, artifact paths, refresh, and safe stop actions from the detail view.
- [x] Preserve a concise non-interactive notification fallback for RPC mode and clear the widget on every shutdown path.
- [x] Add extension/UI tests and run format, lint, typecheck, test, and smoke verification.

Dependencies: the existing runtime list, tail, and stop operations from Phases 2–3.

Parallelism: the pure UI formatting tests can be written alongside the dashboard component, but `src/index.ts` integration and extension lifecycle tests are sequential.

## Acceptance criteria

1. A 10+ minute benchmark launched by `background_bash` returns control to Pi immediately and continues while the user and agent do other work.
2. Its complete combined output is readable from the returned path during and after execution.
3. Completion makes one at-most-once wake attempt with status, duration, aggregate-bounded tail, and output path; enqueue failure is persisted and visible through both human and agent status inspection.
4. The agent can inspect a running job without consuming its completion, wait without accidentally cancelling it, and cleanly stop its process tree without PID-level shell commands or duplicate completion wakes.
5. A filtered monitor command can deliver meaningful line batches before process completion without one message per line.
6. A noisy monitor cannot create unbounded queued messages or unlimited automatic turns; throttling and drop/coalescing are visible.
7. Timeout, agent stop, human stop, reload, session switch, and exit terminate the shell process group, including tested ordinary and TERM-ignoring grandchildren; cleanup uncertainty is recorded as a failure rather than successful cancellation.
8. Every final serialized model-visible message or multi-job management result stays within the 50-KiB/2,000-line boundary, while the full on-disk log remains intact up to the 5-GiB per-job safety limit.
9. Every terminal state and delivery failure is recorded atomically with restrictive permissions.
10. No new completion or monitor message is enqueued after shutdown begins, and repeated lifecycle callbacks do not duplicate delivery attempts. Tests document Pi's handling of messages already accepted into its queue.
11. Concurrent runtimes for the same session never mutate each other's active artifacts, and completed records/artifacts obey the 50-record, seven-day, and 20-GiB retention limits.
12. The extension passes format, lint, typecheck, unit, process integration, and RPC smoke tests.

## Verification commands

Use the package manager expected by the final extension package, preferring `nub` in this repository:

```bash
cd .pi/agent/extensions/background-processes
nub run format:check
nub run lint
nub run typecheck
nub run test
nub run smoke
```

Manual TUI checks:

```text
Ask: Run a benchmark that sleeps and prints progress for several minutes using background_bash.
Expected: immediate job ID; Pi remains usable; one completion wake; full output path works.

Ask: Monitor a script that prints one filtered progress line every few seconds.
Expected: bounded live event batches; Pi remains responsive; final completion contains remaining lines.

Ask the agent to inspect, wait for, and then stop test jobs through the management tools.
Expected: status does not consume completion; an aborted waiter leaves its job running; stop kills descendants and does not produce a duplicate completion wake.

Run: /background-stop <jobId>
Expected: shell and grandchild disappear; metadata records cancellation.

Run: /reload with active jobs
Expected: all managed process trees terminate; no old-generation event appears after reload.
```

## Revisit triggers

- Consider consolidating or renaming the management tools only if model traces show consistent discovery/schema problems; preserve their status/wait/stop semantics.
- Add durable reattachment only if jobs must survive reload/exit; this requires a different supervisor architecture.
- Replace Pi's Bash operation runner only if stress tests demonstrate write-buffer growth or channel/PTY requirements.
- Add configurable monitor wake policies only after observing real event volumes; keep v1 defaults opinionated.
- Consider a built-in Bash override and `Ctrl+B` parity only if Pi exposes a supported in-flight process handoff API.
