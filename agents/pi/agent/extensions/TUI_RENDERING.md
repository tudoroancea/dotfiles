# Pi TUI rendering reference

This reference describes `@earendil-works/pi-tui` and Pi's tool-execution shell for retained
renderers in this repository. The declarations and behavior described here were checked against
local `@earendil-works/pi-tui@1.0.0` and `@earendil-works/pi-coding-agent@1.0.0` packages.
Package-relative paths below refer to their installed `dist/` declarations and JavaScript.

## Renderer ownership

Renderers live with the tool owner:

- `agent/extensions/lib/tools/` owns the shared TUI contract and primitives, plus retained
  renderers for Pi's built-in tools and the wrapped FFF tools;
- `agent/extensions/background-processes/src/ui/` owns the background tools and messages;
- `agent/extensions/questionnaire.ts` owns execution while
  `agent/extensions/lib/tools/questionnaire.ts` owns its renderer.

Collapsed renderers provide compact summaries. Expanded renderers expose useful metadata and
bounded output. Arguments cross the typed `decode` boundary before layout, and untrusted text
passes through terminal sanitization. Focused owner tests and
`tests/tool-goldens.test.ts` cover renderer behavior through Pi's shell.

The optional `builtin-tool-renderers.ts` registration is disabled in `agent/settings.json`.
Its helpers and tests remain, but Pi supplies the active built-in presentation. Background,
FFF, and questionnaire renderers remain with their owners. Browser parity is no longer an
implementation requirement.

### Local source references

| Package           | Reference                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `pi-tui`          | `dist/tui.d.ts`, `dist/index.d.ts`, `dist/components/text.js`, `dist/components/box.js`  |
| `pi-coding-agent` | `dist/core/extensions/types.d.ts`, `dist/modes/interactive/components/tool-execution.js` |
| `pi-coding-agent` | `dist/core/tools/renderers/index.js`, `dist/core/export-html/tool-renderer.js`           |

These files describe component input, per-row render context, framing, built-in slot inheritance,
and HTML export behavior. They are read-only verification sources, not setup implementation targets.

## The one interface

```ts
interface Component {
  render(width: number): string[]; // ANSI-styled lines, one entry per terminal row
  invalidate(): void; // drop cached rendering state
  handleInput?(data: string): void; // keyboard input when focused
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  wantsKeyRelease?: boolean; // opt into Kitty key-release events
}
```

`Component` and the mouse event types are exported by `pi-tui`. Components compose lines at the
available width. `theme.fg` and `theme.bg` apply ANSI colors. Pi 1.0 exports main-screen and
alternate-screen TUI implementations through `TuiMainScreen` and `TuiAltScreen`.

## Component catalog

| Construct                                       | Behavior                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Container`                                     | Stacks children and concatenates their lines without padding or styling.                          |
| `Box(padX, padY, bgFn)`                         | Adds horizontal and vertical padding and applies `bgFn` to full-width lines.                      |
| `Text(text, padX, padY, bgFn?)`                 | Wraps ANSI text with `wrapTextWithAnsi`, expands tabs to three spaces, and caches text and width. |
| `TruncatedText(text, padX, padY)`               | Clips text to the available width instead of wrapping it.                                         |
| `Spacer(n)`                                     | Produces `n` empty lines.                                                                         |
| `Markdown`                                      | Produces styled Markdown lines, including highlighted code blocks.                                |
| `Image(data, mime, theme, opts)`                | Renders Kitty or iTerm2 inline images when supported, or a fallback.                              |
| `Loader`, `CancellableLoader`                   | Provide spinner components from `pi-tui`. `BorderedLoader` comes from `pi-coding-agent`.          |
| `SelectList`, `SettingsList`, `Editor`, `Input` | Handle keyboard input when focused.                                                               |
| `MouseRegion`                                   | Wraps a component with a normalized mouse handler.                                                |
| `TUI.showOverlay(component, options)`           | Returns an `OverlayHandle` for a panel with anchor and size options.                              |

### Styling and measuring

- `theme.fg(color, text)`, `theme.bg(bg, text)`, `theme.bold`, `theme.italic`,
  `theme.underline`, and `theme.inverse` wrap strings in ANSI codes. Foreground keys include
  `toolTitle`, `accent`, `dim`, `muted`, `toolOutput`, `success`, `warning`, and `error`.
  Background keys include `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, and `customMessageBg`.
