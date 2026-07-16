# PLAN: `pi-agentflow`

## Purpose

Build a personal Pi extension that combines:

1. a reliable generic runtime for isolated child agents and dynamic workflows;
2. a small default set of opinionated semantic subagent tools for everyday development;
3. one shared lifecycle, observation, control, trust, and persistence layer;
4. an advanced raw interface that is available only when explicitly enabled.

The normal development model is a **restrained manager with agents as tools**:

- the main Pi agent owns the conversation, decisions, integration, edits, and final answer;
- read-only exploration and advice can be delegated freely when useful;
- mutation is delegated only across stable, independent boundaries;
- review targets the integrated state;
- dynamic workflows remain an escalation mechanism rather than the default way to solve ordinary coding tasks.

The extension should remain generic internally while presenting a semantic and constrained interface by default.

## Prior art and architectural direction

The generic runtime was informed by [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup), particularly its background lifecycle, workflow sandbox, result delivery, persistence, trust handling, and normalized observation model.

The semantic layer is informed by Igor Bedesqui's [`bdsqqq/dots`](https://github.com/bdsqqq/dots) setup at commit `bea91960811542211e70bb11bbf4c4fba92ba0b9`. Igor first built a generic dispatcher and later replaced its normal interface with dedicated tools such as finder, oracle, librarian, delegate, and code review. We adopt that routing simplicity without replacing our shared `AgentSession` runtime or copying his subprocess, packaging, XML, and duplicated wrapper implementation.

The central rule is:

> Use agents to multiply independent work, not to simulate an organization chart.

## Current status (audited 2026-07-16)

The Phase 1–5 implementation is present, but this plan remains active until its verification and package-isolation requirements are complete:

- `nub run typecheck` currently follows `test/session-cost.test.ts` into `../boxed-editor.ts`, so the standalone package typecheck fails instead of remaining independent of neighboring live dotfiles sources;
- semantic workflow coverage does not yet exercise every helper and artifact/provenance boundary end to end;
- live foreground update rendering, hard deadline/disposal behavior, and installed-configuration `/reload`/RPC behavior still need the explicit verification called for below.

Do not remove this plan based only on the implemented source surface; remove it after these remaining checks are implemented and the full package verification suite passes.

## Current baseline

The repository already implements the generic vertical runtime needed by the next phases:

- isolated Pi `AgentSession` children;
- per-invocation model, thinking, tool, skill, extension, cwd, session, prompt, trust, timeout, and structured-output configuration;
- dynamic run/task scheduling;
- foreground and background agents;
- status, wait, cancel, and steer operations;
- automatic background result delivery;
- a permission-restricted out-of-process workflow sandbox;
- workflow phases, logs, parallelism, pipelines, and dynamic fan-out;
- run snapshots, events, bounded previews, artifacts, passive status, and an interactive dashboard;
- recursive orchestration denial, child extension binding, bounded shutdown, and basic error detection;
- unit tests and opt-in RPC smoke scripts.

These are the platform, not the remaining roadmap. The work below focuses on cleaning its public seams, adding semantic profiles, improving inline observation, composing profiles in workflows, and integrating the extension into the dotfiles repository.

## Public tool surface

### Default tools

The normal model-facing tools should be:

- `agentflow_finder` — local conceptual search and context compression;
- `agentflow_oracle` — high-reasoning technical advice;
- `agentflow_librarian` — remote documentation and repository research;
- `agentflow_delegate` — bounded mutation-capable implementation;
- `agentflow_review` — structured review of a stable integrated diff;
- `agentflow_status`;
- `agentflow_wait`;
- `agentflow_cancel`;
- `agentflow_steer`.

Semantic profiles do not impose token budgets. Usage is measured and displayed, while timeouts, concurrency, child-count limits, result-size bounds, and model context limits remain operational safeguards.

### Raw tools

Register the low-level tools only when Pi starts with:

```text
--agentflow-raw
```

The gated tools are:

- `agentflow_agent`;
- `agentflow_workflow`.

Management tools remain registered because they also manage semantic runs. RPC smoke scripts and advanced development sessions must pass the flag.

## Runtime architecture

```text
Dedicated Pi tool ──────────┐
                            ├── SemanticAgentService ── trusted profile/policy
Workflow semantic helper ───┘                 │
                                              ▼
Raw agent tool/workflow agent() ──────── RunEngine
                                              │
                                      shared scheduler
                                              │
                                       SubagentRunner
                                              │
                                  isolated Pi AgentSession
```

### Runtime/profile boundary

The generic runtime owns:

- run/task IDs and lifecycle;
- scheduling and global/per-run concurrency;
- cancellation, steering, timeouts, and shutdown;
- normalized results and usage;
- event and snapshot publication;
- background delivery and retention;
- persistence and UI read models;
- child session/resource construction.

