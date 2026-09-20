import { sanitizeText, truncateText } from "../lib/text.js";

type LineKind = "added" | "removed" | "meta" | "hunk" | "context";

function classify(line: string): LineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/** Line-classified unified-diff renderer (no diff library, no raw HTML). */
export function Diff({ patch }: { patch: string }) {
  const { text } = truncateText(sanitizeText(patch));
  const lines = text.split("\n");
  return (
    <pre class="diff" aria-label="Unified diff">
      {lines.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key -- diff lines are positional
        <span key={index} class={`diff__line diff__line--${classify(line)}`}>
          {line === "" ? " " : line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
