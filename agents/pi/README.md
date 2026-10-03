# Pi setup

This directory contains the Pi setup deployed by the dotfiles repository through mise.

## Layout

- `agent/` is Pi's default global agent directory and contains settings, instructions, extensions, skills, prompts, and themes.
- `agent/extensions/web-ui/` is the canonical standalone web UI extension.
- `agent/extensions/web-ui-old/` is an archived donor and remains disabled in `agent/settings.json`.
- `packages/` is reserved for shared workspace packages such as the planned host-neutral web UI client.
- `apps/` contains non-extension applications such as the planned remote session daemon.

Repository development guidance lives in root [`AGENTS.md`](AGENTS.md). Mise combines [`../shared/AGENTS.md`](../shared/AGENTS.md) with Pi-specific instructions in [`instructions.md`](instructions.md) and renders `~/.pi/agent/AGENTS.md`. Agentflow Claude children import the shared file directly and add their controlled policy.

## Install

Apply the development setup from the dotfiles repository:

```sh
mise -E dev bootstrap
```

After editing instructions, run `mise -E dev bootstrap --only dotfiles`. Inspect rendered changes with `mise -E dev bootstrap dotfiles diff`. The bootstrap task installs Pi workspace dependencies.

Credentials, trust decisions, sessions, caches, package stores, logs, and other machine-local runtime state are intentionally ignored. Restore those paths from an owner-only private backup after cloning, or let Pi initialize them on first use; never add them to Git. In particular, a fresh clone does not contain `agent/auth.json`, `agent/trust.json`, or session history.

## Workspace commands

```sh
nub install
nub run check
nub run format
nub run --filter pi-web-ui check
nub run --filter pi-agentflow test
nub run --filter pi-background-processes test
```

Package-level manifests and checks remain independently runnable. Existing package locks are retained until the root Nub workspace and lockfile are proven in both the prepared repository and a fresh clone.

## Testing Pi from a worktree

Pi normally loads this repository through `~/.pi/agent`, so a Pi process started normally will still use extensions from the primary checkout. To test the versions in another worktree, launch Pi with that worktree as its agent directory:

```sh
cd "$(git rev-parse --show-toplevel)/agents/pi"
mise run instructions
PI_CODING_AGENT_DIR="$PWD/agent" pi
```

The local `mise.toml` concatenates the same shared and Pi-specific sources. Repeat the render after instruction edits. The generated file is ignored by Git. This task leaves installed Pi instructions alone.

The Pi-local `.config/wt.toml` records runtime preparation hooks from the standalone Pi repository. In the dotfiles repository, prepare the corresponding `agents/pi/` paths when creating a worktree:

1. Copy `agents/pi/node_modules/` and `agents/pi/agent/auth.json` into the worktree. Keep credentials private.
2. Symlink `agents/pi/agent/npm/` and `agents/pi/agent/git/` to those directories in the primary worktree. They contain Pi packages installed from npm and git and do not need independent copies for extension development.

Operational constraints:

- Do not copy `agent/sessions/`. Test sessions then remain disposable with the worktree.
- Keep caches and other ignored runtime state worktree-local unless a test specifically requires them.
- Do not run `pi install`, `pi remove`, or `pi update --extensions` from a worktree whose `agent/npm/` or `agent/git/` is symlinked; those commands would mutate the shared primary stores.

Re-run `nub install` inside the worktree whenever its dependency manifests change. Worktrunk requires approval the first time the committed project hooks run; review and approve the displayed commands.

## Daemon status

`apps/remote-session-daemon/PLAN.md` specifies a future user service. Service implementation, installation, Tailscale ingress, and remote mutation are not part of repository setup and must not be enabled before that plan's security gates pass.
