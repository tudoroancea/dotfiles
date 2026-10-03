# Pi setup repository guidelines

## Workspace ownership

- `agent/` contains Pi's global resources. Author general instructions in `../shared/AGENTS.md` and Pi-specific instructions in `AGENTS.md.tera`. The template is canonical. Mise renders `~/.pi/agent/AGENTS.md`. Do not edit generated instructions.
- From this directory, run `mise run instructions` to render worktree instructions from the shared source and the canonical template.
- Standalone extension tests live in `agent/extensions/test/`. Shared helper tests live in `agent/extensions/lib/test/`. Cross-extension tests live in `tests/`. The root Vitest runner owns these three directories. Keep test files out of the extension discovery root.
- `agent/extensions/background-processes/` owns background runtime integration.
- Terminal user interface (TUI) tool renderers live with their tool owner. `agent/extensions/lib/tools/` contains built-in renderers and shared helpers. Each owning extension's `src/ui/` contains its tool renderers. `agent/extensions/TUI_RENDERING.md` records the terminal renderer contract.
- Portable skills live in `../shared/skills/`. Pi-only skills live in `agent/skills/`.

## Pi source boundary

- Never modify Pi itself, patch the installed Pi package, or create a Pi source worktree while implementing setup features unless the user explicitly requests an upstream Pi change.
- Build setup features only on Pi's installed public APIs. If those APIs cannot support the requested behavior, stop and discuss setup-local alternatives.

## Checks

Run Nub from `agents/pi`, the Pi workspace root:

- `nub install` installs the workspace using `nub.lock`.
- `nub run check` runs aggregate formatting, lint, typecheck, and tests.
- `nub run format` formats workspace packages.
- `nub run --filter <package-name> <script>` runs a package-specific check.

Keep package-level manifests and checks independently runnable. Update the workspace `nub.lock` when dependencies change. The npm package store's lockfile is separate from the development workspace lock.

## Worktree extension testing

- Render instructions with the Pi-local `mise.toml`, then launch Pi with `PI_CODING_AGENT_DIR="$(git rev-parse --show-toplevel)/agents/pi/agent"`.
- Prepare worktree dependencies and private runtime files as described in `README.md`.
- Treat symlinked `agent/npm/` and `agent/git/` stores as shared, read-only runtime dependencies. Run `pi install`, `pi remove`, and `pi update --extensions` only from the primary worktree.
- Keep test sessions worktree-local and disposable. Do not copy `agent/sessions/` from the primary worktree.

## Extension lifecycle and security

- Balance long-lived resources across Pi session startup and shutdown. Test normal completion, cancellation, errors, and reload cleanup.
- Check terminal, remote procedure call (RPC), print, and JSON modes. `ctx.hasUI` does not imply that `ctx.ui.custom()` is interactive.
- Never commit credentials, trust decisions, sessions, caches, logs, transcripts, provider tokens, runtime state, background outputs, or local environment files.

## Plans

- `agent/extensions/PLAN.md` owns cross-extension and standalone-extension maintenance.
- `agent/extensions/background-processes/PLAN.md` owns background-runtime maintenance.
- Update the owning plan as phases complete. Do not duplicate implementation ownership across plans.
