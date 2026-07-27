# Dedicated `~/.pi` Repository Migration Plan

## Objective

Replace the current home-directory symlink:

```text
~/.pi -> ~/dotfiles/.pi
```

with an actual, independent Git repository rooted at `~/.pi`:

```text
~/.pi/
  .git/
  AGENTS.md                         repository development guidelines
  package.json                      root Nub workspace
  agent/
    AGENTS.md                       global instructions for every Pi session
    settings.json
    extensions/
    skills/
    themes/
    prompts/
    instructions/
  packages/
    pi-web-ui-client/
  apps/
    remote-session-daemon/
```

The migration must preserve credentials, trust decisions, sessions, runtime state, all current uncommitted web UI architecture work, extension code, skills, prompts, themes, instructions, and the archived `web-ui-old` donor.

## Current verified state

At the time this plan was written:

```text
~/.pi is a symlink to /Users/tudoroancea/dotfiles/.pi
current parent repository: /Users/tudoroancea/dotfiles
canonical extension: .pi/agent/extensions/web-ui
archived extension: .pi/agent/extensions/web-ui-old
managed daemon plan: .pi/apps/remote-session-daemon/PLAN.md
```

The dotfiles repository has unrelated and uncommitted changes. Migration must not reset, stage, commit, or otherwise disturb unrelated work such as `.codex/config.toml` or `pi-ui-demo.ts`.

## Why use a staged cutover

Do not unlink `~/.pi` at the beginning of an active Pi migration session. The running process may still use extensions and write its session under the current symlink target. Prepare a complete actual repository at `~/.pi-next`, stop Pi, and then atomically switch names from a normal shell.

The conceptual result is exactly “replace the symlink with an actual directory,” but the staged procedure avoids a half-installed global agent directory and preserves a rollback path.

## Instruction-file behavior

Pi 0.82.1 loads:

- global instructions from `~/.pi/agent/AGENTS.md`;
- one context file per traversed project directory, preferring `AGENTS.md` over `CLAUDE.md`;
- duplicate resolved paths only once.

The final repository therefore intentionally has two files:

```text
~/.pi/AGENTS.md                 repository-only development guidelines
~/.pi/agent/AGENTS.md           global instructions for all Pi sessions
```

Pi does not discover project instructions from `.pi/AGENTS.md`, so do not try to solve this with another nested `.pi` directory.

## Safety invariants

1. Never run `rm -rf ~/.pi` while it is a symlink; use `unlink` only after confirming the exact target.
2. Never delete `~/dotfiles/.pi` until the new repository has a verified commit and backup.
3. Never stage credentials, trust data, sessions, caches, logs, background outputs, or temporary state.
4. Never print credential contents during inventory or verification.
5. Preserve file permissions for `auth.json`, `trust.json`, and other private state.
6. Do not reload or restart Pi between breaking the old symlink and completing the cutover.
7. Do not create a GitHub remote until the user chooses repository name and visibility.
8. Do not amend, stage, or commit unrelated dotfiles changes.
9. Keep the migration plan updated with checkmarks; delete it from both repositories only after every completion criterion passes.

## Target ignore policy

Create `~/.pi-next/.gitignore` before the first `git add`. At minimum it must contain anchored rules equivalent to:

```gitignore
# Root Pi/tool runtime state
/pi-acp/
/web-search.json

# Global agent credentials and machine-local state
/agent/auth.json
/agent/trust.json
/agent/sessions/
/agent/cache/
/agent/tmp/
/agent/bin/
/agent/workflows/
/agent/agentflow/
/agent/background-processes/
/agent/models-store.json

# Local environment and generated package/build state
.env
.env.*
!.env.example
.DS_Store
**/.DS_Store
**/node_modules/
**/dist/
**/test-results/
**/playwright-report/
```

Do not use broad unanchored rules such as `agentflow/` or `background-processes/` that could hide tracked source under `agent/extensions/`.

Review existing nested `.gitignore` files and retain stricter package-specific exclusions where useful.

