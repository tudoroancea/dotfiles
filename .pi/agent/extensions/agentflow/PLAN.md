# Minimal Claude Agent SDK integration

## Status

- [x] Reframe the objective around Fable advice and Claude frontend work.
- [x] Reassess Claude SDK isolation, project-context loading, and skill discovery.
- [x] Identify a shared-prompt/import approach for Pi and Claude.
- [x] Phase 1 — Add shared Markdown imports and extract common agent instructions.
- [x] Phase 2 — Add a minimal Claude runner behind Agentflow's existing runtime.
- [x] Phase 3 — Register the single `agentflow_claude` tool and routing guidance.
- [ ] Phase 4 — Verify live behavior, isolation, and lifecycle integration.

## Objective

Keep the existing Pi setup and all current Agentflow semantic tools unchanged. Add one narrowly scoped capability:

```text
agentflow_claude
```

Use it primarily for:

1. Fable as an advisor on unusually difficult architecture, debugging, planning, or design problems.
2. Opus or another suitable Claude model for frontend implementation, visual design, UX, copy, and other taste-sensitive work.

The Claude child should benefit from Agentflow's existing scheduling, status, cancellation, background delivery, snapshots, cost accounting, and shutdown behavior. It should otherwise be a deliberately controlled Claude Code environment, independent of the user's ambient Claude prompts, skills, plugins, hooks, memory, and MCP configuration as far as the SDK permits.

This replaces the broader multi-backend/profile plan. There is no raw Claude backend selector, no migration of existing semantic profiles, and no generic Pi-tool bridge in the first version.

## Proposed tool

### Schema

```ts
agentflow_claude({
  task: string;
  model?: "fable" | "opus" | "sonnet";
  mode?: "foreground" | "background";
})
```

- `task` is a complete, self-contained assignment.
- `model` defaults to `opus`.
- `fable` is used explicitly for the hardest advisory/review work.
- `opus` is the normal frontend/taste-sensitive default.
- `sonnet` is available for cheaper or more routine Claude work.
- Haiku is intentionally unavailable.
- `mode` uses the same foreground/background semantics as other Agentflow tools.
- The child runs in the parent `ctx.cwd`, matching all current semantic tools, including `agentflow_delegate`. Only the opt-in raw `agentflow_agent` currently exposes a custom cwd. A Claude-specific cwd can be added later if semantic tools gain that capability consistently; it is not needed for the prototype.
- No model-facing prompt, tool, permission, settings, skill, plugin, hook, MCP, session, or environment overrides are exposed.

Use aliases rather than hard-coded version IDs so the installed Claude Code runtime resolves the currently available Fable/Opus/Sonnet generation. The live smoke test must verify that `fable` is accepted by the pinned SDK/bundled CLI for the user's account.

### Capability policy

The single child must support both advice and implementation, so its fixed tool set is a normal coding set rather than read-only:

```text
Read, Glob, Grep, Bash, Edit, Write, WebFetch, WebSearch, Skill
```

Not available:

```text
Agent, AskUserQuestion, plugins, hooks, MCP tools, ambient skills,
notebook/browser automation, and nested Agentflow
```

The system prompt must say:

- Do not mutate files unless the task explicitly asks for implementation or edits.
- For advisory/review tasks, remain read-only and return recommendations.
- For implementation tasks, inspect before editing, make focused changes, and verify them.
- Never start subagents or ask the user questions; report unresolved decisions to the parent.

Tool availability is the mechanical boundary. Use `permissionMode: "auto"`, as requested, and never use `bypassPermissions`. Auto-approve the non-mutating local tools (`Read`, `Glob`, `Grep`, and `Skill`) if needed for predictable headless operation; let auto mode evaluate `Bash`, `Edit`, `Write`, `WebFetch`, and `WebSearch`. Verify the pinned SDK's exact `auto` behavior in a headless query. Web tools intentionally add network/prompt-injection and disclosure surface, but that is acceptable for this general coding agent and must be documented.

## Architecture

```text
Pi calls agentflow_claude
          │
          ▼
      RunEngine                     existing scheduler/lifecycle
          │
          ▼
  ClaudeSubagentRunner              Claude Agent SDK query()
          │
          ├── controlled standalone system prompt
          ├── exact active Pi skills staged for Claude
          ├── one manually loaded project-root AGENTS.md
          └── fixed coding tools and isolation settings
```

