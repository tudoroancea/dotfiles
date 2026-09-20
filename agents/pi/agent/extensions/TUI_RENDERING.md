# Pi TUI rendering — reference

How `@earendil-works/pi-tui` and Pi's tool-execution shell actually work, for anyone
writing or reviewing a TUI renderer in this repo. Verified against
`@earendil-works/pi-{tui,coding-agent}@0.86.1`; paths below are inside those packages.

The browser equivalents refer to `packages/pi-web-ui-client`. The two surfaces intentionally
share behavior and vocabulary without sharing a presentation abstraction.

## Renderer architecture and parity

Renderers live with the tool owner:

- `agent/extensions/lib/tools/` owns the shared TUI contract and primitives, plus renderers for
  Pi's built-in tools and the wrapped FFF tools;
- `agent/extensions/agentflow/src/ui/` owns Agentflow's tools and delivered-result message;
- `agent/extensions/background-processes/src/ui/` owns the background tools and messages;
- `agent/extensions/questionnaire.ts` owns execution while
  `agent/extensions/lib/tools/questionnaire.ts` owns its renderer;
- `packages/pi-web-ui-client/src/client/tools/` owns the corresponding browser views.

Keep the host implementations aligned by mirroring module organization, decode boundaries, names,
and fixtures. Collapsed renderers follow the browser's compact one-line summaries. Expanded
renderers show the union of useful metadata available on either surface, expressed with each
host's native layout. A behavior or wording change normally belongs on both sides, with focused
owner tests, the cross-owner TUI goldens, and the shared showcase fixture updated together.

A shared declarative view model was evaluated after the renderer convergence and rejected. The
view leaves are not mechanical: the terminal delegates some expanded built-in bodies back to Pi,
measures and truncates by character cells, sanitizes ANSI, has one global expansion state, and
cannot reproduce browser disclosures, accessibility, images, or status-tone overrides. A shared
`Block[]` model would encode host exceptions or reduce both hosts to a lowest common denominator.

Sharing only decoders is also deferred rather than assumed. The closest duplicate,
questionnaire, has different boundaries: the browser consumes a raw transcript result and
validates a bounded TypeBox data transfer object, while the TUI receives Pi's normalized result
and applies terminal sanitization. Agentflow and background differ more: their TUI renderers
consume owner-produced snapshot types, while the browser decoders defensively construct bounded
renderer views from untrusted transcript data. Extracting these today would change ownership and
runtime dependencies, not merely remove duplication. Revisit a shared decoder only when a
concrete rule must again be fixed independently on both surfaces, a third host needs the same
normalized data, and the consumers genuinely agree on one data transfer object. Presentation
remains host-owned either way.

## The one interface

```ts
interface Component {
  render(width: number): string[]; // ANSI-styled lines, one array entry per terminal row
  invalidate(): void; // drop cached lines (theme change, forced redraw)
  handleInput?(data: string): void; // focusable widgets only
}
```

That is the whole contract. A component is a function from the available width to lines.
There is no layout engine, no measurement pass and no box model: **anything CSS would do
with layout you do by composing strings**, and anything CSS would do with color you get from
`theme.fg`/`theme.bg`.

`TUI` (`dist/tui.js`) owns the tree, calls `render(width)` and diff-repaints only the lines
that changed. It is the reconciler plus the DOM.

## Component catalog

