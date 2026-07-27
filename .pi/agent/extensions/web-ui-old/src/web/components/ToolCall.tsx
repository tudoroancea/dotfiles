import { useState } from "preact/hooks";
import type { ToolView } from "../lib/tool-model.js";
import { resolveAdapter } from "../render/registry.js";
import { useExpansion } from "./expansion.js";

const STATUS_LABEL: Record<ToolView["status"], string> = {
  running: "Running",
  completed: "Done",
  error: "Failed",
};

export interface ToolCallProps {
  view: ToolView;
  /** Stable ID that binds this disclosure to externalized expansion state. */
  id?: string;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

/** Boxed terminal panel for a single tool call, driven by the registry. */
export function ToolCall({
  view,
  id,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
}: ToolCallProps) {
  const expansion = useExpansion();
  const controlled = expanded !== undefined;
  const external = !controlled && id !== undefined && expansion !== null;
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const isExpanded = controlled
    ? expanded
    : external
      ? expansion!.isExpanded(id!)
      : uncontrolledExpanded;
  const adapter = resolveAdapter(view.name);
  const detail = adapter.detail?.(view);
  const setExpanded = (next: boolean) => {
    if (external) expansion!.toggle(id!);
    else if (!controlled) setUncontrolledExpanded(next);
    onExpandedChange?.(next);
  };
  const bar = (expandable: boolean, showStatus = true) => (
    <div class="tool__bar">
      <span class="tool__glyph" aria-hidden="true">
        {adapter.glyph}
      </span>
      <span class="tool__title">{adapter.title(view)}</span>
      {showStatus ? (
        <span class={`tool__status tool__status--${view.status}`}>{STATUS_LABEL[view.status]}</span>
      ) : null}
      {expandable ? <span class="tool__toggle" aria-hidden="true" /> : null}
    </div>
  );
  const summaryLine = <div class="tool__summary">{adapter.summary(view)}</div>;
  const isInline = adapter.inline !== undefined;
  const inline = adapter.inline?.(view, {
    expanded: isExpanded,
    onExpandedChange: setExpanded,
  });
  const inlineBodyClass = adapter.inlineBodyClass?.(view);

  return (
    <article
      class={`tool tool--${view.status}${isInline ? " tool--inline" : ""}`}
      data-tool={view.name}
      {...(id ? { "data-tool-id": id } : {})}
      aria-busy={view.status === "running"}
    >
      <span class="sr-only" role="status">
        {STATUS_LABEL[view.status]}
      </span>
      {isInline ? (
        <>
          <div class="tool__head tool__head--static">{bar(false, false)}</div>
          {inline ? (
            <div
              class={`tool__body tool__body--inline${inlineBodyClass ? ` ${inlineBodyClass}` : ""}`}
            >
              {inline}
            </div>
          ) : null}
        </>
      ) : detail ? (
        <details class="tool__disclosure" open={isExpanded}>
          <summary
            class="tool__head"
            onClick={(event) => {
              event.preventDefault();
              setExpanded(!isExpanded);
            }}
          >
            {bar(true)}
            {summaryLine}
          </summary>
          <div class="tool__body">{detail}</div>
        </details>
      ) : (
        <div class="tool__head tool__head--static">
          {bar(false)}
          {summaryLine}
        </div>
      )}
    </article>
  );
}
