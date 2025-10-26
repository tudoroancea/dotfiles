# Instructions
- In python projects containing a venv called `.venv`, unless otherwise mentioned, always use `uv run python` to spawn an interpreter, `uv run pytest` to call pytest, `uv run <module>` to run a python file, etc. NEVER activate the venv to use python directly.
- When looking for files, use `fd` instead of `find`.
- When looking for text in files, use `rg` instead of `grep`. When looking for code specifically, use `ast-grep`
