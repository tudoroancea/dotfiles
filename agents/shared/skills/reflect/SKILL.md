---
name: reflect
description: Review a week of agent sessions and pull request comments for corrections the maintainer had to repeat, and propose a fix for each at the strongest level that works, for the maintainer to approve. Use only when the user or another skill asks for it by name, never on your own initiative.
---

# Reflect

Draft for the shared skills directory. It takes a project and a time window, by default the last
seven days.

## Collect

1. Sessions on every machine the project runs on, copied locally with `rsync` first. Ask the
   user which machines and ssh hosts those are:
   - Claude Code: the `~/.claude/projects/` directories for the main checkout and for each
     `~/.t3/worktrees/<project>/` worktree
   - Codex: `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`, filtered by working directory
2. The maintainer's review comments on pull requests in the window, through `gh api`. They are the
   most direct record of what agents got wrong.
3. Extract with the scripts in this skill's `scripts/` directory, which take the project and the
   window. They are still to be written, generalized from the one-off scripts used for the
   2026-10-04 workflow note. Separate the maintainer's own messages from subagents, reviewers,
   approval sessions and runs started by other agents, which are read as evidence but not
   counted as the maintainer's.

## Analyse

1. Find the corrections: instructions the maintainer repeated, work redone by hand, restarts
   after a stall, "continue" messages, reverted actions, review rounds that found nothing.
2. Group them into classes. Keep a class seen at least twice, or once if it lost work or touched
   a remote.
3. Propose a fix for each class at the strongest level that works, in this order: a code change
   that makes the mistake impossible, a type, a lint whose message names the fix, a test, a
   script, a skill edit, and a line in `AGENTS.md` last. A proposed check is proved by
   reintroducing the mistake and seeing it fail.
4. Also propose removals: skill steps nobody needed, checks that never fire, a model that
   underperformed in its role, rounds or spawns that cost quota without changing an outcome.

## Propose

Post one table for the maintainer: class, evidence (session or pull request, date, a short
paraphrase), the proposed fix and its level, and the cost. Paraphrase rather than quote, and keep
session content out of public files. Wait for approval of each row.

## Apply

Apply each approved fix separately. A code or check change goes through `implement-issue`. A skill
edit or a change to the model list is made directly once approved. Keep the table pairing each rule
with what enforces it current in the project's `AGENTS.md`.

To run it weekly, create a T3 scheduled task bound to the maintainer's planning thread, with a
fixed weekday time.