Semantic profiles own:

- purpose and routing contract;
- strict input schema;
- role prompt;
- capabilities and mutation policy;
- default model and thinking level;
- context, skill, extension, and persistence policy;
- structured result schema;
- stopping and output expectations.

Inline workflow source must not be able to select or override trusted internal capability policies through raw configuration.

## Semantic profiles

### Finder

Purpose: fast local conceptual exploration that returns a compressed map of relevant code.

Policy:

- read-only local file and code-search capabilities;
- no arbitrary shell or orchestration;
- ephemeral session;
- fast configurable model and low/medium reasoning;
- concise findings with paths and line ranges;
- no token budget.

Preferred result fields:

- summary;
- findings with path, range, and relevance;
- unresolved questions.

### Oracle

Purpose: an advisory second opinion for architecture, difficult debugging, planning, and disputed decisions.

Policy:

- read-only repository inspection;
- high-reasoning configurable model;
- one primary recommendation;
- explicit assumptions, risks, and conditions for revisiting it;
- no authority over the main agent's final decision;
- no token budget.

Files are provided as paths for selective reading rather than embedded wholesale into the prompt.

### Librarian

Purpose: remote documentation, GitHub, and cross-repository research.

Policy:

- web/GitHub research capabilities and citations;
- no local mutation;
- ephemeral session;
- fail early if required research capabilities are unavailable;
- no token budget.

### Delegate

Purpose: execute a stable, independent, bounded implementation task.

Policy:

- mutation-capable tools and selected skills;
- parent/default model unless configured in the profile;
- explicit ownership, acceptance criteria, and verification commands;
- persistent file session when continuation is requested;
- one writer by default;
- parallel delegates only with non-overlapping ownership or later worktree isolation;
- no token budget.

### Review

Purpose: inspect a stable integrated diff and return actionable findings.

Policy:

- read-only repository and git inspection;
- high reasoning;
- structured JSON through the existing `structured_output` mechanism;
- findings include severity, path/location, explanation, and suggested remediation;
- no mutation and no token budget.

## Child resources and prompts

### Prompt composition

Semantic children use Pi's normal generated system prompt so their exact available tools, tool descriptions, registered guidelines, documentation guidance, skills, and context files are represented normally. Do not replace or parse the generated prompt and do not use `before_agent_start` surgery.

Use:

- Pi's normal base system prompt;
- one small editable role-contract asset per semantic profile, added through `DefaultResourceLoader.appendSystemPromptOverride`;
- only the trusted profile role, capability/mutation contract, no-delegation rule, stopping condition, and output expectations in that appended content;
- no ambient `APPEND_SYSTEM.md` content in semantic children unless a profile explicitly opts into it;
- dynamic task details in the user message, never interpolated into system content;
- a `Task:` prefix and `expandPromptTemplates: false`.

Pi's resulting order is the normal identity/tool section, flat tool guidelines, Pi documentation guidance, the semantic role contract, native `AGENTS.md` context, skills, date, and cwd. The role contract and context files remain parts of the same system message; exact string placement beyond the supported append hook is not an instruction boundary and must not be coupled to Pi's prompt formatting.

### `AGENTS.md`

Use Pi-native `AGENTS.md`/`CLAUDE.md` discovery; do not create a custom walker.

The global `AGENTS.md` should contain shared agency, editing, task-execution, convention, and language guidance. Begin it with a concise note that the guidelines apply to all agents and that each agent should follow only sections relevant to its assigned task and available tools. Do not duplicate this content in a global system-prompt extension.

Main-agent routing guidance for semantic tools does **not** belong in `AGENTS.md`. Register it as contextual `promptGuidelines` on each semantic tool so it appears only while that tool is active. Because Pi flattens guidelines into an unordered list, every guideline must name its tool explicitly, for example `Only use agentflow_delegate for ...` or `Use agentflow_finder when ...`.

Each profile must explicitly choose its context policy:

- finder: selected project context needed to understand repository conventions;
- oracle: selected project context;
- librarian: no local context by default;
- delegate: normal trusted project context;
- review: trusted project context relevant to correctness and conventions.

Because child profiles may see parent-oriented routing guidance, their role prompt must state that they should complete only the assigned specialist task and must not delegate.

### Skills

Skills remain progressive-disclosure resources. Profile defaults:

- finder: none;
- oracle: none unless explicitly selected by trusted configuration;
- librarian: optional research/citation skill;
- delegate: selected global/project skills;
- review: optional review skill.

The child tool allowlist, not skill metadata, is the capability boundary.

### Extensions and tools

Do not load every ambient extension into every semantic child. Resolve semantic capabilities to an explicit child tool/extension surface.

