import { useEffect, useRef } from "preact/hooks";
import type { CompletionItem } from "../../shared/wire.js";

export function CompletionPopover({
  items,
  activeIndex,
  onActive,
  onSelect,
}: {
  items: readonly CompletionItem[];
  activeIndex: number;
  onActive: (index: number) => void;
  onSelect: (item: CompletionItem) => void;
}) {
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    options.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  if (items.length === 0) return null;
  return (
    <div class="completion" role="listbox" id="composer-completions">
      {items.map((item, index) => (
        <button
          ref={(element) => {
            options.current[index] = element;
          }}
          id={`completion-${index}`}
          key={`${item.value}-${index}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          class={`completion__item${index === activeIndex ? " completion__item--active" : ""}`}
          onMouseEnter={() => onActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item)}
        >
          <span class="completion__label">{item.label}</span>
          {item.description ? (
            <span class="completion__description">{item.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
