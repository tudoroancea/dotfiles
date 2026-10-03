# Pi background processes

This extension provides five public tools: `background_run`, `background_event_stream`, `background_status`, `background_wait`, and `background_stop`.

Its launch semantics are inspired by Claude Code's Background Bash and Monitor tools:

- Use `background_run` when one completion notification is enough.
- Use `background_event_stream` when meaningful stdout lines should produce actionable intermediate event notifications.

Both launch background commands, both may mutate state, and either may be short- or long-lived. Choose between them by completion versus event notifications, not mutability or duration. Event streams deliver complete lines live in bounded batches while retaining raw output in `output.log`; non-persistent streams default to a 300-second timeout, while persistent streams have no timeout.

The management tools inspect, wait for, or stop jobs. After launching `background_run`, agents should normally finish the turn with a brief note that work remains in progress; the completion notification automatically triggers a follow-up turn while leaving the session available for user input. `background_wait` is reserved for cases where same-turn continuation is specifically important and the expected wait is short and bounded. Its timeout does not stop a job.

The extension supports long-lived TUI and RPC hosts. Print and JSON modes reject background tools because those hosts cannot retain jobs. `src/index.ts` owns runtime startup, result delivery, and shutdown cleanup.

## Tool-call rendering

The five tools and the two delivered messages, `background-process-completion` and
`background-monitor-event`, are rendered by `src/ui/`. `tool-renderers.ts` declares one renderer
per tool. `formatters.ts` holds status icons and tones, command and cwd bounds, and
second-granularity durations shared by tool cards and the `/background-tasks` dashboard.

Layout comes from the shared TUI helpers in `agent/extensions/lib/tools/`: `types.ts` defines the
`decode` boundary, `render.ts` provides layout primitives, and `format.ts` provides wording and
sanitization. [TUI rendering reference](../TUI_RENDERING.md) describes Pi's renderer contract.

Renderers live with their owner, so nothing outside this package registers a renderer for a
`background_*` tool. Coverage is split the same way: this package's tests assert its behaviour,
while `tests/tool-goldens.test.ts` renders every tool of every owner through
Pi's real tool-execution shell and stores the result as a golden.
