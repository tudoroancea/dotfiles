---
name: pi-upgrade
description: Upgrade Pi itself, installed npm/git Pi packages, and local custom Pi extensions to the latest compatible APIs. Use when asked to update, upgrade, or check Pi and its extensions; includes install-manager detection (especially nub), remote dotfiles synchronization, changelog review, SDK migrations, and verification.
compatibility: Requires git and network access; uses nub when Pi is installed in nub's global package store.
---

# Pi upgrade

Perform the upgrade end to end. Do not reduce this to a blind package-manager update: Pi SDK changes can require edits to local extensions.

Resolve paths relative to this skill directory. Start by running:

```bash
bash scripts/inspect-pi-install.sh
```

Treat its output as evidence, not infallible detection. Never expose credentials or print `auth.json`.

## 1. Synchronize the dotfiles repository first

Before changing or installing anything:

1. Locate the repository containing `~/.pi/agent` (resolve symlinks) and read its instructions.
2. Check `git status`, current branch, upstream, and remotes. Preserve unrelated work.
3. Run `git fetch --prune` for the upstream remote. If it fails, do not trust stale remote-tracking refs or skip this check. Diagnose authentication and, when appropriate, inspect the same repository through authenticated `gh` access or a one-off HTTPS fetch without rewriting the user's remote configuration. Do not integrate until a fetch succeeds.
4. Compare `HEAD...@{upstream}` and inspect remote-only commits, especially changes under:
   - `.pi/agent/settings.json`
   - `.pi/agent/extensions/`
   - `.pi/agent/skills/pi-upgrade/`
   - package manifests and lockfiles
5. Decide from the diff and manifests—not a commit subject alone—whether another machine already performed the source migration.
6. If upstream is strictly ahead and the worktree is clean, fast-forward with `git pull --ff-only`. If local work or divergence exists, do not overwrite it; integrate through the repository's normal workflow or stop and explain the conflict.
7. Re-run the installation inspection and re-read any changed manifests after integrating upstream.

A remote migration does not update this machine's globally installed Pi binary or package caches. Even when the source work is already present, continue with local installation/version checks and verification. Avoid recreating equivalent migration edits.

## 2. Establish the upgrade range and package state

Record:

- `pi --version`, executable path, and resolved executable path
- the detected global installer
- `pi list` and configured package sources in global/project settings
- custom extension manifests and lockfiles
- clean/dirty state before edits

For each configured npm/git Pi package, determine its installed version/ref and available target before mutation. Read intervening release notes for npm packages and inspect incoming commits for git packages, looking for breaking behavior, renamed resources, settings migrations, and filter paths that no longer exist.

Get the latest Pi registry version without installing it. Prefer `nub view @earendil-works/pi-coding-agent version` when nub exists; otherwise use the detected package manager's registry query.

Fetch the **target release's packaged changelog before upgrading** so the review covers every version between installed and target:

```bash
tmp=$(mktemp -d)
tarball=$(nub view @earendil-works/pi-coding-agent dist.tarball)
curl -fsSL "$tarball" -o "$tmp/pi.tgz"
tar -xOf "$tmp/pi.tgz" package/CHANGELOG.md > "$tmp/CHANGELOG.md"
```

Use the detected manager instead of `nub view` if nub is unavailable. Clean the temporary directory when finished.

Read all intervening entries, not only headings named “Breaking Changes.” Search `Breaking`, `Changed`, `Removed`, `Deprecated`, `SDK`, `Extension`, `Tool`, `Session`, `TUI`, and `Model`. Follow linked official docs, examples, pull requests, or release commits when an entry affects code used locally. Compare the new packaged type declarations or upstream source when the migration is ambiguous.

If installed Pi is already current, still check package sources, custom extension SDK dependency versions, and remote commits before concluding there is nothing to do.

## 3. Update installed Pi packages and Pi itself

Run Pi's supported updater first:

```bash
pi update --all
```

Capture its complete outcome. It may update npm/git Pi packages before self-update fails.

Review configured package sources afterward:

