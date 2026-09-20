# pi-web-ui-client

Host-neutral browser client for the Pi web UI: wire schemas, transcript renderers,
session-state reducers and the stylesheet. `agent/extensions/web-ui` bundles it with
Vite; a future remote daemon is expected to reuse it unchanged.

## Host neutrality is enforced

`src/**` may only import the allowlist in `test/import-boundary.test.js` (preact,
marked, dompurify, typebox, `@tanstack/react-virtual`, highlight.js language
entries). No `node:*`, no `@earendil-works/*`, no Tailscale or daemon code — the
test fails the build otherwise. Anything needing those belongs in the extension.

## Tool-call renderers

`src/client/tools/` holds one module per owning extension, registered by tool name in
`tools/index.tsx`; an unrecognized tool falls back to the generic renderer in
`other.tsx`. `renderers.tsx` keeps only entries, messages and the virtualized
transcript. The TUI renderers in each extension are the parity target — keep the two
aligned when either changes.

The contract is `tools/types.ts`: each tool declares one `decode(raw, result)`, the
single untrusted-to-typed boundary, and after it every component works on typed data.
`defineTool` erases the argument type at the registry edge.

**Why `decode` coerces field by field instead of validating with TypeBox.** Tool
arguments come from the model, so they are routinely incomplete (streaming) or
wrong-typed, and the schemas belong to extensions this package may not import.
`Value.Repair` was measured against these shapes and silently destroys data: with
fff's real `Union([String, Array(String)])`, `exclude: "test/"` repairs to `[]`, and
`pattern: 42` repairs to `"42"` instead of surfacing `[invalid arg]`. Per-field
coercion degrades one argument at a time and keeps that signal. TypeBox is still the
right tool one layer down in `src/wire/`, where a view must be _provably_ bounded
against adversarial payloads — those decoders hand-coerce and then `Check()` the
assembled view.

**Labels are the tools' real names** (`ffgrep`, `look_at`, `background_run`,
`agentflow_wait`). An earlier version relabelled `ffgrep`→"grep", which both hid
which tool ran and left the actual builtin `grep` with no renderer. Bare role names
(`finder`, `oracle`, `delegate`, …) are kept only where they are unambiguous and
match the TUI.

**Collapsed and expanded must agree.** A collapsed count is derived from the same
content the expanded view shows, via `listResult()` in `tools/shared.tsx`, which
strips the bracketed limit notice the listing tools append and the empty-result
sentinels. Counting raw lines double-counts both.

**Only live rows tick.** An elapsed time is decoded against a `now`, so it freezes between
operations. `useLiveNow` in `tools/shared.tsx` re-reads the clock once a second, but only
while the caller reports something still running — and never when the result recorded its own
observation moment (`decodeAgentflowObservedAt`), because a recorded observation is not a
clock. Settled rows must stay deterministic or the fixtures move on their own. The terminal
does the same through `agent/extensions/lib/tools/live.ts`.

**A launching tool owns its run; a control tool observes it.** `agentflow_*` launch
tools render full run cards. `agentflow_status`/`wait`/`cancel` stay compact while
collapsed, then render the full observed run cards when expanded; their recorded
observation time is pinned, so those cards never start a live clock. Background
launch tools carry the command in their header, so their job cards drop it; the
observer tools keep it.

## Authoritative argument keys

Verified against the installed extensions, not guessed. `read`/`write`/`edit`/`ls`
take **`path`** — there is no `file_path`. Launch tools take `mode: "background"`.

| Owner         | Tool                         | Arguments                                                                                              |
| ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| builtins      | `bash`                       | `command`, `timeout?`                                                                                  |
|               | `read`                       | `path`, `offset?`, `limit?`                                                                            |
|               | `write`                      | `path`, `content` (`file_path` accepted only when decoding resumed legacy calls)                       |
|               | `edit`                       | `path`, `edits[{oldText,newText}]` (`file_path` accepted only for resumed legacy calls)                |
|               | `ls`                         | `path?`, `limit?`                                                                                      |
|               | `grep`                       | `pattern`, `path?`, `glob?`, `ignoreCase?`, `literal?`, `context?`, `limit?`                           |
|               | `find`                       | `pattern`, `path?`, `limit?`                                                                           |
| pi-fff        | `ffgrep`                     | `pattern`, `path?`, `exclude?`, `caseSensitive?`, `context?`, `limit?`, `cursor?`                      |
|               | `fffind`                     | `pattern`, `path?`, `exclude?`, `limit?`, `cursor?`                                                    |
| agentflow     | `agentflow_finder`           | `task`, `paths?`                                                                                       |
|               | `agentflow_oracle`           | `question`, `files?`                                                                                   |
|               | `agentflow_librarian`        | `question`                                                                                             |
|               | `agentflow_look_at`          | `path`, `objective`, `context?`, `referenceFiles?`                                                     |
|               | `agentflow_delegate`         | `task`, `ownership[]`, `acceptanceCriteria[]`, `verificationCommands[]`, `continuationSessionFile?`    |
|               | `agentflow_review`           | `task?`, `base?`, `paths?`                                                                             |
|               | `agentflow_claude`           | `task`, `model?`                                                                                       |
|               | `agentflow_agent`            | `prompt`, `label?`, `model?`, `thinking?`, `cwd?`, …                                                   |
|               | `agentflow_workflow`         | `script`, `args?`, `limits?`                                                                           |
|               | `agentflow_status`           | `runId?`                                                                                               |
|               | `agentflow_wait` / `_cancel` | `runIds[]`                                                                                             |
|               | `agentflow_steer`            | `runId`, `nodeId?`, `message`                                                                          |
| background    | `background_run`             | `command`, `description?`, `timeout?`                                                                  |
|               | `background_event_stream`    | `command`, `description`, `timeout?`, `persistent?`                                                    |
|               | `background_status`          | `jobId?`, `tailLines?`                                                                                 |
|               | `background_wait`            | `jobIds[]`, `timeout?`                                                                                 |
|               | `background_stop`            | `jobIds[]`                                                                                             |
| pi-web-access | `web_search`                 | `query?`, `queries?`, `numResults?`, `provider?`, `recencyFilter?`, `domainFilter?`, `includeContent?` |
|               | `fetch_content`              | `url?`, `urls?`, `prompt?`, `timestamp?`, `frames?`, `model?`                                          |
|               | `get_search_content`         | `responseId`, `query?`/`url?`/`*Index?`, `offset?`, `limit?`                                           |
|               | `source_check`               | `claim`, `queries?`, `numResults?`, `provider?`, `recencyFilter?`, `domainFilter?`, `fetchContent?`    |

Result `details`: `edit` → `{diff}`; `read` → `{truncation}`; agentflow →
`{snapshot}` / `{results}` (`wait`) / `{snapshots}` (`cancel`) / `{nodeId}` (`steer`),
where a **workflow snapshot has many `nodes`** and run/node `backend` and `model` stay
separate; background → `SerializedJobs`; pi-web-access → bounded progress, curated-query,
summary, fetch/content-slice, source-check artifact, or structured error diagnostics.
`isPartial` is not a Pi field — the web-ui host adds it for streaming results.

## Tests

`test/renderers.test.js` renders through the real protocol and reducers in jsdom. Its
`TOOL_CASES` table asserts it covers **exactly** the registry, so a new tool without
a fixture fails the suite instead of silently hitting the fallback.
`src/testing/tool-showcase.ts` is the host-neutral timeline the mock server replays
(pure data; the host owns the timers).
