# Pi setup scripts

## `check:extensions` (root npm script)

Checks installed Pi extensions for newer versions. Run `nub run check:extensions` from the repository root:

- `npm outdated --prefix agent/npm` lists newer versions of the npm-installed extensions (the direct pins live in `agent/settings.json` under `packages`).
- `git fetch origin` + `git log HEAD..origin/HEAD` in the cloned `pi-context-usage` repo shows upstream commits past the pinned SHA.

Extension versions are pinned exactly in `agent/settings.json`, so `pi update --extensions` never moves them; this script is the manual check loop. The git part requires the clone to exist (Pi reconciles it from settings on first start).

## `sync-agent-instructions.mjs`

Projects the canonical [`../instructions/general.md`](../instructions/general.md) into the marked generated section of [`../AGENTS.md`](../AGENTS.md). Run `nub run sync:instructions` from the repository root after changing the canonical instructions. `nub run check` invokes its `--check` mode and fails when the generated projection has drifted.

## `tui-showcase.ts` (`showcase:tui` root npm script)

Opens the tool-renderer showcase in the terminal. Run `nub run showcase:tui` from the repository
root; press `ctrl+o` to expand every tool row.

It flattens the same scripted transcript the browser's mock server serves
(`toolShowcaseScenario()` in `packages/pi-web-ui-client/src/testing/tool-showcase.ts`) into a Pi
session file and opens a disposable copy with `pi --session`. One fixture feeds both surfaces, so
adding a tool to the showcase updates the browser mock and this terminal review at once, and the
two can be put side by side to make drift visible.

`--out <path>` writes the session file and prints its path instead of opening it.

A session file holds settled entries only, so the pending and streaming-partial rows are dropped
here and `agent/extension-tests/test/tool-goldens.test.ts` covers those states instead. Images do
survive: the scenario's image references are resolved to the bytes it ships, so a kitty or iTerm2
terminal renders them inline — the one thing only this layer shows.

The terminal needs three things the browser's host supplies by other means, which the generator
fills in: `usage` on every assistant message, because Pi's footer sums them unconditionally and
crashes on the first one without; `details.observedAt` on a run snapshot, or an unsettled run
measures its elapsed time against the real clock and reports thousands of hours; and no
`compaction` entry, because it hides every entry before it and the scenario appends one four fifths
of the way through. It also passes `--agentflow-raw`, since `agentflow_agent` is registered only
behind that flag. Expect one startup warning about the fabricated session's model — naming a local
one instead would only move the problem.

`agent/extension-tests/test/showcase-session.test.ts` asserts the parts of this that a crash would
otherwise find first: the chain, the footer's sum, and that every delivered-message renderer can
draw the payload the scenario carries.

## `recalculate-pave-costs.ts`

Recalculates the persisted `usage.cost` fields of recognized `pave` assistant turns in Pi JSONL session files.

The script imports the `pave` model prices and request-wide pricing tiers directly from [`../models.json`](../models.json). It deliberately uses the current configuration rather than embedding a historical price table. This is appropriate for the existing `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` correction; do not use it to reprice a model after that model's actual billing price has changed over time.

Pi selects a request-wide tier using `usage.input + usage.cacheRead + usage.cacheWrite`. The highest tier whose `inputTokensAbove` threshold is strictly exceeded applies to all input, output, cache-read, and cache-write tokens in that turn.

### Requirements

Node.js 22.18 or newer, which runs erasable TypeScript directly without a third-party runtime. JSON imports are also native to Node, so Nub or Bun is not required.

### Usage

```sh
# Preview one session
~/.pi/agent/scripts/recalculate-pave-costs.ts --dry-run /path/to/session.jsonl

# Update one session
~/.pi/agent/scripts/recalculate-pave-costs.ts /path/to/session.jsonl

# Preview or update *.jsonl files in a directory, up to depth 2
~/.pi/agent/scripts/recalculate-pave-costs.ts --dry-run /path/to/sessions
~/.pi/agent/scripts/recalculate-pave-costs.ts /path/to/sessions
```

For a directory input, files directly inside it are depth 1 and files in its immediate child directories are depth 2. Deeper descendants are not visited, and symbolic-link directories are not followed. Dry runs print the absolute path of every file that would be modified.

A file is eligible only when its first non-empty JSONL record is a valid Pi session header containing `type: "session"`, a non-empty `id`, a valid `timestamp`, and a non-empty `cwd`. Only `type: "message"` records can be updated. Malformed JSONL files, non-Pi JSONL files, and Pi-like files with invalid matching usage records are counted and skipped without preventing valid sessions from being updated.

Unknown providers and models are left unchanged. Changed files are replaced atomically, but the script does not create backups; make a backup of valuable session data before a bulk update.