Do not introduce a general backend abstraction unless implementation proves it necessary. `RunEngine` already accepts an injected `ChildRunner`; the smallest design is:

- Keep the existing Pi `SubagentRunner` unchanged for all existing tools.
- Add a `ClaudeSubagentRunner` implementing the same `ChildRunner.run(...)` contract.
- Let the new tool launch through a small engine entrypoint or a runner selector that recognizes only an internal Claude node marker.
- Keep backend selection out of all model-facing schemas except the dedicated tool itself.

### Minimal generic control change

`RunStore` currently stores concrete Pi `AgentSession` objects to support immediate abort and steering. Claude only requires cancellation in the minimal version; `agentflow_steer` support can wait.

Introduce only the generic control needed by both runtimes:

```ts
interface ChildControl {
  abort(): Promise<void>;
}
```

- Replace `LiveRun.sessions` with controls.
- Pi attaches `{ abort: () => session.abort() }`.
- Claude attaches an interrupt/abort/close wrapper.
- Existing Pi steering may remain in a separate Pi-session map or be represented by an optional `steer` member if that is the smaller coherent refactor.
- `agentflow_steer` should clearly report that Claude runs do not support steering in v1.

This preserves cancellation and shutdown without implementing Ben's long-lived interactive/takeover session machinery.

## Custom system prompt

### Use a controlled standalone replacement

`ctx.getSystemPrompt()` contains Pi tool descriptions, Pi-specific operational guidance, loaded extension instructions, and other material that is wrong for Claude Code. The Claude runner must build its prompt from source Markdown files instead.

The completed [Claude system-prompt audit](./CLAUDE_SYSTEM_PROMPT_AUDIT.md) against Claude Code 2.1.215 found that the preset's general engineering persona is largely compatible with Pi, but its Claude-native planning/todo, memory/CLAUDE.md, subagent, project-context, hook, and interaction assumptions materially conflict with Agentflow's intentionally smaller resource surface. The runtime also has no supported canonical hidden-prompt dump, so appending could not bound future or conditional preset material confidently.

Use full replacement:

```ts
systemPrompt: compiledStandaloneClaudePrompt;
```

Do not use the `claude_code` preset and do not append Agentflow policy to it. The audit contains the fullest obtainable reconstruction, evidence labels, conflict analysis, and the complete controlled replacement prompt template. The implementation must express that standalone prompt as a root Markdown asset with `@` imports of the canonical general instructions and Claude-specific tool, autonomy, resource-boundary, and result fragments. Compile that root asset with the exact resolver built in Phase 1, then pass the resulting string directly to the Agent SDK as `systemPrompt`.

The custom prompt should contain:

1. General agent behavior extracted from `.pi/agent/AGENTS.md`.
2. Claude-specific tool and autonomy guidance.
3. The `agentflow_claude` role guidance above.
4. A compact index of available controlled skills, if the SDK does not already render it adequately.

### Split common and Pi-specific instructions

Create a canonical shared instruction file, for example:

```text
.pi/agent/instructions/general.md
```

Move only general sections from `.pi/agent/AGENTS.md` into it:

- Agency.
- Editing files.
- Doing tasks.
- Longer-task planning.
- General conventions and security.
- Committing work.
- Python guidance.
- Web/JavaScript/TypeScript guidance.
- The Pi-extension lifecycle section can remain Pi-specific unless Claude is expected to edit Pi extensions.

Keep Pi-specific material directly in `AGENTS.md`:

- Pi tool names and tool-selection rules.
- Agentflow feedback behavior.
- Herdr-specific extension lifecycle requirements, unless imported conditionally for Pi-extension tasks.
- Any instructions that assume Pi APIs or extension contexts.

Both Pi and Claude should consume `general.md` from the same source. Do not maintain copied versions that will drift.

## Shared Markdown imports

A small import facility is worthwhile because it solves three related problems:

1. Pi's `AGENTS.md` can include the canonical general instructions.
2. Agentflow's Claude prompt can include the same instructions plus Claude-specific fragments.
3. Agentflow's Claude-specific prompt assets can be composed from small reusable files without copying the shared instructions.

### Syntax

Implement the useful subset of Claude's syntax:

