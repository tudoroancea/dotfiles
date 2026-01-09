# Pi Notify Extension

A [pi](https://github.com/badlogic/pi-mono) extension that provides desktop notifications when the agent completes tasks or requires attention, plus confetti celebration via Raycast.

## Features

- 🎉 **Confetti on success** - Triggers Raycast confetti when the agent successfully completes a task
- 🔔 **System notifications** - Native macOS notifications when the agent finishes
- 🔴 **Critical alerts** - Persistent notifications when the agent needs your attention (questions, errors)
- 👁️ **Focus-aware** - No notifications when the terminal window is focused
- 🖱️ **Click-to-redirect** - Clicking a notification activates Ghostty

## Requirements

- **macOS** 10.8 or later
- **[Raycast](https://raycast.com/)** (optional, for confetti)
- **[Ghostty](https://ghostty.org/)** (optional, for click-to-redirect)

## Installation

The extension is already installed at `~/.pi/agent/extensions/pi-notify/`.

To reinstall or update dependencies:

```bash
cd ~/.pi/agent/extensions/pi-notify
npm install
```

## Usage

The extension loads automatically when you start pi. You'll see a status indicator in the footer showing the notification state.

### Status Indicators

- `🔔 Ready` - Extension loaded, waiting for agent activity
- `🔔 Turn N...` - Agent is working (notifications enabled)
- `🔕 Turn N...` - Agent is working (window focused, notifications disabled)
- `🔔 Done` - Agent completed successfully
- `🔔 Needs attention` - Agent needs your input

### Commands

| Command | Description |
|---------|-------------|
| `/notify-test` | Send a test notification |
| `/confetti` | Trigger confetti celebration |

### Flags

| Flag | Description |
|------|-------------|
| `--no-confetti` | Disable confetti on successful completion |
| `--no-notify` | Disable all notifications |
| `--notify-sound <name>` | Custom notification sound |

#### Available Sounds

macOS system sounds that can be used with `--notify-sound`:

- `Basso` (default for critical)
- `Blow`
- `Bottle`
- `Frog`
- `Funk`
- `Glass`
- `Hero`
- `Morse`
- `Ping`
- `Pop` (default for success)
- `Purr`
- `Sosumi`
- `Submarine`
- `Tink`

### Examples

```bash
# Disable confetti
pi --no-confetti

# Disable all notifications
pi --no-notify

# Use a custom sound
pi --notify-sound Glass
```

## How It Works

### Focus Detection

The extension uses terminal escape sequences (DECSET 1004) to detect window focus:
- When you focus the terminal: notifications are suppressed
- When you blur the terminal: notifications are enabled

This works with Ghostty, iTerm2, and most modern terminals.

### Notification Types

1. **Success notification** - Sent when the agent completes without needing attention
   - Triggers confetti (unless `--no-confetti`)
   - Shows "✅ Pi completed" notification
   - Standard timeout (10 seconds)

2. **Attention notification** - Sent when the agent needs your input
   - Triggered by the `question` tool or tool errors
   - Shows "🔴 Pi needs your attention" notification
   - Longer timeout (30 seconds)
   - Uses "Basso" sound by default

### Click-to-Redirect

When you click a notification, the extension uses AppleScript to activate Ghostty:

```applescript
tell application "Ghostty"
  activate
end tell
```

## Troubleshooting

### Notifications not appearing

1. Check macOS notification permissions:
   - System Settings → Notifications → terminal-notifier
   - Ensure notifications are allowed

2. Verify the extension is loaded:
   - Look for "🔔 Ready" in the footer

3. Test with `/notify-test` command

### Confetti not working

1. Ensure Raycast is installed
2. Try running manually: `open -g raycast://extensions/raycast/raycast/confetti`
3. Check if Raycast's confetti extension is enabled

### Click-to-redirect not working

1. Ensure Ghostty is the terminal you're using
2. The extension activates Ghostty by name; other terminals won't be activated

### Focus detection issues

If notifications fire even when focused:
- Some terminal configurations may not support DECSET 1004
- The extension assumes focused by default and listens for focus/blur events

## File Structure

```
~/.pi/agent/extensions/pi-notify/
├── package.json        # Extension config and dependencies
├── index.ts            # Main extension entry point
├── src/
│   ├── focus.ts        # Focus detection module
│   ├── notify.ts       # macOS notification wrapper
│   └── confetti.ts     # Raycast confetti integration
└── README.md           # This file
```

## License

MIT