## Target workspace

The dedicated repository should use a root package manifest because coordinated extension/shared/daemon development is now intentional:

```json
{
  "private": true,
  "type": "module",
  "workspaces": [
    "agent/extensions/web-ui",
    "agent/extensions/agentflow",
    "agent/extensions/background-processes",
    "packages/*",
    "apps/*"
  ]
}
```

Verify the exact Nub-compatible workspace syntax before freezing the manifest. Preserve package-level manifests and checks. Use `workspace:*` for the future shared package:

```json
"@dotfiles/pi-web-ui-client": "workspace:*"
```

Do not create `packages/pi-web-ui-client` merely as an empty placeholder during migration unless required to validate workspace behavior. Its implementation remains Phase 2 of `agent/extensions/web-ui/PLAN.md`.

## Phase 0 — preflight and immutable inventory

- [ ] Confirm the paths again without following destructive commands:
  - `~/.pi` is a symlink;
  - its resolved target is exactly `~/dotfiles/.pi`;
  - the parent Git root is exactly `~/dotfiles`.
- [ ] Record `git -C ~/dotfiles status --short` in the session notes without modifying it.
- [ ] Identify every tracked path currently under `~/dotfiles/.pi`.
- [ ] Identify runtime/secret paths under `~/dotfiles/.pi` without reading their contents.
- [ ] Confirm free disk space for a full safety copy plus package installation.
- [ ] Confirm `~/.pi-next` and the chosen backup path do not already exist.
- [ ] Confirm no background process is currently mutating source code; active Pi session-file writes are acceptable because source remains in place until cutover.
- [ ] Run the canonical extension baseline before copying:

  ```sh
  cd ~/dotfiles/.pi/agent/extensions/web-ui
  nub run check
  ```

- [ ] Save a bounded path/permission inventory for later comparison; never include file contents or secrets.

Exit criteria:

- source/target paths and unrelated changes are unambiguous;
- canonical checks pass;
- no destructive command has run.

## Phase 1 — create safety backup

- [ ] Create a timestamped private backup outside both repositories, for example under the home directory with owner-only permissions.
- [ ] Copy `~/dotfiles/.pi/` into that backup while preserving permissions and symlinks.
- [ ] Include runtime state and credentials in the private backup.
- [ ] Exclude bulky reproducible `node_modules` and build output only if disk pressure justifies it; record exclusions.
- [ ] Verify representative source paths, `agent/auth.json` existence/permissions, session directory count, and the web UI/daemon plans in the backup.
- [ ] Do not add the backup to either Git repository.

Exit criteria:

- rollback does not depend on the parent dotfiles working tree.

## Phase 2 — prepare `~/.pi-next`

- [ ] Create `~/.pi-next` as a real owner-only directory.
- [ ] Copy the complete contents of `~/dotfiles/.pi/` into `~/.pi-next/`, preserving hidden files and permissions.
- [ ] Exclude `node_modules` and generated build/test output; plan to reinstall/rebuild.
- [ ] Copy this plan to `~/.pi-next/MIGRATION_PLAN.md` so progress survives the cutover.
- [ ] Rewrite temporary migration-plan links inside the prepared tree so they resolve to that copy:
  - `../../../MIGRATION_PLAN.md` from `agent/extensions/web-ui/PLAN.md` and `README.md`;
  - `../../../../MIGRATION_PLAN.md` from `agent/extensions/web-ui/docs/RPC_FIRST_REMOTE_DASHBOARD.md`;
  - `../../MIGRATION_PLAN.md` from `apps/remote-session-daemon/PLAN.md`.
- [ ] Record these as temporary links that must be removed or retargeted to permanent setup documentation before deleting `MIGRATION_PLAN.md`.
- [ ] Initialize Git in `~/.pi-next`.
- [ ] Create the root `.gitignore` before staging anything.
- [ ] Confirm copied machine-local files are ignored with `git check-ignore -v`:
  - `agent/auth.json`;
  - `agent/trust.json`;
  - one session file;
  - one Agentflow/background runtime path;
  - `pi-acp/session-map.json` and `web-search.json` when present.
