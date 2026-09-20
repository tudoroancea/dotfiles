# Pi background processes

This extension provides five public tools: `background_run`, `background_event_stream`, `background_status`, `background_wait`, and `background_stop`.

Its launch semantics are inspired by Claude Code's Background Bash and Monitor tools:

- Use `background_run` when one completion notification is enough.
- Use `background_event_stream` when meaningful stdout lines should produce actionable intermediate event notifications.

Both launch background commands, both may mutate state, and either may be short- or long-lived. Choose between them by completion versus event notifications—not mutability or duration. Event streams deliver complete lines live in bounded batches while retaining raw output in `output.log`; non-persistent streams default to a 300-second timeout, while persistent streams have no timeout.

The management tools inspect, wait for, or stop jobs. After launching `background_run`, agents should normally finish the turn with a brief note that work remains in progress; the completion notification automatically triggers a follow-up turn while leaving the session available for user input. `background_wait` is reserved for cases where same-turn continuation is specifically important and the expected wait is short and bounded. Its timeout does not stop a job.

## Tool-call rendering

The five tools and the two delivered messages (`background-completion`,
`background-monitor-event`) are rendered by `src/ui/`, which owns them: `tool-renderers.ts`
declares one renderer per tool, and `formatters.ts` holds the job vocabulary — status icons and
tones, command and cwd bounding, second-granularity durations — so a job reads the same in a tool
card and in the `/background-tasks` dashboard.

Layout comes from the shared TUI vocabulary in `agent/extensions/lib/tools/` (`types.ts` for the
`decode` boundary, `render.ts` for the primitives, `format.ts` for the wording), which mirrors the
browser client's `packages/pi-web-ui-client/src/client/tools/background.tsx` module for module — a
change to one side belongs on the other.

Renderers live with their owner, so nothing outside this package registers a renderer for a
`background_*` tool. Coverage is split the same way: this package's tests assert its behaviour,
while `agent/extension-tests/test/tool-goldens.test.ts` renders every tool of every owner through
Pi's real tool-execution shell and stores the result as a golden.
