# Pi setup

This directory owns the Pi terminal setup deployed through Mise. The web clients, daemon, and Agentflow are retired. Their earlier implementations remain recoverable from repository history and the separate `pi-setup` repository.

## Retained resources

- Background-process tools, copyable regions, native FFF search, automatic session naming, terminal notifications, working messages, questionnaire, tool selection, and historical usage reporting.
- Boxed editor, compact built-in renderers, and custom header remain available but disabled in `agent/settings.json`.
- Web-access and context-usage package sources are pinned in settings. FFF is pinned in its local wrapper manifest.
- Rose Pine themes and custom keybindings remain unchanged.
- `pi-upgrade` is a Pi-only skill. Typst guidance lives in `../shared/skills/typst-local` and is linked into the deployed Pi skill directory.

Historical cost readers still understand old Agentflow entries. Runtime history, credentials, trust decisions, caches, and background outputs are private machine state, not source files.

## Install and check

From this directory:

```sh
nub install
nub run check
nub run --filter pi-background-processes smoke
```

The root `nub.lock` owns development dependencies. `nub install` creates the workspace's root and package-level `node_modules` links under `agents/pi/`. Do not run a second workspace install under `~/.pi`.

Mise links `~/.pi/agent/extensions` directly to the source directory, so extensions resolve their dependencies from the source workspace. Settings, models, keybindings, themes, prompts, and skills have separate deployment entries. Development manifests, test-runner configuration, and repository instructions are not deployed.

Credentials, sessions, caches, and background outputs remain machine-local under `~/.pi/agent`. Pi owns its separate npm and Git package stores there. Their installation and lockfiles are independent of `nub.lock`.

From the dotfiles root, preview the development overlay before applying it:

```sh
mise -E dev bootstrap dotfiles apply --dry-run
mise -E dev bootstrap dotfiles apply
```

If an existing deployment has a real `~/.pi/agent/extensions` directory, inspect it before replacing it with the directory link. Do not force-overwrite private or untracked files.

`AGENTS.md.tera` is the canonical Pi-specific instruction source. Its first line imports `../shared/AGENTS.md`. Mise renders installed instructions; do not edit `~/.pi/agent/AGENTS.md` directly.

## Test ownership

- `agent/extensions/test/` covers standalone extensions, including naming, notifications, tool selection, and session breakdown.
- `agent/extensions/lib/test/` covers shared accounting and renderer helpers.
- `tests/` covers resource discovery and cross-owner renderer goldens.
- Packaged extensions retain their own `test/` directories and independently runnable checks.

The root `vitest.config.ts` includes only the first three directories. `nub run test:setup` runs them; `nub run test` also runs package-owned suites without duplicating them. Keep `.test.ts` files out of `agent/extensions/` itself, where Pi discovers extensions.

## Test from another worktree

Render worktree instructions, then select its resources explicitly:

```sh
cd "$(git rev-parse --show-toplevel)/agents/pi"
mise run instructions
PI_CODING_AGENT_DIR="$PWD/agent" pi
```

Trust the local Mise config only after reviewing it. The rendering task uses the shared instructions and canonical template.

Prepare `agents/pi/` paths manually in the worktree. Install its dependencies, copy credentials only when needed, and link its `agent/npm/` and `agent/git/` to the primary deployment stores. The old standalone-repository Worktrunk hooks are removed.

Do not copy sessions. Keep tests disposable and runtime state worktree-local. Do not run Pi package install/remove/update commands from a secondary worktree with shared package stores.
