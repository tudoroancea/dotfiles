# Instructions

These guidelines apply to the main agent and all child agents. Follow only the sections relevant to your assigned task and the tools available to you.

## Agency

- Take initiative when the user asks you to perform a task, including necessary follow-up actions, while avoiding surprising actions that exceed the request.
- If the user asks for advice, an explanation, or a plan, answer that request rather than immediately making changes.
- Do not add an extra code-explanation summary unless the user requests one.

## Tool usage

- Prefer specialized tools over shell commands for file operations: use `read` rather than `cat`, `head`, or `tail`, and use `edit` rather than `sed` or `awk`. Reserve `bash` for actual system commands.
- Prefer `fffind` for file and path discovery and `ffgrep` for content search. Use shell `fd` and `rg` only when the specialized tools cannot express the query, and use `ast-grep` when searching code structurally.
- Call independent read-only tools in parallel. Use sequential calls only when one depends on another's result.
- Never use placeholders or guess missing tool parameters.

## Editing files

- Do not create files unless they are necessary to achieve the task. Prefer focused edits to existing files; temporary debugging scripts are acceptable when they simplify verification.
- Make the smallest reasonable diff. Do not rewrite a whole file to change a few lines.
- Do not create extra Markdown files merely to explain completed work unless the user asks for them.

## Doing tasks

- Never propose or make changes to code you have not read. Understand the relevant implementation and surrounding context first.
- Avoid over-engineering. Make only changes directly requested or clearly necessary, and keep each line of code justified.
- Do not add unrelated features, refactors, configurability, validation, fallbacks, or speculative abstractions.
- Validate at system boundaries, but trust internal code and framework guarantees where the invalid state cannot occur.
- Delete unused code rather than adding compatibility shims, renamed placeholder variables, or removal comments.
- Work incrementally: make a focused change, verify it, and then continue.
- If the project has a local `AGENTS.md`, use it to record durable project knowledge, user preferences, or reusable implementation details when appropriate.

## Longer tasks planning 

- When the user asks you to either perform/elaborate/think about/brainstorm/plan a long task or set of tasks, always create a plan in a `PLAN.md` file in the project root (unless the user explicitly asks for a different location or file name). This simplifies both the review process, the iteration on the plan and the usability by implementers.
- In such plans always include the necessary context for the task, files and resources within the current dir or elsewhere that drove the decision making, and a fairly detailed set of _implementation phases_ that can ideally be implemented by one agent at a time.
- When creating the plan, analyze the cross-dependencies between the phases and what can be done in parallel or sequentially.
- Once created, consider this plan file as the place to also track the progress made on the task (which can look as simple as a checkmark next to each completed phase).

## Following conventions

- Understand and follow the existing code style, libraries, naming, architecture, and neighboring implementation patterns.
- Check project manifests before assuming a dependency or framework is available.
- When adding a component, inspect comparable existing components and follow their conventions.
- Follow security best practices and never expose or log secrets or keys.
- Do not add comments unless requested or the code is sufficiently complex that the context is necessary.

## Committing work 
- When committing progress, only commit the changes made in this session and ignore other changes and do not change their staged/unstaged status. 
- Don't hesitate to make temporary draft commits and amend them.
- Do your best to choose an appropriate short commit message and don't bother with prefixes such as `fix(ci)`. 
- If the commits is big enough to warrant explanations, put them in the commit description not title.

## Language-specific guidance

### Python

- In Python projects with a `.venv`, use `uv run python`, `uv run pytest`, and `uv run <module>` rather than activating the environment or invoking its Python directly.
- Prefer uv's project workflow (`uv sync`, `uv add`) over direct virtualenv or pip-style management.
- For standalone scripts, prefer `uv run --script` and use PEP 723 inline dependencies when practical.
- Prefer Ruff for linting and formatting and ty for type checking. Use existing project dependencies when present; otherwise suggest or use globally installed tools as appropriate.
- Prefer Python interpreters managed by uv unless system dependencies require the system interpreter.

### Web development, JavaScript, and TypeScript

- Always prefer using either `bun` or `nub` to manage a project (for package management, script execution, etc.), in particular for new projects we are creating. For existing projects, if they expect another tool (npm, pnpm, etc.), `nub` compatibility layer should be enough to let us use it.
- Between `bun` and `nub`, choose `nub` when `node` compatibility is important.
- Let `nub` manage Node installations when practical.
- For new projects, default to Oxlint and Oxfmt.
