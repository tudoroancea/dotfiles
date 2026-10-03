# Pi setup repository guidelines

## Workspace ownership

- `agent/` contains Pi's global resources. Author general instructions in `../shared/AGENTS.md` and Pi-specific instructions in `instructions.md`. Mise renders `~/.pi/agent/AGENTS.md`. Do not edit rendered instructions. From this directory, render worktree instructions with `mise run instructions`.
- `agent/extensions/web-ui/` owns the standalone session web UI; `agent/extensions/web-ui-old/` is an archived donor and must remain disabled.
- `agent/extensions/agentflow/` and `agent/extensions/background-processes/` own their respective Pi providers and runtime integrations.
- TUI tool renderers live with their tool owner: `agent/extensions/lib/tools/` for built-ins and shared primitives, and each owning extension's `src/ui/` for extension tools. `agent/extensions/TUI_RENDERING.md` records the renderer contract and browser-parity decisions.
- `packages/pi-web-ui-client/` will own host-neutral browser schemas, reducers, components, fixtures, and styles when that planned package is implemented.
- `apps/remote-session-daemon/` owns the future machine-level daemon. It is not a Pi extension.

## Coordination for parallel development of the web UI and the daemon

The main worktree should remain authoritative for `packages/pi-web-ui-client` schemas and shared contracts; the daemon worktree should primarily modify `apps/remote-session-daemon`.
Contract changes discovered there should be recorded/proposed, then integrated through the Web UI/shared-contract session to avoid conflicting schema edits.

## Pi source boundary

- Never modify Pi itself, patch the installed Pi package, or create a Pi source worktree while implementing features for this setup unless the user explicitly requests an upstream Pi change.
- Build setup features only on Pi's currently installed public APIs. If those APIs cannot support requested behavior, stop and discuss setup-local alternatives or abandonment of the feature instead of changing Pi.

## Checks

Use Nub from the repository root:

- `nub install` installs the workspace.
- `nub run check` runs aggregate formatting, lint, typecheck, and tests.
- `nub run format` formats workspace packages.
- `nub run --filter <package-name> <script>` runs a package-specific check.

Keep package-level manifests and checks independently runnable. Do not delete functioning package lockfiles until a verified root-workspace lockfile replaces them.

## Worktree extension testing

- When testing Pi extensions from a non-primary worktree, render instructions with the Pi-local `mise.toml`, then launch Pi with `PI_CODING_AGENT_DIR="$(git rev-parse --show-toplevel)/agents/pi/agent"` so it loads that worktree's extension sources rather than `~/.pi/agent/extensions`.
- Worktrunk setup may copy `node_modules/` and `agent/auth.json` into the worktree and symlink `agent/npm/` and `agent/git/` to the primary worktree as described in `README.md`.
- Treat symlinked Pi package stores as shared, read-only runtime dependencies. Run `pi install`, `pi remove`, and `pi update --extensions` only from the primary worktree.
- Keep test sessions worktree-local and disposable; do not copy `agent/sessions/` from the primary worktree.

## Extension lifecycle

- Keep long-lived extension resources inside balanced Pi session startup/shutdown ownership and test normal and exceptional cleanup.
- Whenever modifying or creating Pi extensions, audit their interaction with the generated `agent/extensions/herdr-agent-state.ts` lifecycle authority. Never edit that generated file by hand.
- Treat awaited UI that the agent or an autonomous extension action initiated and that genuinely requires human input, approval, or a decision (`select`, `confirm`, `input`, `editor`, or interactive `custom`) as a Herdr blocked scope. Emit balanced `herdr:blocked` active/inactive events with cleanup in `finally`, including cancellation, abort, error, reload, and nested-dialog paths.
- Do not mark UI initiated directly by the user—such as slash-command dashboards, settings, viewers, or confirmations triggered from them—as blocked. Do not mark autonomous foreground or background computation as blocked. Verify that foreground agent/tool work remains working, parent-idle background work remains idle/done until it triggers a follow-up turn, and completion/follow-up delivery produces the normal working-to-idle lifecycle.
- Re-audit TUI versus RPC/print/JSON behavior because `ctx.hasUI` does not imply `ctx.ui.custom()` is interactive. Add lifecycle tests for normal completion and exceptional cleanup, and preserve Herdr's derivation of done from an unseen idle report rather than reporting done directly.

## Dependency and security boundaries

- The shared web UI package must not import Pi APIs, extension implementations, Node HTTP/process APIs, Tailscale code, or daemon code.
- Extensions may import public shared-package exports, but never daemon code. The daemon may import public shared-package exports, but never extension runtime implementations.
- Treat remote launch and control as code execution. Keep daemon roots, arguments, environment, authentication, authorization, Origin checks, generation checks, replay protection, leases, protocol framing, queues, logs, and history strictly bounded as specified in `apps/remote-session-daemon/PLAN.md`.
- Never commit credentials, trust decisions, sessions, caches, logs, transcripts, provider tokens, runtime state, background outputs, or local environment files.

## Plans

- `agent/extensions/PLAN.md` owns cross-extension and standalone-extension maintenance.
- `agent/extensions/agentflow/PLAN.md` owns Agentflow's current implementation and deferred runtime-efficiency work.
- `agent/extensions/background-processes/PLAN.md` owns background-runtime maintenance.
- `agent/extensions/web-ui/PLAN.md` owns standalone/shared-client work.
- `apps/remote-session-daemon/PLAN.md` owns daemon work.
- Update the owning plan as phases complete. Do not duplicate implementation ownership across plans.
