# Instructions
- When looking for files, use `fd` instead of `find`.
- When looking for text in files, use `rg` instead of `grep`. When looking for code specifically, use `ast-grep`
- In python projects containing a venv called `.venv`, unless otherwise mentioned, always use `uv run python` to spawn an interpreter, `uv run pytest` to call pytest, `uv run <module>` to run a python file, etc. NEVER activate the venv to use python directly.
- When asked to perform a task, DO NOT start writing a plethora of markdown files to explain everything you did. You will be asked to if you need to.
- If there is one, use the local `AGENTS.md` file to store your knowledge about the project, user preferences, important implementation details that might be reused later like how to fix certain bugs, etc.
