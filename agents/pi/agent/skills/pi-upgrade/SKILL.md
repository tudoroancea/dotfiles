---
name: pi-upgrade
description: Upgrade Pi, installed Pi packages, and retained custom extensions. Inspect installation ownership, release notes, SDK changes, package pins, and verification before reporting success.
compatibility: Requires git, network access, and the package manager that owns Pi. This development workspace uses Nub.
---

# Upgrade Pi and its extensions

Resolve the inspection script relative to this skill directory:

```sh
bash scripts/inspect-pi-install.sh
```

Treat detection as evidence. Never print credentials, `auth.json`, trust decisions, or transcripts.

## Establish source and installation state

1. Resolve deployed `~/.pi/agent` links to the setup checkout and read its rules.
2. Check Git status, branch, upstream, and remotes. Preserve unrelated changes.
3. Fetch the upstream remote, then compare `HEAD...@{upstream}`. Inspect incoming manifests, settings, extensions, and this skill before making changes. If fetch fails, diagnose it rather than trusting stale refs.
4. Do not reset, rebase, overwrite local work, or integrate remote changes without the user's authorization. Source synchronization does not update the installed CLI.
5. Record `pi --version`, command path, resolved path, owning installer, `pi list`, configured package sources, and workspace manifests.

The dotfiles checkout owns `agents/pi/`. The deployed npm and Git stores are under `~/.pi/agent/npm` and `~/.pi/agent/git`. They are separate from the development workspace.

When several npm installations exist, inspect the one beside the resolved Pi executable. For example, a Pi under `/opt/homebrew/lib/node_modules` belongs to `/opt/homebrew/bin/npm`, not necessarily the Mise npm on `PATH`. Confirm its global root before updating it.

## Review the target before installing

Query the registry without installing:

```sh
nub view @earendil-works/pi-coding-agent version
```

Download the target tarball into a temporary directory and read its packaged changelog, declarations, docs, and relevant companion-package changes. Read every intervening version, including changed behavior outside breaking-change headings. Remove the temporary download after the review.

Map changes to actual retained imports and callers. Pay attention to:

- Background completion and event-stream delivery, process cleanup, and session lifecycle.
- Automatic naming, model requests, authentication, timeout, and cancellation.
- Built-in renderer re-registration, tool exposure, reload, and explicit tool restrictions.
- Editor, keybindings, TUI rendering, and historical session-cost parsing.
- Interactive versus RPC, print, and JSON behavior. `ctx.hasUI` does not establish an interactive terminal.

Review newer versions of each installed package before moving a pin. From `agents/pi/`, `nub run check:extensions` checks the deployed stores. Read incoming Git commits for context-usage and release notes for web-access and FFF. If a package has no changelog, inspect its diff and current source.

## Upgrade packages and the CLI

Run the supported updater first:

```sh
pi update --all
```

Capture the complete result. Package updates can succeed before a self-update fails.

Pinned npm versions and Git refs do not advance automatically. Update reviewed pins explicitly with `pi install <source>@<target>`. Keep intentional pins. FFF is a dependency of the local renderer wrapper, not a second entry in `settings.packages`.

If self-update fails, use the verified owning manager. For an npm-owned Pi, include the verified prefix when the active npm differs. For a Nub-owned global package, use `nub add --global`. Do not install another manager to work around incorrect detection or overwrite a standalone/Nix/source installation.

Verify command resolution, `pi --version`, and the owning manager's package listing after installation. Update host SDK dependencies in the deployed npm manifest if present, and regenerate its existing npm lockfile separately.

## Migrate the development workspace

Run from `agents/pi/`:

1. Align retained `@earendil-works/pi-*` dependencies with the target. Preserve exact-versus-range policy.
2. Update the FFF wrapper's reviewed vendor pin when requested.
3. Run `nub install` to regenerate the root `nub.lock`. Do not introduce package-level lockfiles or delete the deployed npm lockfile.
4. Typecheck against target declarations. Apply only migrations used by retained code.
5. Keep long-lived resources balanced across startup, shutdown, reload, cancellation, and errors.
6. Keep notifications silent outside TUI mode. Verify background work in supported long-lived TUI and RPC hosts.

Retain historical cost decoding for old Pi sessions. Removing a producer does not make its persisted history disposable.

## Verify and report

Start with focused tests for changed components. Then run:

```sh
nub run check
nub run --filter pi-background-processes smoke
```

Also check real resource discovery against deployed settings. Confirm optional presentation extensions remain disabled and all requested skills, themes, and packages load without errors. Avoid live model calls unless they are needed and authorized.

Finally, run `pi list`, repeat the installation inspection, and inspect Git diff/status. Report exact versions, pins, checks, failures, and remaining unverified behavior. Never weaken tests to force a pass.

Do not reload a running Pi process into version-skewed modules. Ask the user to restart Pi. Do not commit or push unless requested; uncommitted source changes are not available to another machine through Git.
