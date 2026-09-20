---
name: copyable-regions
description: Format responses containing prompts, commands, configuration, or other exact text that a user may need to copy independently.
---

# Copyable regions

Use copyable regions when a response contains an exact payload that is useful independently from the surrounding explanation.

## Format

Put each independently copyable payload in a top-level fenced block. An optional invisible marker before the opening fence provides its picker label. Blank lines between the marker and fence are allowed:

````markdown
[copy-region-1]: # "Run the checks"

```bash
nub run check
```
````

For a prompt intended for another agent, use `text`:

````markdown
[copy-region-2]: # "Prompt for the reviewer"

```text
Review the authentication changes for correctness and missing tests.
Return only actionable findings with file and line references.
```
````

The examples parse as labels `Run the checks` and `Prompt for the reviewer`. Their exact payloads are respectively `nub run check\n` and the two prompt lines including the final newline.

## Rules

- Write a marker as `[copy-region-N]: # "Short label"` on its own line. Use a unique decimal `N` within the assistant message and a non-empty, plain, concise label without quotation marks.
- A marker must start the message or be preceded by a blank line. This separation lets Markdown treat it as a hidden reference definition.
- Put only optional blank lines between the marker and opening fence. Do not insert prose between them.
- Use only top-level fences: at most three leading spaces, followed by at least three backticks or at least three tildes. Do not put a copyable fence inside a list item.
- Close with the same fence character, using at least as many characters as the opener and only horizontal whitespace after it.
- A marker is optional. An unmarked top-level fenced block remains copyable with a derived label.
- Keep explanations outside the block. Put commands that must run together in one block and independently useful payloads in separate blocks.
- Use `text` for prose prompts and an appropriate language such as `bash` for commands or the relevant format for configuration.
- Preserve the payload exactly. Do not add shell prompts, line numbers, decorative indentation, Markdown escapes, or elisions.
- Do not fence ordinary illustrative prose solely to make it copyable; existing illustrative fenced code remains selectable.