```md
@./relative/file.md
@../shared/guidelines.md
@/absolute/path/to/file.md
```

Rules:

- Resolve relative paths from the importing Markdown file.
- Ignore imports inside inline code and fenced code blocks.
- Allow nested imports to a maximum depth of four, matching Claude.
- Detect cycles and include each canonical file once per root expansion.
- Preserve source-boundary markers in the compiled text for debugging.
- Bound individual and total imported bytes.
- Missing/unreadable imports produce a clear diagnostic; they must not silently disappear.
- Imports can use `..` or absolute paths, as Claude permits, but only trusted/user-level context should be allowed to escape its project root.

Use one tested resolver module for Pi context expansion and Claude system-prompt compilation. Put the resolver in a shared importable location rather than duplicating it inside either extension. It must expose the same path canonicalization, relative-path base, recursion depth, cycle detection, deduplication, source markers, byte limits, and diagnostics to both consumers:

- The Pi `before_agent_start` extension resolves imports from each loaded context file and appends the compiled imported content through Pi's system-prompt hook.
- `ClaudeSubagentRunner` resolves one controlled Claude root prompt asset and passes the fully compiled Markdown string directly to `query({ options: { systemPrompt } })`.

The Claude runner must not ask Pi to render or post-process its prompt, and it must not implement a second resolver. Project context loading stays intentionally simpler in the prototype.

### Pi extension seam

Add a small standalone Pi extension, not Agentflow-specific runtime code, that listens to `before_agent_start`:

1. Inspect `event.systemPromptOptions.contextFiles`, which provides each loaded context file's source path and content.
2. Expand imports for those already trusted/loaded context files.
3. Append only the imported content, with source markers, to `event.systemPrompt`.
4. Do not reread or duplicate ordinary context content.
5. Cache expansions by canonical path plus mtime/size and clear the cache on reload.
6. Do not show UI or emit Herdr blocked state; this is synchronous/autonomous context compilation.

The Pi extension API does not currently expose a clean context-file content transform before Pi builds the system prompt. Appending resolved imported content in `before_agent_start` is the smallest supported approach. Tests should pin the final prompt behavior so a future Pi API can replace it cleanly.

After that extension exists, `.pi/agent/AGENTS.md` can contain an import of `instructions/general.md` and remove the moved duplicate sections.

Phase 1 is a prerequisite for the Claude runner. Do not introduce a temporary copied Claude prompt or defer extraction: Phase 2 must consume the shared instructions through `@` imports and the Phase 1 resolver. The Claude runner must not depend on a fragile string replacement of Pi's rendered prompt.

## Skills: exact Pi set, independent of Claude globals

### Source of truth

The Claude child should receive the same skills Pi loaded for the parent turn, not everything under `~/.claude/skills` and not an independently rediscovered approximation.

Capture the current Pi resource snapshot in Agentflow's `before_agent_start` handler:

```ts
event.systemPromptOptions.skills;
```

Store only plain immutable skill metadata needed by a child:

```ts
{
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}
```

This naturally includes enabled local and package-provided skills and excludes disabled ones. Refresh the snapshot on every parent turn and after reload/session replacement.

### Claude discovery bridge

The Claude SDK cannot register skills from objects or arbitrary `SKILL.md` paths. Its `skills` option only filters skill names that Claude Code has already discovered.

For each Claude run:

1. Create a private temporary staging root.
2. Under it create `.claude/skills/<name>/` symlinks to each captured Pi skill directory. Use the whole skill directory so relative assets such as `LICENSE.txt`, examples, and scripts continue to work.
3. Pass the staging root through SDK `additionalDirectories`.
4. Pass the exact captured names through `skills: [...]`.
5. Include `Skill` in `tools` and `allowedTools`.
6. Set `disableBundledSkills: true`; add the equivalent environment fallback only if the pinned runtime proves the setting is applied too late.
7. Remove the staging root in `finally`, including abort, error, and reload paths.

Claude officially discovers `.claude/skills/` from additional directories even when normal user/project setting sources are disabled. This gives the child the Pi skill set without loading `~/.claude/skills` or project `.claude/skills`.

Validate skill names for path safety and reject duplicate names deterministically. Treat skill instructions as trusted to the same degree as the Pi parent did. Skill filtering is not a filesystem sandbox; the child can still read repository files with `Read`.