| Construct                                       | Behavior                                                                                                                                      | Browser equivalent                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Container`                                     | stacks children, concatenating their lines; no padding, no style                                                                              | `<div>` in normal block flow                                                                                  |
| `Box(padX, padY, bgFn)`                         | `Container` plus `padX` spaces left/right, `padY` blank lines top/bottom, and `bgFn` applied to every line after padding it to the full width | `<div style="padding: …; background: …">` — literally what `.tool-execution` does                             |
| `Text(text, padX, padY, bgFn?)`                 | leaf that **word-wraps** ANSI text to the content width (`wrapTextWithAnsi`), expands tabs to three spaces, caches on `(text, width)`         | `.tool-output`: `white-space: pre-wrap; overflow-wrap: anywhere`                                              |
| `TruncatedText(text, padX, padY)`               | same, but **clips** each line to the width                                                                                                    | `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` (`.tool-run-summary`, `.agentflow-tool-row`) |
| `Spacer(n)`                                     | `n` empty lines                                                                                                                               | `margin`                                                                                                      |
| `Markdown`                                      | markdown → styled lines, including highlighted code blocks                                                                                    | our `marked` + DOMPurify pipeline                                                                             |
| `Image(data, mime, theme, opts)`                | kitty/iTerm2 inline image with cell-size math, or a fallback                                                                                  | `<img>`                                                                                                       |
| `Loader`, `CancellableLoader`, `BorderedLoader` | animated spinner rows                                                                                                                         | a CSS animation                                                                                               |
| `SelectList`, `SettingsList`, `Editor`, `Input` | the only constructs with `handleInput` and focus                                                                                              | interactive form controls                                                                                     |
| `TUI.showOverlay(component, options)`           | floating panel with anchor/size options, returning an `OverlayHandle`                                                                         | a modal / popover                                                                                             |

### Styling and measuring

- `theme.fg(color, text)`, `theme.bg(bg, text)`, `theme.bold/italic/underline/inverse` wrap a
  string in ANSI codes. The color keys (`toolTitle`, `accent`, `dim`, `muted`, `toolOutput`,
  `success`, `warning`, `error`, `toolDiffAdded/Removed/Context`, `syntax*`) and background
  keys (`toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `customMessageBg`, …) are **the same
  names the browser uses as CSS variables**, which is why the palettes already match.
- `visibleWidth(s)` measures ignoring escape codes; `truncateToWidth(s, w, "…")` clips
  safely; `wrapTextWithAnsi(s, w)` wraps; `sliceByColumn` cuts a range. Use these instead of
  `String.length`/`slice` on any styled string.
