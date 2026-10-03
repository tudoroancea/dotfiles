---
name: claude-review
description: Get an independent code review from Fable or Opus through the `claude` CLI in print mode.
---

Run a separate Claude session as a reviewer with `claude -p`.
Unless otherwise requested by the user, prefer using Claude Fable with high thinking effort with the flags `--model fable --effort high`.
If asked to set a timeout always choose at least 30' as Claude can be pretty slow.
Give the reviewer the relevant context of the task that you want it to review, but still ask for an adversarial review that produces actionable findings/verdicts.
