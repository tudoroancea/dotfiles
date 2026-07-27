import { useMemo } from "preact/hooks";
import { highlightCode } from "../lib/highlight.js";
import { sanitizeText, truncateText } from "../lib/text.js";

interface CodeBlockProps {
  code: string;
  language?: string;
  /** Semantic role hint used only for the surrounding class. */
  variant?: "output" | "code";
}

/** Monospace block for tool output and code, with selective highlighting. */
export function CodeBlock({ code, language, variant = "code" }: CodeBlockProps) {
  const html = useMemo(() => {
    const { text } = truncateText(sanitizeText(code));
    return highlightCode(text, language);
  }, [code, language]);
  return (
    <pre class={`code-block code-block--${variant}`}>
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