## Project context: local AGENTS.md only

Do **not** use any Claude setting source in the prototype. In particular, do not use `settingSources: ["project"]`: that indivisible source loads project CLAUDE.md/rules together with project settings, hooks, and skills.

Treat `CLAUDE.md` as configuration for Claude Code itself, not automatically as instructions for Claude models running in another harness. The first version should load only the project's root `AGENTS.md`:

1. Set `settingSources: []`.
2. Resolve the git root from the child cwd; if there is no git root, use the cwd.
3. Read only `<project-root>/AGENTS.md` when it exists.
4. Add it to the initial user message in a clearly delimited project-context section before the task.
5. Do not walk parent directories, discover nested AGENTS.md files, expand imports in project context, or load CLAUDE.md in v1.
6. Do not load global/user CLAUDE.md, `.claude/rules`, project settings, project/local Claude skills, `.mcp.json`, plugins, or hooks.

This is intentionally smaller than Pi's full context-file discovery and Claude Code's native project memory. If usage shows that nested instructions matter, extend the loader later using Pi's existing context semantics rather than recreating Claude Code discovery.

Project `AGENTS.md` is repository context, not system policy. Keep it in the user message below the controlled system prompt so it cannot enable tools or settings.

## Hermetic Claude runtime policy

### SDK options

Use a fixed options object, verified against the pinned package types:

```ts
{
  cwd,
  model,
  systemPrompt: compiledStandaloneClaudePrompt,
  tools: [
    "Read", "Glob", "Grep", "Bash", "Edit", "Write",
    "WebFetch", "WebSearch", "Skill",
  ],
  allowedTools: ["Read", "Glob", "Grep", "Skill"],
  disallowedTools: ["Agent", "AskUserQuestion"],
  permissionMode: "auto",
  settingSources: [],
  settings: {
    disableAllHooks: true,
    autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
    disableBundledSkills: true,
    disableSkillShellExecution: true,
    enabledPlugins: {},
  },
  hooks: {},
  plugins: [],
  mcpServers: {},
  strictMcpConfig: true,
  additionalDirectories: [privateSkillStagingRoot],
  skills: exactPiSkillNames,
  persistSession: false,
  includePartialMessages: true,
  maxTurns: fixedBound,
  abortController,
}
```

Notes:

- `disableSkillShellExecution: true` disables skill preprocessing shell snippets, not the normal Bash tool used by an implementation task.
- `strictMcpConfig: true` is required because `mcpServers: {}` alone does not exclude every ambient connector.
- `persistSession: false` avoids Claude transcript/memory persistence. Agentflow retains its normal bounded snapshots/artifacts.
- Do not enable Claude's `Agent` tool; nested Claude agents would bypass Agentflow scheduling and accounting.
- Do not expose SDK options through tool arguments.

### Environment controls

Do not duplicate inline settings with environment variables by default. The fixed `settings` object is the source of truth for hooks, memory, connectors, bundled skills, skill shell preprocessing, and plugins.

Set only environment controls that do not have an equivalent selected SDK setting, initially:

```text
CLAUDE_AGENT_SDK_CLIENT_APP=pi-agentflow
CLAUDE_CODE_AUTO_CONNECT_IDE=false
```

If tests against the pinned SDK show that a setting is applied too late during startup, add the corresponding environment variable as a documented compatibility fallback; do not add every duplicate defensively.

The SDK's `env` option replaces the process environment. An allowlisted environment would be most hermetic, but the current user likely authenticates through the installed Claude/Claude Code account. Relocating `CLAUDE_CONFIG_DIR` to an empty directory can also remove the credentials needed to access Fable/Opus.

Therefore use this staged policy:

- **Initial subscription-compatible mode:** preserve the minimum environment/config needed for existing Claude authentication, while using `settingSources: []`, the fixed inline settings, strict MCP, and no plugins/hooks/memory. Do not pass unrelated secret variables if an allowlist can be established from the pinned runtime.
- **Future API-key/setup-token mode:** use an empty private `CLAUDE_CONFIG_DIR` and a strict environment allowlist for stronger isolation.

There is no honest claim of absolute hermeticity while reusing an ambient Claude login. Managed organization policy and some global Claude state are outside `settingSources`. The live isolation test must inspect SDK initialization metadata and observed behavior, and README documentation must state this residual boundary.

