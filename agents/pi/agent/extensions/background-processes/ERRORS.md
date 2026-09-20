# Extension error reports

## 2026-08-02 — ArtifactStore fails to initialize when the agent directory is deep (git worktrees)

- **Extension:** background-processes (`agent/extensions/background-processes`)
- **Reproduction:** launch Pi from a non-primary worktree with
  `PI_CODING_AGENT_DIR="$(git rev-parse --show-toplevel)/agent" pi` (e.g. `/Users/tudoroancea/.pi/.worktrees/thinking-color`).
  The extension aborts at session start; the TUI transcript shows:
  `Artifact job path is not completion-safe: generated path requires 181 bytes (181 bytes when serialized), but the supported maximum is 156 bytes.`
  from `assertCompletionSafePath` via `ArtifactStore.performCleanup` → `ProcessRuntime.initialize`.
- **Expected:** the extension binds and background jobs work from any agent directory.
- **Actual:** session start fails with the error above; the runtime never initializes.
- **Root cause:** `ArtifactStore` rooted artifacts at `join(getAgentDir(), "background-processes")`. Job artifact paths travel inside bounded completion notifications (max 156 serialized bytes, derived by `ARTIFACT_JOB_PATH_MAX_BYTES`). With a deep agent dir, session segment (UUIDv7, 36 chars) + runtime segment (UUID, 36 chars) + worst-case job id (`mon_9007199254740991`, 21 chars) + `output.log` exceed the bound: 181 bytes under the worktree agent dir vs 155 bytes under the primary `~/.pi/agent`.
- **Fix:** the store now roots artifacts at `~/.pi/data/bg` (`homedir()/CONFIG_DIR_NAME/data/bg`) — a compact shared root that is stable across agent directories and worktrees and keeps worst-case job paths within the completion-safe bound (136 bytes vs the 156-byte maximum for this machine). The `assertCompletionSafePath` guard remains and still fires for pathological session ids. The legacy roots `~/.pi/agent/background-processes` and the transient `~/.pi/background-processes` were retired manually (transient artifacts, no migration code).
- **Status:** fixed. Tests updated in `test/artifact-store.test.ts` (default-root assertion); 144/144 extension tests pass.