- From `pi-coding-agent`: `highlightCode`, `getLanguageFromPath`, `renderDiff`,
  `truncateToVisualLines`, `keyHint`/`keyText` (renders the user's actual keybinding),
  `formatSize`.

### Gotchas that bite

- `Text.render` returns `[]` when the text is empty or whitespace-only, and `Box.render`
  returns `[]` when its children produce no lines. That is how "a collapsed tool shows no
  body at all" happens — return an empty `Text`/`Container` deliberately, not by accident.
- Only focusable widgets receive input. Transcript rows never do, so **there is no
  per-row click or per-row expansion**; expansion is one global flag (see below).
- Untrusted strings must go through a sanitizer before rendering — a raw escape sequence
  from a tool result can repaint the screen. See `sanitizeRenderedValue` in
  `lib/tools/format.ts`. Normalize `\r\n` **before** sanitizing: the sanitizer maps a stray
  CR to a space, so sanitizing first leaves a trailing space on every line.
- `render(width)` receives a narrow width on a split pane, and `Container` passes it through
  unchanged. `Text`/`Box` clamp their content width to at least one column and `Terminal`
  falls back to 80 columns when stdout reports none, so zero is not reachable through the
  shell — but a custom component doing arithmetic on `width` should still guard with
  `if (width <= 0) return []` rather than emit negative-length padding.

## The tool-execution shell

`dist/modes/interactive/components/tool-execution.js` builds every tool call:

```
Spacer(1)
Box(1, 1, bgFn)          bgFn = toolPendingBg | toolSuccessBg | toolErrorBg
  ├─ renderCall(args, theme, ctx)                        ← the header
  └─ renderResult(result, {expanded, isPartial}, theme, ctx)  ← only once a result exists
Spacer(1) + Image(...)   per image block in the result
```

- The `Box` is the browser's `ToolBox`; `renderCall`/`renderResult` are its `header`/`body`.
- **Tone is derived from `isPartial`/`result.isError` and cannot be overridden** — the
  browser's `status()` hook has no equivalent. `renderShell: "self"` opts out of the framing
  entirely and lets the renderer draw its own `Box` (images are still handled by the shell).
- **Renderer inheritance is per slot** for the seven built-ins: registering
  `{...createReadToolDefinition(cwd), renderResult}` keeps Pi's `renderCall`.
- A renderer that throws is caught and replaced by the fallback, silently. Test your
  renderers.
- `ctx: ToolRenderContext` carries `args`, `toolCallId`, `cwd`, `expanded`, `isPartial`,
  `executionStarted`, `argsComplete`, `showImages`, `isError`, `state` (per-row scratch
  object), `lastComponent` (the component this slot returned last time) and `invalidate()`.
- Expansion is global: `interactive-mode.js` keeps one `toolOutputExpanded` bound to
  `app.tools.expand` and pushes it into every tool component.

## Composition snippets

### A tool renderer: compact when collapsed, complete when expanded

```ts
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

pi.registerTool({
  name: "example",
  // …schema and execute…
  renderCall(args, theme, ctx) {
    // Reuse the previous Text instead of allocating: same node, new content.
    const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(
      theme.fg("toolTitle", theme.bold("example ")) +
        theme.fg("accent", String(args.path ?? "…")) +
        (args.limit === undefined ? "" : theme.fg("dim", ` · limit ${args.limit}`)),
    );
    return text;
  },
  renderResult(result, { expanded, isPartial }, theme) {
    const output = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    if (isPartial && !expanded) return new Text("", 0, 0); // renders zero lines
    if (expanded) return new Text(theme.fg("toolOutput", `\n${output}`), 0, 0);
    const count = output ? output.split("\n").length : 0;
    return new Text(theme.fg("dim", count ? `${count} lines` : "no output"), 0, 0);
  },
});
```

### Rows that never wrap, versus text that does

`Text` wraps; for the browser's ellipsized one-line rows, produce the lines yourself:

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

`maxLines` is how a terminal expresses the browser's nested `ExpandableOutput`: there is no
inner disclosure to click, so pick a bound per state instead.

### A row that updates itself

`state` survives across renders of the same row; `invalidate()` asks for a repaint, and Pi
answers it by re-running *both* render slots (`updateDisplay`), so the row recomputes rather
than repainting cached lines.

`lib/tools/live.ts` is the implementation of this for the renderers here — use it rather than
writing a timer per renderer:

```ts
body: (_args, result, ctx) => {
  const run = decode(result);
  liveRedraw(ctx, run.status === "running"); // one timer per row, dropped when it settles
  return statusLine(ctx.theme, run.status, { parts: [formatElapsed(run.startedAt)], ... });
}
```

Always clear timers on completion and on `session_shutdown` — a renderer is not a lifecycle
owner, which is why `stopLiveRedraw()` exists and both extensions call it there. And keep a
settled row deterministic: only a live row may tick, or the goldens move on their own.

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

This is the only way to express "pending while the tool result is already settled" — the browser
does it with `status()`.

It comes with a trap, and it is why the questionnaire does not use it. Dropping the shell drops
the *shared* box the two slots append into, so each slot that draws produces its own box, and
exactly one of them may be non-empty. No field of the render context distinguishes "pending" from
"settled" in every host: Pi's HTML exporter calls `renderCall` with `isPartial: true` hardcoded and
then `renderResult` with `isPartial: false`, emitting both
(`dist/core/export-html/tool-renderer.js`). A renderer that splits on `isPartial` therefore draws
two boxes in every `pi --export`, the first one reporting a state the call has left. So reach for
`renderShell: "self"` only when `renderCall` alone can draw everything — a tool that tracks its own
state and does not need its result — and otherwise let the body carry the state in its colours.

### Composing a message renderer

`pi.registerMessageRenderer` gets `outputPad` so custom messages line up with the
transcript:

```ts
pi.registerMessageRenderer("my-event", (message, { expanded, outputPad }, theme) => {
  const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("■ event")), 0, 0));
  if (expanded) box.addChild(new Text(theme.fg("dim", String(message.content)), 0, 0));
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

`Container` is a plain `<div>`: lines in, lines out. Reach for `Box` only when you want
padding or a background.

## Mapping the browser's primitives to lines

What `packages/pi-web-ui-client/src/client/tools/shared.tsx` does, and its terminal form:

| Browser                                           | Terminal                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `ToolBox` (status class + click)                  | the shell's `Box(1,1)` with a status `bgFn`                        |
| `Summary` (`.compact-result`)                     | one `theme.fg("dim" \| "error", …)` line                           |
| `Output` (`.tool-output`)                         | `Text(theme.fg("toolOutput", text), 0, 0)`                         |
| `ExpandableOutput` (nested disclosure)            | a fixed `maxLines` bound plus `… N more lines`                     |
| `SearchHeader`                                    | `bold(label) + accent(pattern) + dim(" · " + details.join(" · "))` |
| `Facts` (CSS grid `dt`/`dd`)                      | one `dim("Label: value")` line per fact                            |
| `StatusLine` (status · parts · "click to expand") | same, with `keyHint("app.tools.expand", …)`                        |
| `ResultNotice`                                    | `theme.fg("warning", "[…]")`                                       |
| `InvalidArg`                                      | `theme.fg("error", "[invalid arg]")`                               |
| `ImageBlock`                                      | handled by the shell from the result's image blocks                |
| image omission placeholders                       | no equivalent                                                      |