## Runner behavior

### One-shot query

Use a normal one-shot SDK `query()` rather than a persistent streaming-input session.

- Initial prompt = delimited project-root `AGENTS.md` context + the task.
- Stream partial text into the existing node preview.
- Translate assistant `tool_use` and user `tool_result` blocks into Agentflow tool-call snapshots.
- On success, return the final result text.
- On SDK error result, throw a bounded error containing the useful subtype/details.
- Ignore unknown future event variants safely.

No structured output, session resume, continuation, fork, or steering is needed for v1.

### Usage and cost

Map terminal SDK fields into the existing `UsageSnapshot`:

- input, output, cache read, and cache creation tokens.
- total according to Agentflow's current convention.
- `total_cost_usd` as cost.

Update interim snapshots when reliable, deduplicating repeated assistant message IDs. The final result aggregate is authoritative.

### Cancellation and cleanup

- Link an SDK `AbortController` to the Agentflow parent signal and run deadline.
- On cancellation call interrupt/abort, then force `query.close()` after a short bound.
- Always detach the child control, close the query, remove listeners/timers, and delete the skill staging directory in `finally`.
- Ignore late SDK events after Agentflow settlement.
- On `/reload`, quit, or session replacement, existing `RunEngine.shutdown()` must terminate the Claude subprocess before clearing status.
- This is autonomous computation; never emit `herdr:blocked`.

## Pi routing guidance

When the tool is implemented, update `.pi/agent/AGENTS.md` with durable guidance equivalent to:

- Use `agentflow_claude` with `model: "fable"` as an independent advisor for exceptionally complex architecture, debugging, planning, or high-stakes review where the existing Pi agents need a stronger second opinion.
- Use `agentflow_claude` with `model: "opus"` for frontend implementation, visual/UI design, UX, user-facing copy, and other taste-sensitive work; ensure the `frontend-design` skill is available and ask the child to use it when relevant.
- Prefer existing Pi/Agentflow tools for routine repository exploration, research, mechanical implementation, and ordinary review.
- Give the Claude child a self-contained task and state clearly whether it should advise only or edit files.
- Do not invoke Claude solely for model diversity when existing tools are sufficient.

Do not add this guidance before the tool is registered; otherwise Pi will be instructed to call a nonexistent capability during partial implementation.

## Implementation phases

### Phase 1 — Shared instructions and imports

**Ownership:** new import resolver and tests, optional standalone Pi context-import extension, `.pi/agent/AGENTS.md`, and shared instruction fragments.

1. Use the finalized standalone replacement from `CLAUDE_SYSTEM_PROMPT_AUDIT.md`; preserve its evidence-backed boundaries while dividing it into canonical general and Claude-specific source fragments.
2. Implement and test one shared bounded Markdown `@path` resolver with a reusable programmatic API.
3. Add the Pi `before_agent_start` import extension as the first resolver consumer.
4. Extract general instructions from `AGENTS.md` into the canonical shared file and import them back into Pi.
5. Add a controlled Claude root prompt asset that imports the same general file plus Claude-specific fragments containing the audit's complete standalone tool and autonomy guidance.
6. Add a resolver-level test that compiles the Claude root asset and asserts key general and Claude-specific instructions occur exactly once; Phase 2 will pass this compiled string directly to the Agent SDK.
7. Verify Pi's final system prompt contains the shared instructions once in TUI, RPC, print, and JSON modes.
8. Audit Herdr interaction; no blocked events should be emitted.

**Acceptance:** Pi behavior remains equivalent, common guidance has one source of truth, imports have cycle/depth/size/error tests, and no project trust boundary is widened.

This phase can be postponed until after the runner if prompt extraction becomes the critical path; a temporary extension-local Claude prompt is acceptable only if tracked for deduplication before completion.

### Phase 2 — Minimal Claude runner

**Ownership:** Claude runner, resource snapshot/staging helpers, package dependency/lockfile, generic cancellation control, and focused tests.

