import { useEffect, useRef, useState } from "preact/hooks";
import type { CompletionItem, SessionMetadata } from "../../shared/wire.js";
import { applyCompletion, detectCompletion, type CompletionTarget } from "../completion.js";
import { CompletionPopover } from "./CompletionPopover.js";
import { shortenPath } from "../lib/text.js";

export type ComposerMode = "prompt" | "steer" | "follow_up";

function usageLabel(metadata: SessionMetadata | undefined): string {
  const usage = metadata?.contextUsage;
  if (!usage) return "context —";
  const tokens = usage.tokens === null ? "—" : Math.round(usage.tokens).toLocaleString();
  const percent = usage.percent === null ? "" : ` · ${Math.round(usage.percent)}%`;
  return `${tokens} tok${percent}`;
}

export function Composer({
  metadata,
  sessionId,
  running,
  connected,
  content,
  mode,
  notice,
  onContent,
  onMode,
  onSend,
  onAbort,
  requestCompletion,
}: {
  metadata?: SessionMetadata;
  sessionId?: string;
  running: boolean;
  connected: boolean;
  content: string;
  mode: ComposerMode;
  notice: string;
  onContent: (value: string) => void;
  onMode: (mode: ComposerMode) => void;
  onSend: () => void;
  onAbort: () => void;
  requestCompletion: (kind: "slash" | "mention", query: string) => Promise<CompletionItem[]>;
}) {
  const model = metadata?.model;
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [target, setTarget] = useState<CompletionTarget>();
  const [items, setItems] = useState<CompletionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [itemsTarget, setItemsTarget] = useState("");
  const requestSequence = useRef(0);

  const targetKey = (value: CompletionTarget | undefined) =>
    value ? `${value.kind}:${value.start}:${value.end}:${value.query}` : "";

  useEffect(() => {
    const current = target;
    const key = targetKey(current);
    const sequence = ++requestSequence.current;
    setItems([]);
    setItemsTarget("");
    if (!current || !connected) return;
    const timer = window.setTimeout(() => {
      void requestCompletion(current.kind, current.query)
        .then((next) => {
          if (requestSequence.current !== sequence) return;
          setItems(next.slice(0, 20));
          setItemsTarget(key);
          setActiveIndex(0);
        })
        .catch(() => undefined);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    target?.kind,
    target?.query,
    target?.start,
    target?.end,
    metadata?.cwd,
    sessionId,
    connected,
    requestCompletion,
  ]);

  const refreshTarget = (value: string, cursor: number) => {
    const next = detectCompletion(value, cursor);
    if (targetKey(next) !== targetKey(target)) {
      setItems([]);
      setItemsTarget("");
    }
    setTarget(next);
  };
  const select = (item: CompletionItem) => {
    if (!target || itemsTarget !== targetKey(target)) return;
    const applied = applyCompletion(content, target, item);
    onContent(applied.value);
    setTarget(undefined);
    setItems([]);
    setItemsTarget("");
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(applied.cursor, applied.cursor);
    });
  };
  return (
    <footer class="composer">
      <p class="composer__notice" aria-live="polite">
        {notice}
      </p>
      <form
        class="composer__form"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div class="composer__meta composer__meta--top">
          <span>{usageLabel(metadata)}</span>
          {metadata?.sessionCost !== undefined ? (
            <span>${metadata.sessionCost.toFixed(4)}</span>
          ) : null}
          <span class="composer__meta-spacer" />
          {model ? (
            <span title={`${model.provider}/${model.id}`}>
              {model.provider}/{model.name}
            </span>
          ) : null}
          {metadata?.thinkingLevel ? (
            <span class={`composer__thinking composer__thinking--${metadata.thinkingLevel}`}>
              {metadata.thinkingLevel}
            </span>
          ) : null}
        </div>
        <div class="composer__editor">
          <textarea
            ref={textarea}
            class="composer__input"
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={items.length > 0 ? "composer-completions" : undefined}
            aria-activedescendant={items.length > 0 ? `completion-${activeIndex}` : undefined}
            rows={3}
            value={content}
            placeholder={running ? "Steer the running turn…" : "Send a prompt…"}
            onClick={(event) =>
              refreshTarget(event.currentTarget.value, event.currentTarget.selectionStart)
            }
            onInput={(event) => {
              onContent(event.currentTarget.value);
              refreshTarget(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (items.length === 0) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((activeIndex + delta + items.length) % items.length);
              } else if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                select(items[activeIndex]!);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setTarget(undefined);
                setItems([]);
                setItemsTarget("");
              }
            }}
          />
          <CompletionPopover
            items={items}
            activeIndex={activeIndex}
            onActive={setActiveIndex}
            onSelect={select}
          />
        </div>
        <div class="composer__controls">
          <div class="composer__meta composer__meta--bottom">
            {metadata?.cwd ? (
              <span title={metadata.cwd}>{shortenPath(metadata.cwd, 44)}</span>
            ) : null}
            {sessionId ? <span title={sessionId}>session {sessionId.slice(0, 8)}</span> : null}
          </div>
          {running ? (
            <label class="composer__mode" for="mode">
              <span class="composer__mode-label">Deliver as</span>
              <select
                id="mode"
                value={mode === "follow_up" ? "follow_up" : "steer"}
                onChange={(event) => onMode(event.currentTarget.value as ComposerMode)}
              >
                <option value="steer">Steer</option>
                <option value="follow_up">Follow-up</option>
              </select>
            </label>
          ) : (
            <span class="composer__idle-mode">Prompt</span>
          )}
          <div class="composer__actions">
            <button
              type="button"
              class="btn btn--ghost"
              disabled={!connected || !running}
              onClick={onAbort}
            >
              Abort
            </button>
            <button type="submit" class="btn btn--send" disabled={!connected || !content.trim()}>
              Send
            </button>
          </div>
        </div>
      </form>
    </footer>
  );
}
