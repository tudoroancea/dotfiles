import { useEffect, useRef, useState } from "preact/hooks";
import type { CompletionItem, SessionMetadata } from "../../shared/wire.js";
import { applyCompletion, detectCompletion, type CompletionTarget } from "../completion.js";
import { CompletionPopover } from "./CompletionPopover.js";
import { shortenPath, withHome } from "../lib/text.js";

/** Context usage as a rounded percentage of the model's max context window. */
function usageLabel(metadata: SessionMetadata | undefined): string {
  const usage = metadata?.contextUsage;
  if (!usage) return "context —";
  const percent =
    usage.percent !== null
      ? usage.percent
      : usage.tokens !== null && usage.contextWindow > 0
        ? (usage.tokens / usage.contextWindow) * 100
        : null;
  if (percent === null) return "context —";
  return `${Math.round(percent)}% context`;
}

/** Session cost rounded up to whole cents, so a fraction of a cent still shows. */
function costLabel(cost: number): string {
  const cents = cost * 100;
  const nearestCent = Math.round(cents);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(cents)) * 4;
  const roundedCents = Math.abs(cents - nearestCent) <= tolerance ? nearestCent : Math.ceil(cents);
  return `$${(roundedCents / 100).toFixed(2)}`;
}

export function Composer({
  metadata,
  sessionId,
  running,
  connected,
  content,
  notice,
  onContent,
  onSend,
  onAbort,
  requestCompletion,
}: {
  metadata?: SessionMetadata;
  sessionId?: string;
  running: boolean;
  connected: boolean;
  content: string;
  notice: string;
  onContent: (value: string) => void;
  onSend: (delivery?: "steer" | "follow_up") => void;
  onAbort: () => void;
  requestCompletion: (kind: "slash" | "mention", query: string) => Promise<CompletionItem[]>;
}) {
  const model = metadata?.model;
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [target, setTarget] = useState<CompletionTarget>();
  const [items, setItems] = useState<CompletionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [itemsTarget, setItemsTarget] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [abortArmed, setAbortArmed] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!running) {
      setAbortArmed(false);
      return;
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.altKey) setAbortArmed(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt" || !event.altKey) setAbortArmed(false);
    };
    const blur = () => setAbortArmed(false);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [running]);

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
            <span>{costLabel(metadata.sessionCost)}</span>
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
              if (
                connected &&
                running &&
                event.altKey &&
                (event.code === "Period" || event.key === ".")
              ) {
                event.preventDefault();
                onAbort();
                return;
              }
              if (connected && event.key === "Enter" && event.altKey) {
                event.preventDefault();
                onSend();
                return;
              }
              if (connected && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSend(running ? "follow_up" : undefined);
                return;
              }
              if (items.length === 0) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((activeIndex + delta + items.length) % items.length);
              } else if (
                (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) ||
                event.key === "Tab"
              ) {
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
              <span title={metadata.cwd}>
                {shortenPath(withHome(metadata.cwd, metadata.home), 44)}
              </span>
            ) : null}
            {sessionId ? <span title={sessionId}>session {sessionId.slice(0, 8)}</span> : null}
          </div>
          <div class="composer__actions">
            <div class="composer__shortcuts">
              <button
                type="button"
                class="composer__shortcuts-toggle"
                aria-expanded={shortcutsOpen}
                onClick={() => setShortcutsOpen((open) => !open)}
              >
                ⌨ Shortcuts
              </button>
              {shortcutsOpen ? (
                <dl class="composer__shortcuts-panel" aria-label="Keyboard shortcuts">
                  <div>
                    <dt>Enter</dt>
                    <dd>New line</dd>
                  </div>
                  <div>
                    <dt>⌥ Enter</dt>
                    <dd>{running ? "Steer the running turn" : "Send"}</dd>
                  </div>
                  <div>
                    <dt>⌃ Enter</dt>
                    <dd>{running ? "Queue a follow-up" : "Send"}</dd>
                  </div>
                  <div>
                    <dt>⌥ .</dt>
                    <dd>Stop the running turn</dd>
                  </div>
                </dl>
              ) : null}
            </div>
            {running ? (
              <>
                <button
                  type="button"
                  class="btn btn--queue"
                  disabled={!connected || !content.trim()}
                  onClick={() => onSend("follow_up")}
                >
                  Queue
                </button>
                {abortArmed ? (
                  <button
                    type="button"
                    class="btn btn--stop"
                    disabled={!connected}
                    onClick={onAbort}
                    title="Stop the running turn (⌥.)"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    class="btn btn--send"
                    disabled={!connected || !content.trim()}
                  >
                    Steer
                  </button>
                )}
              </>
            ) : (
              <button type="submit" class="btn btn--send" disabled={!connected || !content.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </footer>
  );
}
