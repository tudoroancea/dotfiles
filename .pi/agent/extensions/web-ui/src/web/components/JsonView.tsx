import { CodeBlock } from "./CodeBlock.js";

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/** Pretty-printed, highlighted, bounded JSON for detail views. */
export function JsonView({ value }: { value: unknown }) {
  return <CodeBlock code={stringify(value)} language="json" variant="output" />;
}
