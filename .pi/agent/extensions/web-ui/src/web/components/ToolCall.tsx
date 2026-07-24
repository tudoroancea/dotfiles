import type { ToolView } from "../lib/tool-model.js";
import { resolveAdapter } from "../render/registry.js";

const STATUS_LABEL: Record<ToolView["status"], string> = {
  running: "Running",
  completed: "Done",
  error: "Failed",
};

/** Boxed terminal panel for a single tool call, driven by the registry. */
export function ToolCall({ view }: { view: ToolView }) {
  const adapter = resolveAdapter(view.name);
  const detail = adapter.detail?.(view);
  const summary = (
    <div class="tool__bar">
      <span class="tool__glyph" aria-hidden="true">
        {adapter.glyph}
      </span>
      <span class="tool__title">{adapter.title(view)}</span>
      <span class={`tool__status tool__status--${view.status}`}>{STATUS_LABEL[view.status]}</span>
    </div>
  );
  const summaryLine = <div class="tool__summary">{adapter.summary(view)}</div>;

  return (
    <article
      class={`tool tool--${view.status}`}
      data-tool={view.name}
      aria-busy={view.status === "running"}
    >
      {detail ? (
        <details class="tool__disclosure">
          <summary class="tool__head">
            {summary}
            {summaryLine}
            <span class="tool__toggle" aria-hidden="true" />
          </summary>
          <div class="tool__body">{detail}</div>
        </details>
      ) : (
        <div class="tool__head tool__head--static">
          {summary}
          {summaryLine}
        </div>
      )}
    </article>
  );
}