- [ ] Confirm source paths are not accidentally ignored:
  - `agent/extensions/agentflow/`;
  - `agent/extensions/background-processes/`;
  - `agent/extensions/web-ui/`;
  - `agent/extensions/web-ui-old/`;
  - `apps/remote-session-daemon/PLAN.md`.

Exit criteria:

- `~/.pi-next` contains a safe actual Git working tree with correct ignore behavior;
- old symlink and source remain untouched.

## Phase 3 — establish repository development context

- [ ] Keep `agent/AGENTS.md` as the global instructions file; preserve its relative imports under `agent/instructions/`.
- [ ] Create root `AGENTS.md` containing only repository development guidance:
  - workspace/package ownership;
  - formatting, lint, typecheck, and test commands;
  - extension lifecycle and Herdr requirements;
  - shared-package import boundaries;
  - daemon security boundaries;
  - no secrets/runtime state in Git;
  - plan ownership and update rules.
- [ ] Do not duplicate all global preferences in root `AGENTS.md`; they already arrive from `agent/AGENTS.md`.
- [ ] Add root README/SETUP documentation explaining:
  - repository cloned as `~/.pi`;
  - `agent/` is Pi's global directory;
  - runtime/secret paths are ignored;
  - workspace install/check commands;
  - daemon service installation remains a later phase.
- [ ] Add or adapt the root package manifest, TypeScript config, formatter/linter configuration, and aggregate scripts.
- [ ] Verify Nub workspace behavior before changing package dependencies.
- [ ] Standardize lockfiles only when the workspace experiment succeeds; do not delete functioning package locks preemptively.

Exit criteria:

- global and repository instructions have distinct ownership;
- root workspace commands are documented and reproducible.

## Phase 4 — security audit before first commit

- [ ] Inspect `git status --short --ignored` from `~/.pi-next`.
- [ ] Stage source intentionally; avoid blind staging until ignore checks pass.
- [ ] Inspect every staged path with `git diff --cached --name-only`.
- [ ] Assert no staged path matches credentials/runtime patterns such as:
  - `auth.json`;
  - `trust.json`;
  - `.env` other than `.env.example`;
  - `sessions/`, `cache/`, `tmp/`, `pi-acp/`;
  - runtime `agentflow/` or `background-processes/` outside `agent/extensions/`;
  - provider credentials, tokens, logs, or transcripts.
- [ ] Run a secret scanner if available, plus bounded searches for common token/private-key markers.
- [ ] Review settings/models files for machine-specific secrets before staging.
- [ ] Confirm generated Herdr lifecycle authority is handled according to its generation policy; never hand-edit it during migration.
- [ ] Review executable bits and private-file permissions.
- [ ] Create the first local commit only after this audit passes.
- [ ] Do not publish or create a remote yet.

Exit criteria:

- the new repository has a local, secret-free baseline commit;
- ignored runtime state remains physically present for cutover.

## Phase 5 — validate the prepared repository before cutover

- [ ] Install dependencies from `~/.pi-next` using the verified Nub workspace workflow.
- [ ] Run root aggregate formatting, lint, typecheck, and tests.
- [ ] Run package checks independently/through filters for:
  - `agent/extensions/web-ui`;
  - `agent/extensions/agentflow`;
  - `agent/extensions/background-processes`;
  - any other package with its own manifest.
- [ ] Confirm `agent/settings.json` disables only `extensions/web-ui-old/src/index.ts`, not the canonical web UI.
- [ ] Confirm all active relative Markdown links resolve inside the future repository.
- [ ] Confirm no active documentation refers to old dotfiles paths or `file:` dependencies.
- [ ] Confirm `apps/remote-session-daemon/PLAN.md` and `agent/extensions/web-ui/PLAN.md` agree on workspace ownership.
- [ ] Verify the expected root/project context files with Pi's `loadProjectContextFiles` utility or a controlled startup using:
  - `cwd = ~/.pi-next`;
  - `agentDir = ~/.pi-next/agent`.
