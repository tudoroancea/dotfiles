import type { SessionMetadata } from "../../shared/wire.js";
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
}) {
  const model = metadata?.model;
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
        <textarea
          class="composer__input"
          aria-label="Message"
          rows={3}
          value={content}
          placeholder={running ? "Steer the running turn…" : "Send a prompt…"}
          onInput={(event) => onContent(event.currentTarget.value)}
        />
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
