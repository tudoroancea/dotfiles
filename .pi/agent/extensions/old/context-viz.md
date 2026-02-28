# Context Visualization Extension

Displays a visual breakdown of the current context usage showing what's consuming tokens in your conversation.

## Usage

Run the `/context` command at any time to display or hide the visualization:

```
> /context
```

The visualization appears in the widget area above the text input box and shows:

- **Context Usage**: Total tokens used vs. available context window
- **Visual Bar**: Multi-row bar chart showing relative proportions
- **Category Breakdown**: Detailed list with token counts and percentages

## Categories

The visualization breaks down context into these categories:

- **System prompt**: Base system instructions for the agent
- **System tools**: Built-in tool definitions (read, bash, edit, write, etc.)
- **Messages**: User messages, compaction summaries, and branch summaries
- **Tool results**: Output from tool executions
- **Custom agents**: Extension-injected messages
- **Memory files**: Bash execution history (! and !! commands)
- **Assistant output**: LLM responses
- **Reserved**: Prompt cache tokens
- **Free space**: Remaining available context

## Features

- **Real-time snapshot**: Can be run while agent is processing
- **Auto-hide**: Visualization automatically hides when you submit a new query
- **Toggle**: Run `/context` again to hide the visualization manually
- **Theme-aware**: Uses theme colors that work in both dark and light modes
- **Accurate counting**: Uses actual token counts from LLM usage data when available

## Token Estimation

The extension uses actual token counts from assistant messages when available, falling back to rough estimation (~4 chars per token) for other content. Token counts are scaled based on actual usage data to improve accuracy.

## Example

```
> /context
└ Context Usage 12.4k/200k tokens (6%)
  ███████████████████████████████░░░░░░░░░░░░░░░░░░
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
  █████████████████████████████████░░░░░░░░░░░░░░░░

  ■ System prompt:          3.0k tokens (1.5%)
  ■ System tools:          12.0k tokens (6.0%)
  ■ Messages:               8.0k tokens (0.4%)
  ■ Tool results:           2.1k tokens (1.1%)
  ■ Assistant output:       4.3k tokens (2.2%)
  ◇ Free space:           170k tokens (85.0%)
```

## Installation

This extension is auto-discovered from `~/.pi/agent/extensions/context-viz.ts`.

To enable/disable it, use:
```bash
pi config
```
