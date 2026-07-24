# pi-agentflow

A Pi extension for isolated child agents and permission-restricted dynamic workflows. It provides one scheduler, lifecycle, observation, cancellation, persistence, and artifact layer for raw and semantic agent profiles.

The hybrid interface is complete through Phase 5: direct semantic tools and raw workflow semantic helpers share one scheduler and child runtime, and the package is installed from the dotfiles checkout.

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

The controlled Claude coding child is also registered by default:

- `agentflow_claude({ task, model?, mode? })`

`model` accepts only `fable`, `opus`, or `sonnet` and defaults to `opus`; Haiku is intentionally unavailable. Use Fable for exceptional advisory or review problems and Opus for frontend, visual, UX, copy, or other taste-sensitive implementation. The task must be self-contained and must say whether the child should advise only or edit files. Foreground and background runs use the same Agentflow status, wait, cancellation, delivery, snapshot, and cost lifecycle as Pi children. Claude runs do not support steering, continuation, or persisted sessions in this version.

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

Workflow scripts use a static metadata header and bare helper calls:

```js
export const meta = {
  name: "inspect_project",
  description: "Inspect independent parts of the project.",
  phases: [{ title: "Inspect" }],
};

phase("Inspect");
const results = await parallel([
  () => finder({ task: "Map the implementation." }),
  () => oracle({ question: "Recommend the smallest safe design." }),
]);
for (const result of results) {
  if (!result.ok) throw new Error(result.error ?? "Inspection failed");
}
return { results };
```

Use `delegate({...})`, never `agent.delegate({...})`. Helpers return normalized envelopes, so workflows should throw a child's error when later phases require that child to succeed. Workflow duration, agent count, concurrency, and token usage are unlimited by default. Omit the `limits` input unless the user explicitly requests `maxAgents`, `concurrency`, `timeoutMs`, or `tokenBudget`. The `agentflow-workflows` skill contains the complete authoring contract and a larger copyable template.

Foreground failures report the causal error, run ID, relevant node error, and artifact directory when available. Detailed snapshots remain under `~/.pi/agent/agentflow/<runId>`. Top-level agents record reproducible extension defects—not ordinary child-task failures—in [`ERRORS.md`](ERRORS.md).

`agentflow_look_at` performs objective-focused analysis of a local image or other file. It requires `path` and `objective`, accepts optional `context`, `referenceFiles`, and foreground/background `mode`, and uses an image-capable Luna child with low thinking. The child has an in-memory session, no skills or extensions, and only the read and structured-output tools. Reference files are read and compared systematically; uncertain or unavailable evidence is reported rather than guessed.

### Controlled Claude environment

The Claude child has the fixed coding tools `Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`, and `Skill`. `Agent` and `AskUserQuestion` are unavailable, so it cannot start nested agents or pause for user input. Web tools intentionally permit network access and carry the usual prompt-injection and disclosure risk.

For every run, Agentflow stages exactly the active Pi skill snapshot in a private temporary `.claude/skills` tree and removes it during cleanup. Ambient global and project Claude skills are not loaded. The child receives only the repository root `AGENTS.md` as delimited project context; it does not load project or global `CLAUDE.md`, `.claude/rules`, Claude settings, hooks, plugins, memory, MCP servers, connectors, or persisted sessions.

Isolation is best-effort while preserving the installed Claude/Claude Code account authentication. Agentflow uses no Claude setting source and supplies fixed inline restrictions, but ambient login state and managed organization policy remain outside that boundary. Requested aliases are shown in snapshots; they are not claimed to be the concrete versioned model selected by the installed Claude runtime.

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
Raw agent/workflow requests ────────────────┤
agentflow_claude ───────────────────────────┘
                                             │
                                      shared scheduler
                                             │
                         ┌───────────────────┴───────────────────┐
                         │                                       │
                  SubagentRunner                       ClaudeSubagentRunner
                         │                                       │
              isolated Pi AgentSession                 Claude SDK query()
                         └───────────────────┬───────────────────┘
                                             │
                                       ArtifactStore
```

- `RunEngine` owns run/task lifecycle, process-wide and per-run concurrency, cancellation, result envelopes, and background delivery.
- `SemanticAgentService` compiles strict profile input into trusted prompts, capabilities, resources, persistence, and structured output policy.
- `SubagentRunner` constructs deterministic Pi child resources, captures bounded tool-call snapshots, and returns a `ChildExecutionResult`.
- `ClaudeSubagentRunner` compiles the controlled standalone prompt, stages the active Pi skills, streams Claude SDK previews and tool snapshots, and performs bounded cancellation and cleanup.
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

The installed-configuration RPC smoke is model-free. It verifies auto-discovery from the dotfiles path in default and raw modes, invokes `/reload`, and verifies the extension again afterward:

```sh
npm run smoke:config
```

The remaining RPC smoke tests make real model calls, are opt-in, and use the same auto-discovered installed extension rather than a separate `-e` path:

```sh
npm run smoke
npm run smoke:workflow
```

Set `PI_AGENTFLOW_SMOKE_MODEL` to override the model used by either real-model smoke script.
