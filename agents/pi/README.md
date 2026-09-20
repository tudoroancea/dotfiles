# Pi setup

This repository is the source-controlled portion of the Pi setup installed directly at `~/.pi`.

## Layout

- `agent/` is Pi's default global agent directory and contains settings, instructions, extensions, skills, prompts, and themes.
- `agent/extensions/web-ui/` is the canonical standalone web UI extension.
- `agent/extensions/web-ui-old/` is an archived donor and remains disabled in `agent/settings.json`.
- `packages/` is reserved for shared workspace packages such as the planned host-neutral web UI client.
- `apps/` contains non-extension applications such as the planned remote session daemon.

Repository development guidance lives in root [`AGENTS.md`](AGENTS.md). Global guidance loaded by every Pi session lives in [`agent/AGENTS.md`](agent/AGENTS.md).

## Install

Clone the repository as the real `~/.pi` directory, not as a nested directory or symlink:

```sh
git clone git@github.com:tudoroancea/pi-setup.git ~/.pi
cd ~/.pi
nub install
nub run check
```

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
PI_CODING_AGENT_DIR="$(git rev-parse --show-toplevel)/agent" pi
```

The committed Worktrunk configuration prepares new worktrees automatically. Its blocking `pre-start` pipeline:

1. Runs `wt step copy-ignored --require-include`. The committed `.worktreeinclude` selects `node_modules/` and `agent/auth.json`; Worktrunk uses reflink copy-on-write where supported, so dependencies can subsequently be changed in the worktree without changing the primary checkout.
2. Symlinks `agent/npm/` and `agent/git/` to those directories in the primary worktree. They contain Pi packages installed from npm and git and do not need independent copies for extension development.

Operational constraints:

- Do not copy `agent/sessions/`. Test sessions then remain disposable with the worktree.
- Keep caches and other ignored runtime state worktree-local unless a test specifically requires them.
- Do not run `pi install`, `pi remove`, or `pi update --extensions` from a worktree whose `agent/npm/` or `agent/git/` is symlinked; those commands would mutate the shared primary stores.

Re-run `nub install` inside the worktree whenever its dependency manifests change. Worktrunk requires approval the first time the committed project hooks run; review and approve the displayed commands.

## Daemon status

`apps/remote-session-daemon/PLAN.md` specifies a future user service. Service implementation, installation, Tailscale ingress, and remote mutation are not part of repository setup and must not be enabled before that plan's security gates pass.
