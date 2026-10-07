---
name: cross-review
description: Get one independent review of a change from the other model family, then confirm the fixes with a short check on the fix alone, or collect a design-panel opinion on a decision that is hard to undo. Replaces claude-review. Use only when the user or another skill asks for it by name, never on your own initiative.
---

# Cross-review

Draft for the shared skills directory. Models are chosen by role from the model list in the
global `AGENTS.md`.

## Review a change

1. **Run the checks first.** Lint, formatting, types and tests pass before a reviewer is asked. A
   review round is never spent on them.
2. **Choose the reviewer by risk**, from the family that did not write the change:
   - compiler internals (for Scaly: IR, differentiation, code generation): the strongest reviewer
     at high effort, asked to reproduce each finding with a command or a test
   - other code: a mid-size reviewer at medium effort
   - documentation, tooling, tracker and CI changes: a cheap reviewer at low effort, or CI alone for
     a one-line change
3. **Write the brief:**
   - the issue and its completion criteria, and where the decided design lives
   - the diff to read, `git diff origin/main...HEAD`, or the stack's base instead of main
   - the standards: the project's `AGENTS.md`, its conventions, and its writing guide for prose
     (for Scaly, `.agents/skills/write-docs/`)
   - for a mechanical migration, whether the change serves each caller rather than only
     type-checking
   - "Do not edit files. Do not report lint, formatting or type issues."
   - the output: each finding marked "act on" or "note", with a reproduction or a file and line and
     a reason, then one verdict line, "approve" or "changes needed"
4. **Fix** every "act on" finding, and the notes that are cheap.
5. **Confirm with a delta check, not a new review.** A new reviewer task at low effort receives
   the findings, the responses and `git diff <reviewed commit>..HEAD` only. It answers whether
   each finding is resolved and whether the fix broke anything next to it. It does not look for
   new problems elsewhere.
6. **Stop there.** If the delta check still finds something to act on, fix it and list it as an
   open point on the pull request. Do not start a third round. A change that needs one is too
   large or rests on an unclear decision, and the maintainer should see that.

Large changes cost more rounds. When a change splits into parts that can each be reviewed and
pass CI alone, prefer a stack of smaller pull requests. There is no fixed size limit yet.

## Collect a design panel

For a decision that is hard to undo, send the same brief to one model per family, or two per
family for the hardest decisions. Ask each for a recommendation and its main risks. Sort the
findings into act on, consider, noted and dismissed, and say where the models agree. Keep the
brief and the memos in the project's notes directory, for Scaly
`internal/notes/<topic>_<date>/`, never only in `/tmp`.

## Launch

In T3, read `orchestrator_capabilities` to find the provider instance and model for the role, and
launch with `delegate_task` in async mode. Keep the `taskId`. Use a new `delegate_task` and a new
`clientRequestId` for the delta check, carrying the brief, the findings and the responses. Do not
send it to the earlier child thread.

Outside T3, write the brief to a file in the project's notes directory or the pull request and run
the other provider's CLI with a 30-minute limit:

```bash
claude -p --model <model> --effort <effort> --permission-mode plan --no-session-persistence < brief.md > review.md
codex exec -m <model> -c model_reasoning_effort=<effort> -s read-only -o review.md "$(cat brief.md)"
```

A wait timeout limits the caller's wait and does not cancel the reviewer.

## Record

Post the verdict on the pull request:

```text
Review by <model>, <effort>, at <commit>: approve | changes needed
- act on: <finding>. Resolved in <how>.
- note: <finding>. Left as is because <reason>.
Delta check by <model> at <commit>: resolved | open: <point>
```

A reviewer that failed, timed out or hit a usage limit is reported as missing, never as a pass.
