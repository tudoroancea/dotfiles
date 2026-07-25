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
  const bar = (expandable: boolean) => (
    <div class="tool__bar">
      <span class="tool__glyph" aria-hidden="true">
        {adapter.glyph}
      </span>
      <span class="tool__title">{adapter.title(view)}</span>
      <span class={`tool__status tool__status--${view.status}`}>{STATUS_LABEL[view.status]}</span>
      {expandable ? <span class="tool__toggle" aria-hidden="true" /> : null}
    </div>
  );
  const summaryLine = <div class="tool__summary">{adapter.summary(view)}</div>;

  return (
    <article
      class={`tool tool--${view.status}`}
      data-tool={view.name}
      {...(id ? { "data-tool-id": id } : {})}
      aria-busy={view.status === "running"}
    >
      {detail ? (
        <details class="tool__disclosure" open={isExpanded}>
          <summary
            class="tool__head"
            onClick={(event) => {
              event.preventDefault();
              const next = !isExpanded;
              if (external) expansion!.toggle(id!);
              else if (!controlled) setUncontrolledExpanded(next);
              onExpandedChange?.(next);
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
