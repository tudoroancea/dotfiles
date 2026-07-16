# Pi 0.80.8 update and extension SDK compatibility

## Context

- Installed Pi: `@earendil-works/pi-coding-agent` 0.80.7 at `/opt/homebrew/bin/pi`.
- Latest release: 0.80.8 (`v0.80.8`, 2026-07-16).
- Primary release risk: SDK model/auth APIs moved to the async `ModelRuntime`; extension-facing `ModelRegistry.refresh()` is now async.
- Local compatibility targets:
  - `.pi/agent/extensions/agentflow`
  - `.pi/agent/extensions/background-processes`
- Both extensions currently resolve Pi SDK packages at 0.80.6.
- Existing unrelated working-tree changes in `.codex/config.toml`, `zed/settings.json`, and `pi-remote/` must not be touched.
- Sources: installed Pi extension/SDK/package docs and the official `v0.80.8` changelog/release notes.

## Implementation phases

- [x] 1. Inventory installed/latest Pi versions, local extension manifests, lockfiles, and repository state.
- [x] 2. Read the official extension, SDK, and package-management documentation plus the 0.80.8 changelog.
- [x] 3. Update the global Pi CLI from 0.80.7 to 0.80.8 and verify the executable/version.
- [x] 4. Update Agentflow's Pi SDK development dependencies and lockfile to 0.80.8; address any compile/test incompatibilities.
- [x] 5. Update Background Processes' Pi SDK development dependencies and lockfile to 0.80.8; address any compile/test incompatibilities.
- [x] 6. Run each extension's typecheck, tests, lint, format check, and smoke coverage. Phases 4 and 5 are independent and may be verified in parallel.
- [x] 7. Run installed-configuration/RPC checks against the updated global Pi, review the final diff, and summarize the relevant changelog impact.
