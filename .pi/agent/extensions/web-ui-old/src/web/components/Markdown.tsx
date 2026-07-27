import { useMemo } from "preact/hooks";
import { renderMarkdown } from "../lib/markdown.js";

/** Renders untrusted Markdown as sanitized HTML. */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  // The only DOM sink for model prose: `html` is produced by marked with
  // embedded HTML disabled and then run through DOMPurify.
  return <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
