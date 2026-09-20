import { useMemo } from "preact/hooks";
import { highlightCode } from "../lib/highlight.js";
import { normalizeTerminalText } from "../lib/text.js";

export interface ExporterOutputProps {
  text: string;
  previewLines: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  label?: string;
  class?: string;
  /** Explicit, path-derived language. Unknown paths must leave this undefined. */
  language?: string;
}

/**
 * Exporter-style, line-oriented output. Short output is always visible. Long
 * output starts as an N-line preview and the output itself toggles between the
 * preview and the complete bounded value. Text nodes are used exclusively.
 */
export function ExporterOutput({
  text,
  previewLines,
  expanded,
  onExpandedChange,
  label,
  class: className,
  language,
}: ExporterOutputProps) {
  const lines = useMemo(() => normalizeTerminalText(text).split("\n"), [text]);
  const isLong = lines.length > previewLines;
  const visible = isLong && !expanded ? lines.slice(0, previewLines) : lines;
  const highlighted = useMemo(
    () => (language ? highlightCode(visible.join("\n"), language) : undefined),
    [language, visible],
  );
  const output = (
    <>
      {highlighted !== undefined ? (
        <pre class="code-block code-block--output">
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      ) : (
        visible.map((line, index) => (
          // eslint-disable-next-line react/no-array-index-key -- terminal lines are positional
          <span key={index} class="ansi-line">
            {line}
          </span>
        ))
      )}
      {isLong && !expanded ? (
        <span class="ansi-line ansi-output__hint">
          ... ({lines.length - previewLines} more lines)
        </span>
      ) : null}
    </>
  );

  if (!isLong) {
    return (
      <div
        class={`ansi-output${className ? ` ${className}` : ""}`}
        {...(label ? { "aria-label": label } : {})}
      >
        {output}
      </div>
    );
  }
  return (
    <button
      type="button"
      class={`ansi-output exporter-output${className ? ` ${className}` : ""}`}
      aria-expanded={expanded}
      {...(label ? { "aria-label": label } : {})}
      onClick={(event) => {
        // Pointer selection must remain selectable. Keyboard-generated clicks have
        // detail=0, so Enter/Space activation remains reliable with a selection.
        if (event.detail > 0 && window.getSelection()?.isCollapsed === false) return;
        onExpandedChange(!expanded);
      }}
    >
      {output}
    </button>
  );
}
