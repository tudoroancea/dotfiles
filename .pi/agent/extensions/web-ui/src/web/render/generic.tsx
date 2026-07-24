import { CodeBlock } from "../components/CodeBlock.js";
import { ContentBlocks } from "../components/ContentBlocks.js";
import { JsonView } from "../components/JsonView.js";
import type { ToolView } from "../lib/tool-model.js";
import type { ToolAdapter } from "./types.js";

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function hasImages(view: ToolView): boolean {
  return view.content.some(
    (block) =>
      block !== null &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "image",
  );
}

/** Safe fallback for tools without a dedicated adapter. */
export const genericAdapter: ToolAdapter = {
  glyph: "▸",
  label: "tool",
  title: (view) => <span class="tool__command">{view.name}</span>,
  summary: (view) => {
    if (view.isError) return `failed · ${firstLine(view.text) || "error"}`;
    if (view.isPartial && !view.text) return "working…";
    return firstLine(view.text) || "done";
  },
  detail: (view) => {
    const hasArgs = Object.keys(view.args).length > 0;
    const hasDetails = Object.keys(view.details).length > 0;
    if (!view.text && !hasArgs && !hasDetails && !hasImages(view)) return undefined;
    return (
      <div class="generic">
        {hasArgs ? (
          <section class="generic__section">
            <h4 class="generic__title">Arguments</h4>
            <JsonView value={view.args} />
          </section>
        ) : null}
        {view.text ? (
          <section class="generic__section">
            <h4 class="generic__title">Output</h4>
            <CodeBlock code={view.text} variant="output" />
          </section>
        ) : null}
        {hasImages(view) ? (
          <section class="generic__section">
            <ContentBlocks
              content={view.content.filter(
                (block) =>
                  block !== null &&
                  typeof block === "object" &&
                  (block as Record<string, unknown>).type === "image",
              )}
            />
          </section>
        ) : null}
        {hasDetails ? (
          <section class="generic__section">
            <h4 class="generic__title">Details</h4>
            <JsonView value={view.details} />
          </section>
        ) : null}
      </div>
    );
  },
};