Read-only profiles must not receive unrestricted `bash`. If Pi's built-ins cannot provide the required safe search surface, implement internal bounded tools over `fd`, `rg`, `ast-grep`, file reads, and read-only git operations.

Recursive orchestration denial must be future-proof: deny every `agentflow_*` tool and user-interaction tool in children, rather than maintaining only a fixed list of current tool names.

Same-cwd children inherit the parent's resolved project trust. Alternate cwd values load project resources only when explicitly trusted. Trust controls resource loading; it is not a filesystem sandbox.

## Normalized results

Remove the accidental split between the unused `AgentTaskResult` target type and the currently returned `SubagentResult`.

Use a low-level successful execution value internally and one normalized scheduler envelope externally:

```ts
interface ChildExecutionResult {
  text: string;
  structured?: unknown;
  sessionFile?: string;
  usage: UsageSnapshot;
}

interface AgentTaskResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
  aborted: boolean;
  sessionFile?: string;
  usage: UsageSnapshot;
}
```

Semantic tools and workflow helpers consume the same task envelope. Snapshots and artifacts record `originTool` and `semanticRole`.

## Workflow composition

When raw workflows are enabled, their sandbox API should support both raw and semantic children:

```text
agent()
finder()
oracle()
librarian()
delegate()
review()
parallel()
pipeline()
phase()
log()
args
cwd
budget
```

Direct semantic tools and workflow semantic helpers call the same internal `SemanticAgentService`; workflows do not recursively invoke registered Pi tools.

Semantic workflow helpers expose only semantic inputs. They cannot override system prompts, models, tools, extensions, or trusted capability policy. All helpers return explicit serializable success/failure envelopes.

`delegate()` is allowed in workflows because the workflow tool itself is gated by `--agentflow-raw`, but ownership and mutation rules still apply. Read-only fan-out remains the preferred workflow shape.

## UI and observation strategy

### Inline rendering is primary for foreground semantic agents

Foreground semantic calls should render like ordinary Pi tools, with a compact live list of the child tool calls. This is more legible than forcing the user to inspect a separate status widget for a single synchronous specialist.

Example:

```text
◆ finder  Locate authentication state transitions
  ✓ rg        "refreshToken" src/
  ✓ read      src/auth/session.ts:80-180
  ◆ ast-grep  token refresh callers

✓ finder  3 findings · 3 tools · 8.2k tokens
```

Requirements:

- one stable line per child tool call;
- lines appear in assistant source/start order and update in place by tool-call ID;
- show a compact tool-specific argument summary, not raw JSON;
- show running, completed, and failed state;
- cap collapsed output to a recent/relevant tail;
- expanded rendering can show bounded arguments, errors, result preview, usage, and session/artifact path;
- semantic tool renderers share one implementation with small role-specific headers and result summaries;
- do not stream the child's full prose into the inline tool-call list.

The task snapshot therefore needs bounded `ToolCallSnapshot` records rather than only a numeric tool count.

### Background and workflow UI

The existing UI remains useful but changes role:

- the footer/status line is for active background runs and multi-task workflows, not the primary foreground semantic display;
- background semantic launch renders an immediate compact run ID/status result;
- automatic delivery renders the final semantic summary inline when the parent is idle;
- workflows render task/phase progress inline rather than every nested tool call by default;
- `/agentflow` remains the drill-down UI for recent runs, detailed task/tool inspection, steering, cancellation, results, and artifact paths;
- RPC uses the same serializable snapshots and does not depend on TUI components.

This avoids duplicate noisy presentation while retaining observation for long-running and background work.

## Remaining implementation roadmap

### Phase 1 — runtime cleanup and semantic foundation

Deliverables:

- normalized `ChildExecutionResult` and `AgentTaskResult` boundaries;
- private `RunStore` access behind explicit engine methods;
- injected runner interfaces for focused tests;
- trusted internal capability policy and resolver;
- future-proof recursive tool denial;
- semantic role/origin fields in snapshots, events, UI, and artifacts;
- engine-wide concurrency layered with per-run concurrency;
- hard child deadline race and bounded disposal;
- parent-idle-aware exact-once background delivery;
- `--agentflow-raw` registration gate;
- current-architecture `README.md` and updated package metadata.

Acceptance:

- workflows and direct launches use one normalized task result;
- untrusted workflow options cannot select privileged semantic policy;
- all current and future `agentflow_*` tools are unavailable to children;
- concurrent runs obey a shared process-level cap;
- semantic runs are identifiable everywhere;
- normal Pi sessions do not expose raw launch tools.

### Phase 2 — inline UI and read-only semantic agents

Deliverables:

- bounded tool-call snapshots captured from child session events;
- shared compact semantic renderer;
- foreground/background-aware footer behavior;
- finder profile, prompt, schema, and tool;
- oracle profile, prompt, schema, and tool;
- review profile, prompt, structured schema, and tool;
- profile and capability-confinement tests.

