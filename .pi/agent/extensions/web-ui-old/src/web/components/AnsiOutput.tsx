import { useMemo } from "preact/hooks";
import { normalizeTerminalText } from "../lib/text.js";

interface AnsiOutputProps {
  text: string;
  /** Accessible label for the terminal output region. */
  label?: string;
}

/**
 * Terminal-like tool output, rendered exactly as the exporter renders plain
 * `.tool-output` — one escaped `<div class="ansi-line">` per line. Content is
 * sanitized (ANSI escape sequences and control characters removed) and bounded,
 * then emitted as Preact text nodes. No raw HTML is ever inserted, so neither
 * markup nor terminal control actions can affect the DOM. This is the semantic
 * line rendering the handoff calls for; because output is already ANSI-stripped
 * upstream, no client-side SGR parser is needed for parity.
 */
export function AnsiOutput({ text, label }: AnsiOutputProps) {
  const lines = useMemo(() => normalizeTerminalText(text).split("\n"), [text]);
  return (
    <div class="ansi-output" {...(label ? { "aria-label": label } : {})}>
      {lines.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key -- positional output lines
        <div key={index} class="ansi-line">
          {line}
        </div>
      ))}
    </div>
  );
}