- [ ] Expected context paths include exactly the distinct root and global instruction files, without duplicating the global file.

Exit criteria:

- the prepared repository works independently of `~/dotfiles/.pi` except for the not-yet-switched home path.

## Phase 6 — controlled cutover from a normal shell

This phase runs only after every process capable of writing through the old `~/.pi` symlink is quiescent.

- [ ] End the migration Pi session cleanly and wait for its session file to flush.
- [ ] Inventory and stop **all** other Pi processes, RPC children, extension/background descendants, package installs/builds, and any future daemon process using the old tree—not only the session that prepared the migration.
- [ ] Use process/open-file inspection to verify no relevant writer still has the old `~/dotfiles/.pi` tree open. If the tree cannot be made quiescent, abort cutover and leave the symlink unchanged.
- [ ] Keep all such writers stopped until the new `~/.pi` directory and required runtime files have been verified.
- [ ] From a normal shell, re-confirm:

  ```text
  ~/.pi is still a symlink to ~/dotfiles/.pi
  ~/.pi-next is an actual directory with a verified Git commit
  ```

- [ ] After all writers are quiescent, perform an exact **allowlisted runtime mirror** from `~/dotfiles/.pi` into `~/.pi-next` without touching tracked source/configuration:
  - mirror each known ignored runtime directory separately with deletion semantics confined to that directory, so removed sessions/workflows/cache entries do not reappear;
  - overwrite each known ignored runtime file from the old target, and explicitly remove its prepared-tree copy when the source file no longer exists, including revoked `trust.json` or replaced credential/state files;
  - preserve ownership, modes, and symlink behavior.
- [ ] Re-verify owner-only permissions for `auth.json`, `trust.json`, and other private state plus representative session/runtime inventories before unlinking `~/.pi`.
- [ ] Create a cutover-time owner-only snapshot/manifest of the exactly mirrored old ignored runtime state for rollback comparison.
- [ ] Use `unlink ~/.pi` to remove only the symlink.
- [ ] Rename `~/.pi-next` to `~/.pi` on the same filesystem.
- [ ] Confirm immediately:

  ```text
  ~/.pi is a real directory
  ~/.pi/.git exists
  ~/.pi/agent/AGENTS.md exists
  ~/.pi/agent/auth.json remains private and exists when it existed before
  ```

- [ ] If any assertion fails, move the new directory aside and restore the old symlink to `~/dotfiles/.pi`; do not improvise destructive cleanup.

Exit criteria:

- default Pi paths now resolve inside the dedicated repository without symlinks.

## Phase 7 — post-cutover verification in a new Pi session

- [ ] Start Pi with cwd `~/.pi` and inspect loaded context files.
- [ ] Confirm both are loaded once:
  - `~/.pi/agent/AGENTS.md` as global guidance;
  - `~/.pi/AGENTS.md` as repository guidance.
- [ ] Start Pi from a normal unrelated project and confirm only global guidance applies from this repository.
- [ ] Confirm canonical `web-ui` loads and `web-ui-old` remains disabled.
- [ ] Exercise `/copy-url`, authenticated page load, SSE, prompt input, and extension shutdown.
- [ ] Run root and package checks again from the final path.
- [ ] Confirm session resume, model settings, authentication, trust decisions, skills, prompts, themes, Agentflow, and background processes still work.
- [ ] Confirm `git -C ~/.pi status --short` does not report runtime churn.
- [ ] Confirm `git -C ~/.pi status --ignored` shows expected machine-local state as ignored.

Exit criteria:

- normal Pi use and repository development both work from final paths.

## Phase 8 — detach the old dotfiles ownership

Only begin after Phase 7 passes and the backup remains available.

