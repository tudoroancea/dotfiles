import { resolveImage } from "../lib/images.js";
import { sanitizeText } from "../lib/text.js";
import { Markdown } from "./Markdown.js";

function ImageBlock({ block }: { block: unknown }) {
  const view = resolveImage(block);
  if (view.kind === "omitted") {
    return <p class="image image--omitted">{view.label}</p>;
  }
  return <img class="image" src={view.src} alt="Attached image" loading="lazy" decoding="async" />;
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <details class="thinking">
      <summary>Thinking</summary>
      <div class="thinking__body">
        <Markdown source={text} />
      </div>
    </details>
  );
}

/** Renders an untrusted content-block array: prose, thinking, and images. */
export function ContentBlocks({ content }: { content: readonly unknown[] }) {
  return (
    <>
      {content.map((block, index) => {
        if (typeof block === "string") {
          // eslint-disable-next-line react/no-array-index-key -- positional content
          return <Markdown key={index} source={block} />;
        }
        if (!block || typeof block !== "object") return null;
        const record = block as Record<string, unknown>;
        const key = index;
        if (record.type === "text" && typeof record.text === "string") {
          return <Markdown key={key} source={record.text} />;
        }
        if (record.type === "thinking" || record.type === "reasoning") {
          const text = sanitizeText(
            typeof record.thinking === "string"
              ? record.thinking
              : typeof record.text === "string"
                ? record.text
                : "",
          );
          return text ? <ThinkingBlock key={key} text={text} /> : null;
        }
        if (record.type === "image") return <ImageBlock key={key} block={record} />;
        return null;
      })}
    </>
  );
}