- `visibleWidth(s)` measures ignoring escape codes; `truncateToWidth(s, w, "…")` clips
  safely; `wrapTextWithAnsi(s, w)` wraps; `sliceByColumn` cuts a range. Use these instead of
  `String.length`/`slice` on any styled string.
- From `pi-coding-agent`: `highlightCode`, `getLanguageFromPath`, `renderDiff`,
  `truncateToVisualLines`, `keyHint`/`keyText` (renders the user's actual keybinding),
  `formatSize`.

### Gotchas that bite

- `Text.render` returns `[]` for empty or whitespace-only text. `Box.render` returns `[]`
  when its children produce no lines. An empty `Text` or `Container` hides the collapsed body.
- Keyboard input goes to focused components. Mouse input is separate in Pi 1.0. The tool shell
  wraps call and result components in `MouseRegion`; a left click toggles that tool's expansion
  once a result exists. Renderers receive the current per-row `expanded` value.
- A raw escape sequence from a tool result can repaint the screen.
  `sanitizeRenderedValue` in `lib/tools/format.ts` strips terminal sequences from untrusted text.
  Normalizing `\r\n` before sanitization avoids trailing spaces, since the sanitizer maps stray
  carriage returns to spaces.
- `render(width)` can receive a narrow viewport width. `Text` reduces horizontal padding to
  fit, while `Box` retains its configured padding. Both clamp content width to at least one
  column. A custom component can guard `width <= 0` before calculating padding or truncation.

## The tool-execution shell

`dist/modes/interactive/components/tool-execution.js` builds every tool call:

```
Spacer(1)
Box(1, 1, bgFn)          bgFn = toolPendingBg | toolSuccessBg | toolErrorBg
  ├─ renderCall(args, theme, ctx)                        ← the header
  └─ renderResult(result, {expanded, isPartial}, theme, ctx)  ← only once a result exists
Spacer(1) + Image(...)   per image block in the result
```

- `renderCall` supplies the header and `renderResult` supplies the body within the same box.
- Default framing derives its background from `isPartial` and `result.isError`.
  `renderShell: "self"` replaces that framing with a plain container, allowing renderer-owned
  boxes. Images are still handled by the shell.
- Built-in renderer inheritance is per slot. `withBuiltInRenderers` in
  `dist/core/tools/renderers/index.js` fills missing `renderCall` and `renderResult` slots.
  Its map includes `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`.
- A renderer that throws is caught and replaced by the fallback, silently. Test your
  renderers.
- `ctx: ToolRenderContext` carries `args`, `toolCallId`, `cwd`, `expanded`, `isPartial`,
  `executionStarted`, `argsComplete`, `showImages`, `isError`, `state` (per-row scratch
  object), `lastComponent` (the component this slot returned last time) and `invalidate()`.
- Expansion is stored on each `ToolExecutionComponent`. `setExpanded` rebuilds its display,
  and the shell's mouse handler toggles that component without changing other rows.

## Composition snippets

### A tool renderer: compact when collapsed, complete when expanded

```ts
import { Text } from "@earendil-works/pi-tui";
import { sanitizeRenderedValue } from "./lib/tools/format.ts";

pi.registerTool({
  name: "example",
  // …schema and execute…
  renderCall(args, theme, ctx) {
    // Reuse the previous Text instead of allocating: same node, new content.
    const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(
      theme.fg("toolTitle", theme.bold("example ")) +
        theme.fg("accent", sanitizeRenderedValue(String(args.path ?? "…"))) +
        (args.limit === undefined
          ? ""
          : theme.fg("dim", ` · limit ${sanitizeRenderedValue(String(args.limit))}`)),
    );
    return text;
  },
  renderResult(result, { expanded, isPartial }, theme) {
    const output = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    if (isPartial && !expanded) return new Text("", 0, 0); // renders zero lines
    if (expanded) {
      const safeOutput = sanitizeRenderedValue(output.replace(/\r\n/g, "\n"));
      return new Text(theme.fg("toolOutput", `\n${safeOutput}`), 0, 0);
    }
    const count = output ? output.split("\n").length : 0;
    return new Text(theme.fg("dim", count ? `${count} lines` : "no output"), 0, 0);
  },
});
```

### Rows that never wrap, versus text that does

`Text` wraps. A component can instead truncate each entry to one terminal row:

```ts
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** One terminal row per entry, clipped with an ellipsis. */
const rows = (lines: string[]): Component => ({
  render: (width) => (width <= 0 ? [] : lines.map((line) => truncateToWidth(line, width, "…"))),
  invalidate() {},
});

/** Wrapping paragraph flow (what `Text` already gives you). */
const flow = (text: string) => new Text(text, 0, 0);
```

### Width-aware wrapping inside a custom component

```ts
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const paragraph = (styled: string, maxLines: number): Component => ({
  render(width) {
    if (width <= 0) return [];
    const lines = wrapTextWithAnsi(styled, width);
    if (lines.length <= maxLines) return lines;
    return [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more lines`];
  },
  invalidate() {},
});
```

`maxLines` bounds paragraph output per expansion state. The example assumes `maxLines >= 1`.
The tool shell does not create nested disclosures for the renderer's internal sections.

### A row that updates itself

`state` survives across renders of the same row; `invalidate()` asks for a repaint, and Pi
answers it by re-running _both_ render slots (`updateDisplay`), so the row recomputes rather
than repainting cached lines.

`lib/tools/live.ts` provides shared timer management for these renderers:

```ts
body: (_args, result, ctx) => {
  const run = decode(result);
  liveRedraw(ctx, run.status === "running"); // one timer per row, dropped when it settles
  return statusLine(ctx.theme, run.status, { parts: [formatElapsed(run.startedAt)], ... });
}
```

`liveRedraw(ctx, false)` clears a row's timer. Background-processes calls `stopLiveRedraw()`
on `session_shutdown` to clear remaining timers, including launch cards whose snapshots stay
running. Settled rows do not tick, so their golden output remains deterministic.

### Drawing your own framing

```ts
pi.registerTool({
  name: "awaiting_user",
  renderShell: "self",
  renderCall(args, theme) {
    const box = new Box(1, 1, (line) => theme.bg("toolPendingBg", line)); // tone we choose
    box.addChild(new Text(theme.fg("toolTitle", theme.bold("awaiting_user")), 0, 0));
    return box;
  },
  // …
});
```

Self framing allows a pending-colored box after the tool result has settled. It also removes
the shared box around both slots. If each slot returns a box, the output contains separate boxes.

Pi's HTML exporter calls `renderCall` with `isPartial: true` and `renderResult` with
`isPartial: false`, emitting both outputs through `dist/core/export-html/tool-renderer.js`.
A call renderer cannot use `isPartial` alone to infer that no final result exists across hosts.
The questionnaire keeps default framing and expresses its state in the body instead.

### Composing a message renderer

`pi.registerMessageRenderer` gets `outputPad` so custom messages line up with the
transcript:

```ts
pi.registerMessageRenderer("my-event", (message, { expanded, outputPad }, theme) => {
  const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("■ event")), 0, 0));
  if (expanded) {
    const content = sanitizeRenderedValue(String(message.content).replace(/\r\n/g, "\n"));
    box.addChild(new Text(theme.fg("dim", content), 0, 0));
  }
  return box;
});
```

### Stacking without styling

```ts
const stack = new Container();
stack.addChild(headerComponent);
stack.addChild(new Spacer(1));
stack.addChild(bodyComponent);
```

`Container` concatenates child lines without styling. `Box` adds padding and a background.

## Shared renderer vocabulary

The retained helpers in `lib/tools/` provide terminal layouts:

| Output           | Terminal form                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Compact summary  | One `theme.fg("dim", text)` or `theme.fg("error", text)` line.                                 |
| Text output      | `Text(theme.fg("toolOutput", text), 0, 0)`.                                                    |
| Bounded output   | A fixed line bound followed by a remaining-line count.                                         |
| Search header    | A bold label, accented pattern, and dim details.                                               |
| Facts            | One dim `Label: value` line per fact.                                                          |
| Status line      | Status and metadata, with the configured `app.tools.expand` key hint.                          |
| Result notice    | `theme.fg("warning", "[…]")`.                                                                  |
| Invalid argument | `theme.fg("error", "[invalid arg]")`.                                                          |
| Images           | The shell handles result image blocks when terminal capabilities and `showImages` permit them. |