Acceptance:

- foreground semantic calls show a live compact tool-call list inline;
- finder and review cannot mutate the workspace mechanically;
- oracle returns one structured advisory recommendation;
- review returns validated JSON findings;
- collapsed rendering remains readable at narrow terminal widths.

### Phase 3 — librarian and delegate

Deliverables:

- librarian research capability resolution and citations;
- delegate mutation policy, ownership, acceptance, and verification inputs;
- exact-ID child session continuation;
- clear missing-capability failures;
- optional gated real-model evaluations.

Acceptance:

- librarian can research remote sources without local mutation;
- delegate receives complete boundaries and can persist/continue a session;
- parallel delegate usage is rejected or warned when declared ownership overlaps;
- neither profile imposes a token budget.

### Phase 4 — semantic workflow integration

Deliverables:

- semantic helper IPC requests and validation;
- `finder`, `oracle`, `librarian`, `delegate`, and `review` sandbox APIs;
- shared `SemanticAgentService` used by direct tools and workflows;
- semantic results and provenance in workflow artifacts;
- workflow task/phase inline rendering tuned separately from foreground semantic rendering.

Acceptance:

- workflows compose raw and semantic agents through one scheduler;
- semantic helpers cannot override trusted policy;
- loops, branches, pipelines, and parallel fan-out retain cancellation and limits;
- mutation policy remains enforced inside workflows.

### Phase 5 — dotfiles integration (complete)

Deliverables:

- move the self-contained TypeScript package into the dotfiles repository;
- symlink it into `~/.pi/agent/extensions/agentflow`;
- retain one package, lockfile, tests, scripts, and prompt assets without introducing a workspace or bundler;
- update global `AGENTS.md` with the shared all-agent guidance and relevance preface, while keeping semantic routing in tool registration guidelines;
- use the installed `pi-fff` extension's explicit `ffgrep` and `fffind` tools in parent and search-capable child agents, leaving Pi's built-in `grep` and `find` inactive;
- reconcile existing system-prompt, statusline, tool, and extension policies;
- document install, reload, raw-mode, test, and smoke commands;
- adapt tests and paths so they are independent of the live dotfiles resources.

Acceptance:

- the extension loads from the dotfiles checkout and supports `/reload`;
- default and `--agentflow-raw` tool surfaces are correct;
- child resource/tool policies remain deterministic despite other installed extensions;
- unit tests run from the dotfiles repository;
- opt-in RPC/model smoke tests use the same installed configuration.

### Future optional work

Only after the hybrid v1 is reliable:

- git worktree isolation for parallel delegates;
- deterministic packaged workflow templates;
- backend adapters for Claude Code or Codex;
- cross-session artifact discovery beyond current bounded persistence.

Do not add recursive agent societies, unconstrained cross-agent messaging, workflow resume, scheduling, or multiple duplicated runtimes merely to support these possibilities.

## Testing strategy

Focus tests on behavior and policy boundaries rather than proving that thin wrappers passed obvious arguments to the runtime.

Unit coverage should include:

- run/task state and settlement races;
- normalized result envelopes;
- global and per-run concurrency;
- cancellation, hard timeout, and guaranteed disposal;
- exact-once background delivery;
- semantic profile compilation and strict input validation;
- trusted/untrusted context and resource policy;
- exact child tool allowlists and recursive denial;
- command-like task text with prompt expansion disabled;
- read-only confinement for finder/oracle/review/librarian;
- structured-output validation;
- tool-call snapshot bounds and ordering;
- inline renderer behavior at narrow widths and in collapsed/expanded states;
- workflow semantic IPC and policy rejection;
- artifact persistence and recovery.

Use in-memory settings/sessions and temporary project trees so tests do not depend on the developer's live dotfiles. Real-model evaluations remain opt-in behind `PI_E2E` or explicit smoke scripts.

## Hybrid v1 definition of done

- Semantic finder, oracle, librarian, delegate, and review tools are the default launch interface.
- Raw agent and workflow tools appear only with `--agentflow-raw`.
- The main agent remains the normal owner and integrator.
- Foreground semantic calls render compact child tool activity inline.
- Background and workflow runs remain observable through status, delivery, and `/agentflow`.
- Semantic profiles have enforced capability, prompt, resource, persistence, and structured-result policies without token budgets.
- Raw and semantic children share one scheduler, child runner, lifecycle, and result envelope.
- Workflows can compose raw and semantic children without bypassing semantic policy.
- Trust-aware resources, cancellation, timeouts, global concurrency, retention, and artifact bounds are reliable.
- The package lives in the dotfiles repository with clear architecture and maintenance documentation.
