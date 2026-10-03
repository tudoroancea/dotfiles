# Background processes maintenance plan

## Scope

This plan owns deferred internal simplification and performance work for `agent/extensions/background-processes`. It does not change the extension's product contract:

- `background_run` remains completion-oriented;
- `background_event_stream` remains event-oriented;
- output, artifacts, result delivery, queues, and process trees remain bounded;
- wait consumption, at-most-once delivery, cancellation, shutdown verification, and cleanup semantics remain intact;
- the extension owns its runtime, tool results, delivered messages, and TUI renderers;
- long-lived TUI and RPC hosts remain supported, while print and JSON modes reject background tools.

These phases affect safety-critical lifecycle or persistence paths. Keep them separate from documentation cleanup and integration retirement.

## Evidence

- Production runtime: `src/runtime/process-runtime.ts`, `job-store.ts`, `artifact-store.ts`, `results.ts`, and `monitor.ts`
- Lifecycle and mode integration: `src/index.ts`
- TUI renderers and dashboard: `src/ui/`
- Rendering contract: `../TUI_RENDERING.md`
- Current package checks: `package.json`

## Phase 1: measure and freeze lifecycle semantics

- [ ] Add or identify focused fixtures for launch overtaken by shutdown, terminal persistence failure, delivery persistence failure, monitor persistence failure, wait/stop management references, and artifact cleanup.
- [ ] Document which persisted monitor fields are required for crash diagnostics versus only live display.
- [ ] Record baseline checkpoint counts and notification volume for representative completion jobs and event streams.
- [ ] Confirm that no supported caller reuses one `JobStore` across multiple session-runtime generations.

Exit criteria:

- the invariants protected by generation and retry machinery are explicit;
- simplification can be evaluated against measured behavior rather than line count.

## Phase 2: simplify runtime generation ownership

Today a fresh `ProcessRuntime` and `JobStore` are created for each session, so the numeric generation API may be wider than production requires. It nevertheless protects shutdown races and post-shutdown finalization.

- [ ] Replace numeric generation parameters only if Phase 1 proves the store has one production generation.
- [ ] Model the remaining lifecycle explicitly as open/closing/closed, with narrowly named finalization operations allowed after closure where required.
- [ ] Preserve launch-overtaken-by-shutdown behavior, stale mutation rejection, verified process-tree termination, and cleanup ordering.
- [ ] Remove generation-only tests only after equivalent lifecycle-state tests exist.

Exit criteria:

- the public tool behavior is unchanged;
- shutdown-race coverage is at least as strong as before;
- the runtime API no longer represents unsupported multi-generation reuse.

## Phase 3: consolidate bounded checkpoint retries

Terminal metadata, completion-delivery records, and monitor-delivery metadata currently use similar bounded retry structures with different permanent-failure semantics.

- [ ] Define one private checkpoint-with-retry primitive that does not erase those semantic differences.
- [ ] Keep terminal failure transitions, delivery persistence diagnostics, and monitor persistence diagnostics distinct.
- [ ] Preserve retry count, ordering, cleanup protection, and bounded error serialization.
- [ ] Verify injected first-write and permanent-write failures independently for all three paths.

Exit criteria:

- duplicated retry control flow is removed;
- each failure remains observable through its existing bounded contract.

## Phase 4: decide monitor persistence granularity

Persisting monitor counters after live deliveries adds dirty/in-flight/drain machinery but provides crash-visible diagnostics.

- [ ] Use Phase 1 evidence to decide between per-delivery checkpoints, bounded periodic checkpoints, and terminal-only checkpoints.
- [ ] If reducing checkpoint frequency, define the acceptable crash-loss window for diagnostic counters.
- [ ] Keep live event delivery independent of metadata checkpoint latency.
- [ ] Remove monitor persistence state only when no cleanup or artifact-retention decision depends on it.

Exit criteria:

- checkpoint frequency is intentional and measured;
- result delivery and shutdown remain non-blocking and bounded in both TUI and RPC hosts.

## Phase 5: move derived path-bound work out of module initialization

`ARTIFACT_JOB_PATH_MAX_BYTES` is derived through worst-case serialization at import time.

- [ ] Move the derivation to a test or generation/check script.
- [ ] Keep a documented production constant.
- [ ] Add a freshness assertion proving the constant still covers the longest accepted generated job path and serialized result.

Exit criteria:

- module loading performs no binary-search serialization work;
- the artifact-path safety guarantee remains mechanically checked.

## Dependency order

1. Phase 1 precedes every behavioral simplification.
2. Phases 2 and 3 may proceed independently after Phase 1.
3. Phase 4 depends on the diagnostics decision in Phase 1.
4. Phase 5 is independent and may run in parallel.

## Verification

For every phase, run from `agents/pi`, the Pi workspace root:

```sh
nub run --filter pi-background-processes format:check
nub run --filter pi-background-processes lint
nub run --filter pi-background-processes typecheck
nub run --filter pi-background-processes test
nub run --filter pi-background-processes smoke
nub run check
```

Delete this plan when all phases are complete.
