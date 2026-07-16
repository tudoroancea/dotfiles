# pi-agentflow

A Pi extension for isolated child agents and permission-restricted dynamic workflows. It provides one scheduler, lifecycle, observation, cancellation, persistence, and artifact layer for raw and semantic agent profiles.

The hybrid interface described in [`PLAN.md`](./PLAN.md) is implemented through Phase 5: direct semantic tools and raw workflow semantic helpers share one scheduler and child runtime, and the package is installed from the dotfiles checkout.

## Installation

The package lives at `.pi/agent/extensions/agentflow` in the dotfiles repository. In this checkout, `~/.pi` already points to the repository's `.pi` directory, so install dependencies in place:

```sh
cd ~/.pi/agent/extensions/agentflow
npm install
```

Search-capable child agents use the globally installed `@ff-labs/pi-fff` package. Agentflow resolves the extension that provides `ffgrep` and `fffind`, loads it explicitly in those children, and fails early if the capabilities are unavailable.

For a checkout where `~/.pi` is not itself linked to the dotfiles repository, link the installed entry:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$DOTFILES/.pi/agent/extensions/agentflow" ~/.pi/agent/extensions/agentflow
```

After installation or a source change, run `/reload` in an active Pi session. Starting a new Pi process also reloads the extension.

## Tool surface

Semantic tools are registered by default:

- `agentflow_finder`
- `agentflow_oracle`
- `agentflow_librarian`
- `agentflow_look_at`
- `agentflow_delegate`
- `agentflow_review`

Management tools are always registered:

- `agentflow_status`
- `agentflow_wait`
- `agentflow_cancel`
- `agentflow_steer`

The low-level launch tools are intentionally hidden in normal sessions. Enable them explicitly with `--agentflow-raw`:

- `agentflow_agent`
- `agentflow_workflow`

```sh
pi --agentflow-raw
```

Raw workflows execute JavaScript in a Node permission-restricted child process. Their `agent()`, `finder()`, `oracle()`, `librarian()`, `look_at()`, `delegate()`, and `review()` requests pass through the shared scheduler and child runner. Semantic helpers expose strict role inputs and cannot override trusted model, prompt, tool, extension, or mutation policy. Project trust controls whether project resources are loaded; it is not a filesystem sandbox.

`agentflow_look_at` performs objective-focused analysis of a local image or other file. It requires `path` and `objective`, accepts optional `context`, `referenceFiles`, and foreground/background `mode`, and uses an image-capable Luna child with low thinking. The child has an in-memory session, no skills or extensions, and only the read and structured-output tools. Reference files are read and compared systematically; uncertain or unavailable evidence is reported rather than guessed.

## Dotfiles integration policy

- Shared all-agent behavior belongs in the global `AGENTS.md`; semantic routing remains in each tool's `promptGuidelines`.
- Agentflow publishes background/workflow progress with `setStatus`, which the existing Worktrunk footer renders without replacing either extension's UI.
- Child agents do not inherit global extensions. Explicit child extensions are intersected with Pi's effective enabled-extension set, so a globally or project-disabled extension cannot be re-enabled by Agentflow. Finder, oracle, review, and delegate receive the resolved `pi-fff` extension; librarian receives its resolved research extensions; delegate also receives background-process tools when that extension is active in the parent.
- Agentflow uses the explicit `ffgrep` and `fffind` tool names and leaves Pi's built-in `grep` and `find` inactive.
- Runtime artifacts remain outside this package under `~/.pi/agent/agentflow/<runId>`.

## Architecture

```text
Pi semantic tools ── SemanticAgentService ──┐
Workflow semantic IPC ──────────────────────┼── RunEngine ─── RunStore
Raw agent/workflow requests ────────────────┘
                                             │
                                      shared scheduler
                                             │
                                      SubagentRunner
                                             │
                                  isolated Pi AgentSession
                                             │
                                       ArtifactStore
```

- `RunEngine` owns run/task lifecycle, process-wide and per-run concurrency, cancellation, result envelopes, and background delivery.
- `SemanticAgentService` compiles strict profile input into trusted prompts, capabilities, resources, persistence, and structured output policy.
- `SubagentRunner` constructs deterministic child resources, captures bounded tool-call snapshots, and returns a `ChildExecutionResult`.
- Scheduler callers receive one normalized `AgentTaskResult` success/failure envelope.
- `RunStore` is private to the engine and publishes defensive snapshots.
- Workflow artifacts are stored under Pi's agent directory in `agentflow/<runId>`.
- Child tools matching `agentflow_*` and user-interaction tools are denied to prevent recursive orchestration.

## Development and verification

Run unit checks from the standalone package directory:

```sh
cd ~/.pi/agent/extensions/agentflow
npm test
npm run typecheck
npm run lint
npm run format:check
```

The tests use package-relative assets and do not load live dotfiles resources. Interactive development uses the installed extension configuration:

```sh
npm run dev:tui
npm run dev:tui:raw
npm run dev:rpc
npm run dev:rpc:raw
```

RPC smoke tests make real model calls, are opt-in, and use the same auto-discovered installed extension rather than a separate `-e` path:

```sh
npm run smoke
npm run smoke:workflow
```

Set `PI_AGENTFLOW_SMOKE_MODEL` to override the model used by either smoke script.
