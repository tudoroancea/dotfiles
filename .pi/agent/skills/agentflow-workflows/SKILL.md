---
name: agentflow-workflows
description: Author and debug agentflow_workflow JavaScript scripts. Use when composing raw multi-agent workflows, choosing Agentflow helpers, handling child envelopes, sequencing phases, or diagnosing workflow validation and runtime failures.
---

# Agentflow workflows

Use `agentflow_workflow` only when orchestration logic is genuinely useful. Prefer direct semantic tools for one child or a simple set of independent calls.

## Copyable template

```js
export const meta = {
  name: "inspect_then_implement",
  description: "Inspect independent areas, implement the agreed change, then review it.",
  phases: [{ title: "Inspect" }, { title: "Implement" }, { title: "Review" }],
};

phase("Inspect");
const inspections = await parallel([
  () => finder({ task: "Map the relevant implementation and tests." }),
  () => oracle({ question: "Recommend the smallest safe design." }),
]);
for (const result of inspections) {
  if (!result.ok) throw new Error(result.error ?? "Inspection failed");
}

phase("Implement");
const implementation = await delegate({
  task: "Implement the scoped change.",
  ownership: ["src/", "test/"],
  acceptanceCriteria: ["Requested behavior is implemented", "Regression tests cover it"],
  verificationCommands: ["npm test"],
});
if (!implementation.ok) throw new Error(implementation.error ?? "Implementation failed");

phase("Review");
const reviewed = await review({ task: "Review the integrated diff." });
if (!reviewed.ok) throw new Error(reviewed.error ?? "Review failed");

return { inspections, implementation, reviewed };
```

Pass the script as `script`. Usually set only `mode`; **omit `limits` by default**. Add `maxAgents`, `concurrency`, `timeoutMs`, or `tokenBudget` only when the user explicitly requests that cap.

## Required syntax

- The script must contain one static top-level `export const meta = {...}` declaration.
- `meta.name` must match `^[a-z][a-z0-9_]*$`.
- `meta.description` must be non-empty.
- `meta.phases`, when present, is a static array of `{ title: "..." }` objects.
- Call helpers as bare functions: `delegate({...})`, not `agent.delegate({...})`.
- Imports, dynamic imports, `require`, `eval`, generated functions, globals, `Date.now()`, `new Date()`, and `Math.random()` are forbidden.
- Top-level `await` and `return` are supported.

## Available helpers

Every child helper returns a normalized envelope with `ok`, `output`, optional `structured`, optional `error`, `aborted`, and `usage`.

```js
agent(prompt, options?)
finder({ task, paths? })
oracle({ question, files? })
librarian({ question })
look_at({ path, objective, context?, referenceFiles? })
delegate({ task, ownership, acceptanceCriteria, verificationCommands, continuationSessionFile? })
review({ task?, base?, paths? })
```

Workflow utilities:

```js
parallel([() => childCall(), () => childCall()])
pipeline(items, async (value, original, index) => nextValue)
phase("Declared phase title")
log("bounded diagnostic message")
args
cwd
budget
```

`parallel` expects thunks, not already-started promises. Use it for concurrent workflow children; workflow helpers are always awaited by the workflow and do not support direct-tool background `mode`. `pipeline` runs each item through all stages. Phase titles must match declared metadata when phases are declared.

## Failure handling

Check `result.ok` whenever later work depends on a child. Throw `result.error` to stop the workflow with the causal error. Do not silently synthesize after a prerequisite failed.

On failure, read the foreground tool error first. It includes the run ID and artifact directory when available. Then inspect:

```text
~/.pi/agent/agentflow/<runId>/run.json
~/.pi/agent/agentflow/<runId>/result.json
~/.pi/agent/agentflow/<runId>/transcripts.json
```

If Agentflow itself behaves unexpectedly rather than a child simply failing its assigned task, follow the repository instruction to append a reproducible entry to `~/.pi/agent/extensions/agentflow/ERRORS.md`.