1. Pin/install `@anthropic-ai/claude-agent-sdk` and inspect its actual exported types/changelog.
2. Capture the active Pi skills in `before_agent_start`.
3. Stage exactly those skills under a private additional-directory `.claude/skills` tree.
4. Load only the project-root `AGENTS.md` into the initial user context.
5. Compile the controlled Claude root prompt asset with the Phase 1 resolver and pass that exact string directly as the Agent SDK `systemPrompt`; implement the remaining fixed options/environment policy and one-shot query execution.
6. Normalize streaming previews, tool snapshots, result text, usage, and cost.
7. Implement bounded abort/close and unconditional staging cleanup.
8. Unit-test with an injected fake query factory; normal tests must not require Claude credentials.

**Acceptance:** scripted success, tools, missing skill assets, project context, error results, abort, deadline, hung close, unknown events, usage, and cleanup all pass. Existing Pi runners are unchanged.

### Phase 3 — Tool and guidance

**Ownership:** new tool registration/renderer, Agentflow index, smoke registration checks, README, and `.pi/agent/AGENTS.md` routing guidance.

1. Register only `agentflow_claude` with the strict three-field schema.
2. Route it through RunEngine foreground/background launch and existing status/wait/cancel/delivery behavior.
3. Render backend/model/cost using existing semantic/raw snapshot components with the smallest necessary metadata extension.
4. Add the Pi routing guidance after registration exists.
5. Document exact capabilities, skill behavior, project `AGENTS.md` behavior, deliberate CLAUDE.md exclusion, unsupported steering/session features, auth assumptions, and isolation limits.

**Acceptance:** the parent sees one new tool; existing tool schemas and model routing remain unchanged; foreground/background results use normal Agentflow lifecycle and cost reporting.

### Phase 4 — Live verification

**Ownership:** opt-in live smoke and integrated lifecycle/security review.

1. Add a live smoke gated by `PI_AGENTFLOW_LIVE_CLAUDE=1`.
2. Verify `fable`, `opus`, and `sonnet` aliases against the current account; do not run all three on every normal check.
3. Verify the `frontend-design` Pi skill is discoverable and invokable by Claude.
4. Verify project-root `AGENTS.md` is visible while project/global CLAUDE.md, global/project Claude skills, plugins, hooks, memory, MCP, connectors, and nested agents are not loaded.
5. Verify a foreground advisory task remains read-only when instructed.
6. Verify a frontend implementation can edit and run checks.
7. Verify background delivery, wait consumption, cancellation, deadline, reload, and shutdown leave no stale process/status/staging directory.
8. Review the stable integrated diff.

**Acceptance:** all model-free checks pass; the opt-in live smoke confirms authentication and the controlled resource surface; residual ambient-login limitations are documented rather than hidden.

## Dependency ordering

- Markdown import resolution, project-root `AGENTS.md` loading, and skill staging can be developed independently.
- The Claude runner depends on the Phase 1 shared resolver and compiled prompt assets, skill staging, and project-context loading. It does not depend on Pi's runtime prompt hook, only on the same resolver module.
- Tool registration depends on the runner and RunEngine integration.
- `AGENTS.md` routing guidance must land only after the tool is registered.
- Live verification follows the integrated runner/tool/resource work.

## Verification commands

Run from `.pi/agent/extensions/agentflow` unless testing the standalone context-import extension:

```sh
nub run test
nub run typecheck
nub run lint
nub run format:check
nub run smoke:config
PI_AGENTFLOW_LIVE_CLAUDE=1 nub run smoke:claude
```

Also verify repository-wide status before committing because `.pi/agent/AGENTS.md` may contain unrelated user changes; preserve them exactly and edit only the intended instruction blocks.

## Resolved design choices

- One new tool, not a general backend or profile migration.
- Fable for hardest advice; Opus default for frontend/taste work; Sonnet optional; no Haiku.
- Fixed coding tool set, with prompt-level read-only behavior for advisory tasks.
- Same active Pi skills, staged explicitly; no ambient Claude skills.
- Only project-root `AGENTS.md` is loaded as project context; no CLAUDE.md and no SDK project setting source.
- No plugins, hooks, memory, MCP, connectors, nested agents, or persisted Claude sessions.
- Shared source Markdown for general instructions, supported by bounded `@path` imports.
- Full replacement of the Claude Code preset with the controlled standalone prompt audited in `CLAUDE_SYSTEM_PROMPT_AUDIT.md`; no preset append.
- Best-effort isolation compatible with the existing Claude login, with the remaining global-auth/config boundary documented.