- [ ] In `~/dotfiles`, remove the old tracked `.pi` tree from that repository in a dedicated change, preserving unrelated staged/unstaged state.
- [ ] Do not remove the private migration backup yet.
- [ ] Update dotfiles setup documentation/scripts to:
  - initialize/clone the dedicated repository as `~/.pi`;
  - avoid recreating the old symlink;
  - leave repository URL/visibility decisions explicit until the remote exists.
- [ ] Remove obsolete `.pi/...` ignore rules from the dotfiles repository only when they no longer apply.
- [ ] Verify dotfiles setup no longer mutates or owns `~/.pi/agent` files.
- [ ] Commit only the dotfiles detachment changes separately from unrelated work.

Exit criteria:

- the two repositories have clear ownership and independent histories.

## Phase 9 — remote creation and fresh-install proof

- [ ] Ask the user for repository name, owner, and public/private visibility.
- [ ] Create/configure the remote only after explicit confirmation.
- [ ] Push the audited repository.
- [ ] Perform a fresh clone in a temporary location.
- [ ] Run Nub install and aggregate checks from the fresh clone.
- [ ] Verify no secret/runtime files exist in Git history or clone.
- [ ] Document recovery/install commands without embedding credentials.
- [ ] Replace temporary `MIGRATION_PLAN.md` links in active README/PLAN/architecture documents with permanent setup documentation or remove them, then rerun the relative-link check.
- [ ] Keep the private backup until the fresh-clone proof and several normal Pi sessions succeed.

## Rollback

Before dotfiles detachment:

1. stop and quiesce every Pi/daemon/background/package writer, using the same process/open-file checks as cutover;
2. move the new `~/.pi` repository aside without deleting it;
3. restore a private working copy of the old `~/dotfiles/.pi` tree from the cutover snapshot/source;
4. reconcile **only the allowlisted ignored runtime paths** from the moved-aside new repository back into that restored old tree:
   - mirror session, cache, Agentflow/background, workflow, and other runtime directories with deletion semantics scoped to each known ignored directory;
   - overwrite or explicitly remove individual `auth.json`, `trust.json`, `models-store.json`, and root runtime files to match the new tree;
   - preserve ownership and permissions;
5. compare the resulting runtime inventory with the cutover manifest and verify auth/trust file permissions and session counts;
6. recreate the `~/.pi` symlink to the reconciled old tree only after those checks pass;
7. restart Pi and verify global resources, authentication, trust, and recent session visibility;
8. preserve the moved-aside new repository and private backups for diagnosis.

Do not copy tracked new-repository source/configuration over the old tree during rollback; reconcile runtime state separately. After dotfiles detachment, restore the old source from the private backup and apply the same scoped runtime reconciliation rather than relying on parent-repository history alone.

Never roll back by restoring only `agent/AGENTS.md` or settings. Credentials, trust, sessions, extensions, and package/runtime state must remain internally consistent.

## Completion criteria

Migration is complete when:

- `~/.pi` is a real Git repository directory, not a symlink;
- `~/.pi/agent` remains Pi's default global directory without overrides;
- root `AGENTS.md` contains repository-only guidance and `agent/AGENTS.md` contains global guidance;
- Pi loads both exactly once while developing the repository and only global guidance elsewhere;
- all required source/configuration has moved from dotfiles ownership;
- secrets, trust, sessions, caches, runtime logs, and temporary state are ignored and absent from Git history;
- root Nub workspace install and aggregate checks pass;
- canonical `web-ui`, Agentflow, background processes, skills, prompts, themes, auth, trust, and session resume work;
- `web-ui-old` remains archived and disabled;
- web UI and daemon plans use `agent/`, `packages/`, and `apps/` paths plus workspace dependencies;
- dotfiles no longer creates the old `~/.pi` symlink or owns Pi source/configuration;
- a fresh clone passes install/check without private state;
- rollback backup has been retained for an agreed observation period.

After all criteria pass, delete `MIGRATION_PLAN.md` from the dedicated repository and `PI_SETUP_REPO_MIGRATION_PLAN.md` from the dotfiles repository in their respective final cleanup commits.
