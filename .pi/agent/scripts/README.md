# Pi session maintenance scripts

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