- Unversioned npm sources can advance normally.
- Versioned npm sources are pinned and skipped.
- Git tags/commits are pinned and reconciled but are not advanced to a newer ref.
- Local paths are source code, not copied packages.

For every pinned source, determine whether “latest” means the newest registry version, release tag, or default-branch commit. Inspect changelogs/diffs before moving it, then use `pi install <same-source>@<new-version-or-ref>` to update the configured pin. Do not silently unpin intentionally pinned dependencies. Verify unpinned git clones against their remotes rather than assuming `pi update` advanced them.

### Self-update fallback

If Pi self-update fails, use the installer that actually owns the resolved executable:

- **nub global store** (a path containing `global-nub`, or confirmed by `nub list -g`):
  ```bash
  nub add --global @earendil-works/pi-coding-agent@latest
  ```
  Pi currently identifies this layout as pnpm internally and may try `pnpm`; do not install pnpm merely to work around that failure.
- **npm**: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest`
- **pnpm**: `pnpm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest`
- **bun**: `bun install -g --ignore-scripts @earendil-works/pi-coding-agent@latest`
- **yarn classic**: `yarn global add --ignore-scripts @earendil-works/pi-coding-agent@latest`
- **standalone/source/Nix/unknown**: do not guess or overwrite managed paths; report the detected provenance and use its documented update mechanism.

Afterward run `hash -r`, then verify the command path, resolved path, `pi --version`, and the owning manager's global package listing. Never report an upgrade based only on a successful install command.

## 4. Migrate local custom extensions

Inspect every local TypeScript/JavaScript Pi extension that imports Pi SDK/TUI packages. Give extra scrutiny to:

- `.pi/agent/extensions/agentflow/`
- `.pi/agent/extensions/background-processes/`

For each extension with a manifest:

1. Update Pi SDK development dependencies to the target Pi version, including all locally used `@earendil-works/pi-*` packages. Preserve the manifest's existing exact-versus-range policy unless the changelog requires alignment.
2. Regenerate its existing lockfile with the manager/format already used by that extension; do not introduce a second lockfile format. In this repository Agentflow currently owns `package-lock.json`, while background-processes owns `nub.lock`.
3. Typecheck against the new declarations.
4. Map every relevant changelog/API change to actual imports and call sites. Remove obsolete compatibility code and migrate to the current documented API.
5. Compare SDK-heavy code with current official examples, especially child `AgentSession` creation/model runtime in Agentflow and process/tool/session/UI lifecycle behavior in background-processes.

Do not make speculative migrations for APIs the extension does not use.

### Lifecycle authority audit

Never edit autogenerated `.pi/agent/extensions/herdr-agent-state.ts`. Audit all custom-extension changes against it:

- Awaited human interaction must balance `herdr:blocked` active/inactive events in `finally`.
- Autonomous foreground/background work must not be marked blocked.
- Recheck TUI versus RPC/print/JSON behavior; `ctx.hasUI` does not make `ctx.ui.custom()` interactive.
- Preserve Herdr's unseen-idle derivation of done and test exceptional cleanup.

## 5. Verify before declaring success

Use each extension's own scripts. At minimum, for both Agentflow and background-processes run:

```bash
nub run typecheck
nub run test
nub run lint
```

Then run their bounded smoke/RPC checks when available. Also verify any other changed custom extension with its local checks. Diagnose failures as API migrations first; do not weaken tests or types to force a pass.

Finally:

1. Run `pi list` and inspect installed npm package versions and git clone refs/remotes.
2. Re-run the install inspection script.
3. Review `git diff` and ensure only upgrade-related source/manifests/locks changed.
4. Check `git status` and report any pre-existing unrelated changes separately.
5. Do **not** reload the currently running Pi process into potentially version-skewed code. Tell the user to restart Pi so the upgraded binary and extensions load together.
6. Do not commit or push unless requested. If changes remain uncommitted, say that another machine cannot discover them through remote commits until they are committed and pushed.

Report: old/new Pi versions, how Pi was updated, package source updates/pins, remote commits reused, changelog migrations applied, changed files, checks run, and anything still blocked.
