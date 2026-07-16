# Pi background processes

This extension provides five public tools: `background_run`, `background_event_stream`, `background_status`, `background_wait`, and `background_stop`.

Its launch semantics are inspired by Claude Code's Background Bash and Monitor tools:

- Use `background_run` when one completion notification is enough.
- Use `background_event_stream` when meaningful stdout lines should produce actionable intermediate event notifications.

Both launch background commands, both may mutate state, and either may be short- or long-lived. Choose between them by completion versus event notifications—not mutability or duration. Event streams deliver complete lines live in bounded batches while retaining raw output in `output.log`; non-persistent streams default to a 300-second timeout, while persistent streams have no timeout.

The management tools inspect, wait for, or stop jobs. Waiting is only necessary when subsequent work depends on completion; its timeout does not stop a job.
