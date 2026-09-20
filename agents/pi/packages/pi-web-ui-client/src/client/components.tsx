// Application shell and composer.
//
// These components depend only on the injected `IncrementalSessionTransport` seam
// (through the `useSession` controller); they never reference `fetch`,
// `EventSource`, cookies, or any host detail. The standalone extension and the
// future daemon supply different transports that satisfy the same contract.

import type { JSX } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  CompletionItem,
  ConnectionStatus,
  IncrementalSessionTransport,
  InputDelivery,
  PendingInput,
  PendingInputBrokerCapability,
  Snapshot,
  ThinkingLevel,
} from "../wire/types.ts";
import type { OutboundImageAttachment } from "../wire/protocol.ts";
import { inspectRasterImage } from "../wire/raster.ts";
import { DisclosureContext, useDisclosureStore } from "./disclosure.ts";
import {
  completionTarget,
  completionTargetKey,
  contextLabel,
  costLabel,
  cwdLabel,
  resolveSessionTitle,
} from "./format.ts";
import type { CompletionTarget } from "./format.ts";
import { ImageUrlContext } from "./image-transport.ts";
import { isEditableTarget, PREFS, PrefsContext, usePreferences } from "./preferences.ts";
import { Transcript } from "./renderers.tsx";
import { markProgrammaticScroll, readProgrammaticScrollTarget } from "./scroll.ts";
import { selectShellSnapshot, type SessionState } from "./session-state.ts";
import {
  recordTiming,
  useSession,
  type SessionController,
  type SessionMetrics,
} from "./session.ts";
import { useTheme } from "./theme.ts";

/** Narrow an event target to a DOM node for containment checks. */
function asNode(target: EventTarget | null): Node | null {
  return target instanceof Node ? target : null;
}

function SystemPromptPanel({ snapshot }: { snapshot: Snapshot }) {
  const { prefs } = useContext(PrefsContext);
  if (!prefs.systemPrompt) return null;
  const prompt = snapshot.systemPrompt || "";
  return (
    <section class="system-prompt" aria-label="Effective system prompt">
      <div class="system-prompt-label">system prompt</div>
      {prompt.trim() ? (
        <pre class="system-prompt-text">{prompt}</pre>
      ) : (
        <div class="system-prompt-empty">No system prompt available yet.</div>
      )}
    </section>
  );
}

function StatusBar({
  title,
  snapshot,
  connection,
}: {
  title: string;
  snapshot: Snapshot;
  connection: ConnectionStatus;
}) {
  const state =
    connection === "offline" ? (
      <span class="status-state">
        <span class="status-dot offline"></span>disconnected
      </span>
    ) : snapshot.isRunning ? (
      <span class="status-state">
        <span class="status-dot running"></span>
        {snapshot.workingWord || "running"}
      </span>
    ) : (
      <span class="status-state">
        <span class="status-dot"></span>idle
      </span>
    );
  return (
    <div class="status-bar">
      <span class="status-title">{title}</span>
      {state}
    </div>
  );
}

const EMPTY_SNAPSHOT: Snapshot = {
  header: null,
  entries: [],
  leafId: null,
  isRunning: false,
  workingWord: undefined,
  sessionName: undefined,
  theme: undefined,
  systemPrompt: "",
  metadata: undefined,
  pendingInputs: [],
};

const SCROLL_STORAGE_PREFIX = "pi-web-ui:scroll:";
const SAVE_DEBOUNCE_MS = 120;
const RESTORE_SETTLE_MS = 200;
// The first bottom jump waits for the initial row measurements to finish
// committing, so it never overshoots a document that is still shrinking below
// the 96px per-row estimate (the browser would clamp the overshoot and the
// clamped position would read as the reader having left the bottom).
const INITIAL_JUMP_DELAY_MS = 120;

interface SavedScrollPosition {
  y: number;
  atBottom: boolean;
}

// The page path namespaces the per-session UI (each standalone server gets a
// random base path), so reloads of one session restore its position without
// leaking it into other sessions.
function readSavedScrollPosition(): SavedScrollPosition | null {
  try {
    const raw = localStorage.getItem(SCROLL_STORAGE_PREFIX + location.pathname);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedScrollPosition>;
    if (typeof parsed.y !== "number" || !Number.isFinite(parsed.y)) return null;
    return { y: parsed.y, atBottom: parsed.atBottom === true };
  } catch {
    return null;
  }
}

function writeSavedScrollPosition(position: SavedScrollPosition): void {
  try {
    localStorage.setItem(SCROLL_STORAGE_PREFIX + location.pathname, JSON.stringify(position));
  } catch {
    // Storage can be unavailable (private mode, quota); persistence is best-effort.
  }
}

function useStickToBottom(root: Element, dep: SessionState | null) {
  const saved = useRef(readSavedScrollPosition());
  // The first open of a session (and any reload that left off at the bottom)
  // follows the live tail from the bottom; a reload that saved a mid-transcript
  // position restores it and does not follow until the reader scrolls again.
  const stick = useRef(saved.current === null || saved.current.atBottom);
  const [awayFromBottom, setAwayFromBottom] = useState(!stick.current);
  // A persisted mid-transcript position still waiting to be restored, and later
  // re-applied once the initial row measurements have settled.
  const pendingRestore = useRef<number | null>(
    saved.current !== null && !saved.current.atBottom ? saved.current.y : null,
  );
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initialJumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoreBeforeCursor = useRef<string | null>(null);
  const latestBeforeCursor = useRef<string | null>(null);
  const userScrolled = useRef(false);

  const jumpTo = (target: number) => {
    const y = Math.round(
      Math.max(0, Math.min(target, document.documentElement.scrollHeight - window.innerHeight)),
    );
    markProgrammaticScroll(y);
    window.scrollTo(0, y);
  };

  const scrollToBottom = () => {
    stick.current = true;
    setAwayFromBottom(false);
    // Instant scroll: dynamically measured rows must never trigger a smooth jump.
    jumpTo(document.documentElement.scrollHeight);
  };

  useEffect(() => {
    const atBottom = () =>
      document.documentElement.scrollHeight - window.innerHeight - window.scrollY <= 2;
    // Scroll positions are quantized to device pixels, so an echo of a
    // programmatic jump can land a fraction away from the marked target.
    const atMarker = (y: number) => Math.abs(y - (readProgrammaticScrollTarget() ?? -1)) <= 1;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const save = (atBottomFlag: boolean) => {
      saveTimer = undefined;
      // Re-read the live flag at write time: a save scheduled while the reader
      // was away may fire after they returned to the bottom.
      writeSavedScrollPosition({ y: window.scrollY, atBottom: atBottomFlag || atBottom() });
    };
    const scheduleSave = (atBottomFlag: boolean) => {
      if (saveTimer !== undefined) return;
      saveTimer = setTimeout(() => save(atBottomFlag), SAVE_DEBOUNCE_MS);
    };
    let evaluationFrame: number | undefined;
    const scheduleEvaluation = () => {
      if (evaluationFrame !== undefined) return;
      // Defer the re-check by one frame so it reads the latest committed layout
      // (a clamp or correction may still land in this frame). The result is the
      // same whether that correction runs before or after this callback: if the
      // position ends at the document's current maximum, atBottom() holds.
      evaluationFrame = requestAnimationFrame(() => {
        evaluationFrame = undefined;
        userScrolled.current = true;
        stick.current = atBottom();
        setAwayFromBottom(!stick.current);
        scheduleSave(stick.current);
      });
    };
    const onScroll = () => {
      if (atMarker(window.scrollY)) {
        // Echo of our own (or the virtualizer's) marked jump: the browser
        // dispatches the scroll event after layout, when row measurements may
        // already have changed the document height, so its position can look
        // like the reader left the bottom. Trust the jump's intent instead.
        scheduleSave(stick.current);
        return;
      }
      // Not a marked jump: either the reader scrolled or the browser clamped an
      // intermediate position while rows were being measured. A clamp always
      // lands exactly at the document's current maximum, so the deferred
      // re-check keeps bottom-follow alive unless the reader truly moved away.
      scheduleEvaluation();
    };
    const onResize = () => {
      // Only re-jump while following and the reader is still at the previous
      // jump target (or at the bottom): a scroll that arrived between the jump
      // and this resize is the reader's own and must not be yanked back.
      if (stick.current && (atBottom() || atMarker(window.scrollY))) scrollToBottom();
    };
    const onPageHide = () => {
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      save(atBottom());
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onPageHide();
    };
    const observer = new ResizeObserver(onResize);

    observer.observe(root);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("visibilitychange", onVisibilityChange);
      if (evaluationFrame !== undefined) cancelAnimationFrame(evaluationFrame);
      if (saveTimer !== undefined) clearTimeout(saveTimer);
    };
  }, [root]);

  useLayoutEffect(() => {
    latestBeforeCursor.current = dep?.snapshot.history.beforeCursor ?? null;
    if (stick.current) {
      if (dep === null) return;
      // The bottom jump is deferred past the initial measurement wave (see
      // INITIAL_JUMP_DELAY_MS) so it never overshoots a document that is still
      // shrinking below the per-row estimate; the resize observer re-jumps
      // immediately for any growth that arrives while the timer waits.
      if (initialJumpTimer.current === undefined) {
        initialJumpTimer.current = setTimeout(() => {
          initialJumpTimer.current = undefined;
          if (stick.current) scrollToBottom();
        }, INITIAL_JUMP_DELAY_MS);
      }
      return;
    }
    if (pendingRestore.current === null || dep === null) return;
    // Restore the persisted position once real content exists, then re-apply it
    // after the initial row measurements settle so the reloaded view matches the
    // saved one instead of a pre-measurement estimate.
    restoreBeforeCursor.current = dep.snapshot.history.beforeCursor;
    jumpTo(pendingRestore.current);
    setAwayFromBottom(
      window.scrollY < document.documentElement.scrollHeight - window.innerHeight - 2,
    );
    if (restoreTimer.current === undefined) {
      restoreTimer.current = setTimeout(() => {
        restoreTimer.current = undefined;
        // A history page prepended during the settle window re-anchors the
        // viewport to the same rows; re-applying the old document coordinate
        // would then land on different content.
        if (
          userScrolled.current ||
          pendingRestore.current === null ||
          restoreBeforeCursor.current !== latestBeforeCursor.current
        )
          return;
        jumpTo(pendingRestore.current);
        pendingRestore.current = null;
      }, RESTORE_SETTLE_MS);
    }
  }, [dep]);

  useEffect(
    () => () => {
      if (restoreTimer.current !== undefined) clearTimeout(restoreTimer.current);
      if (initialJumpTimer.current !== undefined) clearTimeout(initialJumpTimer.current);
    },
    [],
  );

  return { awayFromBottom, scrollToBottom };
}

// Command palette: a small centered dialog (Cmd/Ctrl+K) that lists every display
// preference from PREFS and flips it. It reuses PrefsContext for both the current
// state and the toggle, so no additional persistence lives here.
function CommandPalette({ onClose }: { onClose: () => void }) {
  const { prefs, toggle } = useContext(PrefsContext);
  const [active, setActive] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusItem = (index: number) => itemRefs.current[index]?.focus();

  useLayoutEffect(() => {
    focusItem(0);
  }, []);

  const move = (delta: number) => {
    const next = (active + delta + PREFS.length) % PREFS.length;
    setActive(next);
    focusItem(next);
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Tab") {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  };

  return (
    <div
      class="palette-backdrop"
      onMouseDown={(event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
        onKeyDown={onKeyDown}
      >
        <div class="palette-title" id="palette-title">
          Display settings
        </div>
        <ul class="palette-list">
          {PREFS.map((pref, index) => (
            <li key={pref.key}>
              <button
                ref={(element: HTMLButtonElement | null) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                tabindex={index === active ? 0 : -1}
                aria-pressed={prefs[pref.key] ? "true" : "false"}
                class={`palette-item ${prefs[pref.key] ? "on" : "off"}`}
                onFocus={() => setActive(index)}
                onClick={() => toggle(pref.key)}
              >
                <span class="palette-item-label">{pref.label}</span>
                <span class="palette-item-key">
                  <kbd>{pref.hotkey}</kbd>
                </span>
                <span class="palette-item-state">{prefs[pref.key] ? "shown" : "hidden"}</span>
              </button>
            </li>
          ))}
        </ul>
        <div class="palette-hint">↑↓ move · enter toggle · esc close</div>
      </div>
    </div>
  );
}

type ModelControlTarget =
  | { type: "set-model"; provider: string; modelId: string }
  | { type: "set-thinking"; thinkingLevel: ThinkingLevel };

// Canonical order of thinking levels. A session advertises any ordered subset of
// these; the slider always presents its stops low-to-high in this order.
const THINKING_ORDER: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// The dialog never mirrors a change locally: the selected model and thinking level
// are read straight from session metadata, so the visible state always matches what
// the session confirmed. A rejected change leaves the dialog open and is announced
// once through the off-screen live region; an unconfirmed (retryable) result stays
// silent, matching the controller's retry semantics.
function ModelControlDialog({
  snapshot,
  submit,
  onClose,
}: {
  snapshot: Snapshot;
  submit: SessionController["submitModelControl"];
  onClose: () => void;
}) {
  const capability = snapshot.modelControl!;
  const models = capability.models;
  const levels = THINKING_ORDER.filter((level) => capability.thinkingLevels.includes(level));
  // Focus order: each model row, then the single thinking slider as the last item.
  const itemKeys = [
    ...models.map((model) => JSON.stringify([model.provider, model.id])),
    "\0thinking",
  ];
  const sliderIndex = models.length;
  const signature = JSON.stringify(itemKeys);
  const metadata = snapshot.metadata;
  const isCurrentModel = (provider: string, id: string) =>
    metadata?.model?.provider === provider && metadata.model.id === id;
  const currentModelIndex = models.findIndex((model) => isCurrentModel(model.provider, model.id));
  const [active, setActive] = useState(() => Math.max(0, currentModelIndex));
  const [rejection, setRejection] = useState("");
  const [authoritativeAnnouncement, setAuthoritativeAnnouncement] = useState("");
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const previousKeysRef = useRef<readonly string[]>([]);
  const previousAuthoritativeRef = useRef("");

  const selectedLevelIndex = Math.max(
    0,
    metadata?.thinkingLevel ? levels.indexOf(metadata.thinkingLevel) : -1,
  );
  const selectedLevel = levels[selectedLevelIndex];

  // A capability change that removes the focused item lands focus on whichever item
  // now holds its old index (or the last surviving one), keeping exactly one item in
  // the tab order across the shrink.
  const previousActiveKey = previousKeysRef.current[active];
  const survivingActive = previousActiveKey ? itemKeys.indexOf(previousActiveKey) : -1;
  const normalizedActive =
    survivingActive >= 0 ? survivingActive : Math.min(active, itemKeys.length - 1);

  useLayoutEffect(() => {
    setActive(normalizedActive);
    itemRefs.current.length = itemKeys.length;
    itemRefs.current[normalizedActive]?.focus();
    previousKeysRef.current = itemKeys;
  }, [signature]);

  const authoritativeModel = metadata?.model
    ? `${metadata.model.provider}/${metadata.model.id}`
    : "";
  const authoritativeModelKey = metadata?.model
    ? JSON.stringify([metadata.model.provider, metadata.model.id])
    : "";
  const authoritativeState = `${authoritativeModelKey}\0${selectedLevel}`;
  useEffect(() => {
    const previous = previousAuthoritativeRef.current;
    previousAuthoritativeRef.current = authoritativeState;
    if (!previous) return;
    const [previousModelKey, previousLevel] = previous.split("\0");
    const announcements: string[] = [];
    if (authoritativeModel && authoritativeModelKey !== previousModelKey)
      announcements.push(`Model ${authoritativeModel}`);
    if (selectedLevel && selectedLevel !== previousLevel)
      announcements.push(`Thinking level ${selectedLevel}`);
    if (announcements.length) setAuthoritativeAnnouncement(announcements.join(". "));
  }, [authoritativeState]);

  useLayoutEffect(() => {
    if (currentModelIndex < 0) return;
    setActive(currentModelIndex);
    const current = itemRefs.current[currentModelIndex];
    current?.focus({ preventScroll: true });
    current?.scrollIntoView({ block: "nearest" });
  }, [authoritativeModelKey, currentModelIndex]);

  const focusItem = (index: number) => {
    const next = Math.max(0, Math.min(index, itemKeys.length - 1));
    setActive(next);
    itemRefs.current[next]?.focus();
  };
  const choose = async (target: ModelControlTarget) => {
    const result = await submit(target);
    // Announce only an authoritative rejection; an unconfirmed result is retryable
    // and stays silent so the reader is never told a change failed when it may not
    // have. The selected value never moves optimistically — it follows metadata.
    setRejection(!result.accepted && !result.ambiguous ? result.error || "Change rejected" : "");
  };
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      focusItem(
        event.shiftKey
          ? (normalizedActive - 1 + itemKeys.length) % itemKeys.length
          : (normalizedActive + 1) % itemKeys.length,
      );
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const key = event.key.toLowerCase();
    const modelDelta =
      key === "arrowdown" || key === "j" ? 1 : key === "arrowup" || key === "k" ? -1 : 0;
    if (modelDelta) {
      event.preventDefault();
      const currentIndex = models.findIndex((model) => isCurrentModel(model.provider, model.id));
      const nextIndex =
        currentIndex < 0
          ? modelDelta > 0
            ? 0
            : models.length - 1
          : (currentIndex + modelDelta + models.length) % models.length;
      if (nextIndex !== currentIndex) {
        const model = models[nextIndex];
        void choose({ type: "set-model", provider: model.provider, modelId: model.id });
      }
      return;
    }

    let levelIndex: number | undefined;
    if (key === "arrowright" || key === "l")
      levelIndex = Math.min(selectedLevelIndex + 1, levels.length - 1);
    else if (key === "arrowleft" || key === "h") levelIndex = Math.max(selectedLevelIndex - 1, 0);
    else if (event.key === "Home") levelIndex = 0;
    else if (event.key === "End") levelIndex = levels.length - 1;
    if (levelIndex !== undefined) {
      event.preventDefault();
      if (levelIndex !== selectedLevelIndex)
        void choose({ type: "set-thinking", thinkingLevel: levels[levelIndex] });
    }
  };

  return (
    <div
      class="palette-backdrop"
      onMouseDown={(event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="palette model-control-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-control-title"
        onKeyDown={onKeyDown}
      >
        <div class="palette-title" id="model-control-title">
          Model settings
        </div>
        <div class="model-control-section-label" id="model-control-model-label">
          Model
        </div>
        <ul class="palette-list model-control-list" aria-labelledby="model-control-model-label">
          {models.map((model, index) => {
            const current = isCurrentModel(model.provider, model.id);
            return (
              <li key={itemKeys[index]}>
                <button
                  ref={(element) => (itemRefs.current[index] = element)}
                  type="button"
                  class={`palette-item model-control-model ${current ? "current" : ""}`}
                  tabindex={index === normalizedActive ? 0 : -1}
                  aria-current={current ? "true" : undefined}
                  onFocus={() => setActive(index)}
                  onClick={() => {
                    if (!current)
                      void choose({
                        type: "set-model",
                        provider: model.provider,
                        modelId: model.id,
                      });
                  }}
                >
                  <span class="model-control-identity">{`${model.provider}/${model.id}`}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div
          class="model-control-section-label model-control-thinking-label"
          id="model-control-thinking-label"
        >
          Thinking
        </div>
        <div
          ref={(element) => (itemRefs.current[sliderIndex] = element)}
          class="thinking-slider"
          role="slider"
          tabindex={sliderIndex === normalizedActive ? 0 : -1}
          aria-labelledby="model-control-thinking-label"
          aria-valuemin={0}
          aria-valuemax={levels.length - 1}
          aria-valuenow={selectedLevelIndex}
          aria-valuetext={selectedLevel}
          data-thinking-level={selectedLevel}
          onFocus={() => setActive(sliderIndex)}
        >
          <div class="thinking-slider-track" aria-hidden="true">
            <span
              class="thinking-slider-fill"
              style={{
                width:
                  levels.length === 1
                    ? "0"
                    : `calc((100% - 26px) * ${selectedLevelIndex / (levels.length - 1)})`,
              }}
            />
            {levels.map((level, index) => (
              <span
                key={level}
                data-thinking-level={level}
                class={`thinking-slider-stop ${index <= selectedLevelIndex ? "filled" : ""} ${
                  index === selectedLevelIndex ? "selected" : ""
                }`}
                onClick={() => {
                  if (index !== selectedLevelIndex)
                    void choose({ type: "set-thinking", thinkingLevel: level });
                }}
              />
            ))}
          </div>
          <span class="thinking-slider-value" aria-hidden="true">
            {selectedLevel}
          </span>
        </div>
        <div class="model-control-live" role="alert" aria-live="assertive">
          {rejection}
        </div>
        <div class="model-control-live" role="status" aria-live="polite">
          {authoritativeAnnouncement}
        </div>
        <div class="palette-hint">↑↓ / jk model · ←→ / hl level · esc close</div>
      </div>
    </div>
  );
}

// Keyboard shortcut cheat sheet (`?`): a centered dialog listing every shortcut.
// General rows are static; the display-preference rows derive from PREFS like the
// command palette and toggle the same persisted state.
const GENERAL_SHORTCUTS: readonly { label: string; keys: readonly (readonly string[])[] }[] = [
  { label: "Send message / steer a running turn", keys: [["Option", "Enter"]] },
  {
    label: "Send message / queue a follow-up",
    keys: [
      ["Ctrl", "Enter"],
      ["Cmd", "Enter"],
    ],
  },
  { label: "Dismiss completions, then unfocus the input", keys: [["Escape"]] },
  { label: "Focus the message input", keys: [["i"]] },
  { label: "Choose model and thinking", keys: [["Option", "M"]] },
  { label: "Open this cheat sheet", keys: [["?"]] },
  {
    label: "Open the display settings palette",
    keys: [
      ["Ctrl", "K"],
      ["Cmd", "K"],
    ],
  },
];

function CheatSheet({ onClose }: { onClose: () => void }) {
  const { prefs, toggle } = useContext(PrefsContext);

  // The dialog opens without stealing focus (Escape closes it via the
  // document-level keydown handler in App). It stays focusable with tabindex -1
  // for keyboard users who choose to move focus into it.
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ];
    if (!focusable.length) return;
    const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.shiftKey ? -1 : 1;
    const next =
      focusable[index === -1 ? 0 : (index + delta + focusable.length) % focusable.length];
    event.preventDefault();
    next.focus();
  };

  return (
    <div
      class="cheatsheet-backdrop"
      onMouseDown={(event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="cheatsheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cheatsheet-title"
        tabindex={-1}
        onKeyDown={onKeyDown}
      >
        <div class="cheatsheet-title" id="cheatsheet-title">
          Keyboard shortcuts
        </div>
        <ul class="cheatsheet-list">
          {GENERAL_SHORTCUTS.map((row) => (
            <li key={row.label} class="cheatsheet-row">
              <span class="cheatsheet-row-label">{row.label}</span>
              <span class="cheatsheet-keys">
                {row.keys.map((chord, chordIndex) => (
                  <span class="cheatsheet-chord" key={chord.join("+")}>
                    {chordIndex > 0 ? <span class="cheatsheet-or">or</span> : null}
                    {chord.map((key, index) => (
                      <span key={key}>
                        {index > 0 ? <span class="cheatsheet-plus">+</span> : null}
                        <kbd>{key}</kbd>
                      </span>
                    ))}
                  </span>
                ))}
              </span>
            </li>
          ))}
          {PREFS.map((pref) => (
            <li key={pref.key}>
              <button
                type="button"
                aria-pressed={prefs[pref.key] ? "true" : "false"}
                class={`palette-item ${prefs[pref.key] ? "on" : "off"}`}
                onClick={() => toggle(pref.key)}
              >
                <span class="palette-item-label">{pref.label}</span>
                <span class="palette-item-key">
                  <kbd>{pref.hotkey}</kbd>
                </span>
                <span class="palette-item-state">{prefs[pref.key] ? "shown" : "hidden"}</span>
              </button>
            </li>
          ))}
        </ul>
        <div class="cheatsheet-hint">esc close · preference rows toggle</div>
      </div>
    </div>
  );
}

function resizeComposerInput(element: HTMLTextAreaElement | null | undefined) {
  if (!element || (matchMedia("(max-width: 640px)").matches && element.matches(":focus"))) return;
  element.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(element).maxHeight);
  const height = Number.isFinite(maxHeight)
    ? Math.min(element.scrollHeight, maxHeight)
    : element.scrollHeight;
  element.style.height = `${height}px`;
  element.style.overflowY =
    Number.isFinite(maxHeight) && element.scrollHeight > maxHeight ? "auto" : "hidden";
}

interface DraftAttachment extends OutboundImageAttachment {
  id: string;
  name: string;
  bytes: Uint8Array;
}

function draftIdentity(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function base64(bytes: Uint8Array): string {
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    value += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(value);
}

const ATTACHMENT_ERRORS: Record<string, string> = {
  "unsupported-format": "Only PNG, JPEG, and non-animated WebP images are supported",
  "signature-mismatch": "The image contents do not match its file type",
  "animated-image": "Animated images are not supported",
  "image-too-large": "The image is too large",
  "dimensions-exceeded": "The image dimensions are too large",
  "pixels-exceeded": "The image has too many pixels",
  "count-exceeded": "Too many images are attached",
  "aggregate-bytes-exceeded": "The attached images are too large together",
  "invalid-data": "The image could not be read",
};

function AttachmentPreview({ attachment }: { attachment: DraftAttachment }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const scale = Math.min(96 / attachment.width, 64 / attachment.height, 1);
    const width = Math.max(1, Math.round(attachment.width * scale));
    const height = Math.max(1, Math.round(attachment.height * scale));
    const bytes = attachment.bytes.slice().buffer;
    void createImageBitmap(new Blob([bytes], { type: attachment.mimeType }), {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "high",
    })
      .then((bitmap) => {
        if (cancelled || !canvas.current) {
          bitmap.close();
          return;
        }
        canvas.current.width = width;
        canvas.current.height = height;
        canvas.current.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [attachment.id]);
  return <canvas ref={canvas} class="composer-attachment-preview" aria-hidden="true"></canvas>;
}

function PendingInputRow({
  item,
  index,
  total,
  capability,
  mutate,
  onRemoved,
}: {
  item: PendingInput;
  index: number;
  total: number;
  capability: PendingInputBrokerCapability | undefined;
  mutate: SessionController["mutatePendingInput"];
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editingVersion, setEditingVersion] = useState<number>();
  const [draft, setDraft] = useState(item.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  const editTextarea = useRef<HTMLTextAreaElement>(null);
  const canEdit = Boolean(
    capability?.edit && item.editable !== false && item.state !== "releasing" && item.itemVersion,
  );
  const canRemove = Boolean(
    capability?.remove && item.editable !== false && item.state !== "releasing" && item.itemVersion,
  );
  const label = `${item.delivery === "followUp" ? "Queued follow-up" : "Steer"} message ${index + 1} of ${total}`;
  const actionLabel = `pending message ${index + 1} of ${total}`;

  useEffect(() => {
    if (editing) requestAnimationFrame(() => editTextarea.current?.focus());
  }, [editing]);

  const beginEdit = () => {
    setDraft(item.content);
    setEditingVersion(item.itemVersion);
    setError("");
    setEditing(true);
  };
  const cancelEdit = () => {
    setDraft(item.content);
    setEditingVersion(undefined);
    setError("");
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const save = async () => {
    if (!editingVersion || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await mutate(item.id, editingVersion, "edit", draft);
      if (result.accepted) {
        setEditingVersion(undefined);
        setEditing(false);
        requestAnimationFrame(() => editButton.current?.focus());
      } else {
        if (result.reason === "stale-item") setEditingVersion(item.itemVersion);
        setError(result.error || "Message could not be edited; review and retry.");
        requestAnimationFrame(() => editTextarea.current?.focus());
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Message could not be edited; review and retry.",
      );
      requestAnimationFrame(() => editTextarea.current?.focus());
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!item.itemVersion || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await mutate(item.id, item.itemVersion, "remove");
      if (!result.accepted) setError(result.error || "Message could not be removed; retry.");
      else onRemoved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Message could not be removed; retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      class="composer-pending-row"
      role="listitem"
      aria-label={`${label}: ${item.content || "image attachment"}`}
      aria-busy={busy ? "true" : "false"}
    >
      <span class={`composer-pending-kind ${item.delivery}`}>
        {item.delivery === "followUp" ? "queue" : "steer"}
      </span>
      {editing ? (
        <div class="composer-pending-edit">
          <textarea
            ref={editTextarea}
            class="composer-pending-input"
            aria-label={`Edit ${label}`}
            value={draft}
            disabled={busy}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelEdit();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <div class="composer-pending-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={busy} onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <span class="composer-pending-text">
          {item.content || "Image attachment"}
          {item.attachmentCount ? (
            <span class="composer-pending-attachments">
              {item.attachmentCount} image{item.attachmentCount === 1 ? "" : "s"} attached
            </span>
          ) : null}
        </span>
      )}
      {!editing && capability && item.editable !== false ? (
        <div class="composer-pending-actions">
          <button
            ref={editButton}
            type="button"
            disabled={!canEdit || busy}
            title={canEdit ? `Edit ${actionLabel}` : "This message is no longer editable"}
            aria-label={`Edit ${actionLabel}`}
            onClick={beginEdit}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={!canRemove || busy}
            title={canRemove ? `Remove ${actionLabel}` : "This message is no longer removable"}
            aria-label={`Remove ${actionLabel}`}
            onClick={() => void remove()}
          >
            Remove
          </button>
        </div>
      ) : null}
      {error ? (
        <span class="composer-pending-error" role="status" aria-live="polite">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface ComposerProps {
  snapshot: Snapshot;
  connection: ConnectionStatus;
  submit: SessionController["submit"];
  mutatePendingInput: SessionController["mutatePendingInput"];
  complete: SessionController["complete"];
  commandCompletions: SessionController["commandCompletions"];
  onOpenModelControl: () => void;
  onAccepted: () => void;
}

function Composer({
  snapshot,
  connection,
  submit,
  mutatePendingInput,
  complete,
  commandCompletions,
  onOpenModelControl,
  onAccepted,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [draggingImages, setDraggingImages] = useState(false);
  const [ingestingImages, setIngestingImages] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [lastCommandId, setLastCommandId] = useState<string>();
  const [target, setTarget] = useState<CompletionTarget | undefined>();
  const [items, setItems] = useState<CompletionItem[]>([]);
  const [itemsTarget, setItemsTarget] = useState("");
  const [active, setActive] = useState(0);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const sendMenu = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const draftRef = useRef("");
  const attachmentsRef = useRef<DraftAttachment[]>([]);
  const ingestionActiveRef = useRef(false);
  const draftIdentityRef = useRef(draftIdentity());
  const requestSequence = useRef(0);
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>();
  const suppressPrimaryClick = useRef(false);
  const online = connection === "online";
  const metadata = snapshot.metadata;
  const attachmentCapability = snapshot.imageAttachments;

  const replaceAttachments = (next: DraftAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
    draftIdentityRef.current = draftIdentity();
  };

  const ingestFilesNow = async (files: readonly File[]) => {
    if (!attachmentCapability) {
      setNotice("Image attachments are not available for this model");
      return;
    }
    const next = [...attachmentsRef.current];
    let totalBytes = next.reduce((sum, item) => sum + item.byteLength, 0);
    let totalPixels = next.reduce((sum, item) => sum + item.width * item.height, 0);
    let rejection = "";
    for (const file of files) {
      if (next.length >= attachmentCapability.maxAttachments) {
        rejection = ATTACHMENT_ERRORS["count-exceeded"];
        break;
      }
      if (!attachmentCapability.supportedMimeTypes.some((mimeType) => mimeType === file.type)) {
        rejection = ATTACHMENT_ERRORS["unsupported-format"];
        continue;
      }
      if (file.size > attachmentCapability.maxBytesPerImage) {
        rejection = ATTACHMENT_ERRORS["image-too-large"];
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspected = inspectRasterImage(bytes, file.type);
      if (typeof inspected === "string") {
        rejection = ATTACHMENT_ERRORS[inspected];
        continue;
      }
      const pixels = inspected.width * inspected.height;
      if (
        inspected.width > attachmentCapability.maxWidth ||
        inspected.height > attachmentCapability.maxHeight
      ) {
        rejection = ATTACHMENT_ERRORS["dimensions-exceeded"];
        continue;
      }
      if (
        pixels > attachmentCapability.maxPixels ||
        totalPixels + pixels > attachmentCapability.maxTotalPixels
      ) {
        rejection = ATTACHMENT_ERRORS["pixels-exceeded"];
        continue;
      }
      if (totalBytes + bytes.length > attachmentCapability.maxTotalBytes) {
        rejection = ATTACHMENT_ERRORS["aggregate-bytes-exceeded"];
        continue;
      }
      next.push({
        type: "image-attachment",
        id: draftIdentity(),
        name: file.name || "image",
        mimeType: inspected.mimeType,
        width: inspected.width,
        height: inspected.height,
        byteLength: bytes.length,
        data: base64(bytes),
        bytes,
      });
      totalBytes += bytes.length;
      totalPixels += pixels;
    }
    if (next.length !== attachmentsRef.current.length) replaceAttachments(next);
    if (rejection) setNotice(rejection);
  };

  const ingestFiles = async (files: readonly File[]): Promise<void> => {
    if (!attachmentCapability) {
      setNotice("Image attachments are not available for this model");
      return;
    }
    if (ingestionActiveRef.current) {
      setNotice("Wait for the current images to finish loading");
      return;
    }
    const remainingCount = attachmentCapability.maxAttachments - attachmentsRef.current.length;
    const remainingBytes =
      attachmentCapability.maxTotalBytes -
      attachmentsRef.current.reduce((sum, item) => sum + item.byteLength, 0);
    if (files.length === 0) return;
    if (files.length > remainingCount) {
      setNotice(ATTACHMENT_ERRORS["count-exceeded"]);
      return;
    }
    let candidateBytes = 0;
    for (const file of files) {
      if (file.size > attachmentCapability.maxBytesPerImage) {
        setNotice(ATTACHMENT_ERRORS["image-too-large"]);
        return;
      }
      candidateBytes += file.size;
      if (candidateBytes > remainingBytes) {
        setNotice(ATTACHMENT_ERRORS["aggregate-bytes-exceeded"]);
        return;
      }
    }
    ingestionActiveRef.current = true;
    setIngestingImages(true);
    try {
      await ingestFilesNow(files);
    } catch {
      setNotice("The image could not be read");
    } finally {
      ingestionActiveRef.current = false;
      setIngestingImages(false);
    }
  };

  useEffect(() => {
    if (attachmentsRef.current.length > 0 && !attachmentCapability)
      setNotice("Image attachments are not available for this model");
  }, [attachmentCapability]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const key = completionTargetKey(target);
    setItems([]);
    setItemsTarget("");
    if (!target || !online) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      complete(target.token, controller.signal)
        .then((completionItems) => {
          if (requestSequence.current !== sequence) return;
          setItems(Array.isArray(completionItems) ? completionItems.slice(0, 20) : []);
          setItemsTarget(key);
          setActive(0);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [target?.token, target?.start, online]);

  useEffect(() => {
    if (!lastCommandId) return;
    const completion = commandCompletions.get(lastCommandId);
    if (!completion) return;
    setNotice(completion.status === "completed" ? "Completed" : completion.error);
  }, [commandCompletions, lastCommandId]);

  useLayoutEffect(() => {
    optionRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useLayoutEffect(() => {
    resizeComposerInput(textarea.current);
  }, [draft]);

  useLayoutEffect(() => {
    if (sendMenuOpen) {
      sendMenu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  }, [sendMenuOpen]);

  useEffect(() => {
    if (!sendMenuOpen) return undefined;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setSendMenuOpen(false);
        sendButton.current?.focus();
      } else if (!composer.current?.contains(asNode(event.target))) {
        setSendMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [sendMenuOpen]);

  useEffect(() => {
    if (!textarea.current) return undefined;
    let inputWidth = textarea.current.getBoundingClientRect().width;
    const inputObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === inputWidth) return;
      inputWidth = width;
      resizeComposerInput(textarea.current);
    });
    inputObserver.observe(textarea.current);
    return () => inputObserver.disconnect();
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const input = textarea.current;
    const shell = composer.current;
    const dock = shell?.closest(".composer-dock");
    if (!input || !dock) return undefined;
    const clear = () => {
      dock.classList.remove("mobile-expanded");
      document.documentElement.style.removeProperty("--mobile-viewport-top");
      document.documentElement.style.removeProperty("--mobile-viewport-height");
    };
    const update = () => {
      if (!dock.classList.contains("mobile-expanded")) return;
      const top = (viewport?.offsetTop ?? 0) + 9;
      const height = Math.max(0, (viewport?.height ?? window.innerHeight) - 18);
      document.documentElement.style.setProperty("--mobile-viewport-top", `${top}px`);
      document.documentElement.style.setProperty("--mobile-viewport-height", `${height}px`);
    };
    const expand = () => {
      dock.classList.add("mobile-expanded");
      update();
    };
    const collapseAfterFocus = () => {
      requestAnimationFrame(() => {
        if (!dock.contains(document.activeElement)) clear();
      });
    };
    input.addEventListener("focus", expand);
    dock.addEventListener("focusout", collapseAfterFocus);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      input.removeEventListener("focus", expand);
      dock.removeEventListener("focusout", collapseAfterFocus);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      clear();
    };
  }, []);

  const refreshTarget = (value: string, cursor: number | null) => {
    const next = completionTarget(value, cursor ?? 0);
    if (completionTargetKey(next) !== completionTargetKey(target)) {
      setItems([]);
      setItemsTarget("");
    }
    setTarget(next);
  };
  const selectCompletion = (item: CompletionItem) => {
    if (!target || itemsTarget !== completionTargetKey(target)) return;
    const directory = item.label.endsWith("/");
    const suffix = directory ? "" : " ";
    const consumeQuote = item.value.endsWith('"') && draft[target.end] === '"';
    const after = target.end + (consumeQuote ? 1 : 0);
    const next = `${draft.slice(0, target.start)}${item.value}${suffix}${draft.slice(after)}`;
    const quotedDirectory = directory && item.value.endsWith('"');
    const cursor = target.start + item.value.length + suffix.length - (quotedDirectory ? 1 : 0);
    draftRef.current = next;
    draftIdentityRef.current = draftIdentity();
    setDraft(next);
    setTarget(quotedDirectory ? completionTarget(next, cursor) : undefined);
    setItems([]);
    setItemsTarget("");
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  };

  const send = async (delivery: InputDelivery) => {
    suppressPrimaryClick.current = false;
    if (pending || ingestingImages || !online || (!draft.trim() && attachments.length === 0))
      return;
    if (attachments.length > 0 && !attachmentCapability) {
      setNotice("Image attachments are not available for this model");
      return;
    }
    const content = draft;
    const submittedAttachments = attachments;
    const submittedIdentity = draftIdentityRef.current;
    setPending(true);
    setNotice("");
    try {
      const result = await submit(
        content,
        delivery,
        submittedAttachments.map(({ type, mimeType, width, height, byteLength, data }) => ({
          type,
          mimeType,
          width,
          height,
          byteLength,
          data,
        })),
        submittedIdentity,
      );
      if (!result.accepted) throw new Error(result.error || "Message rejected");
      // Clear only for a matching accepted response and only if text and images stayed untouched.
      if (draftRef.current === content && draftIdentityRef.current === submittedIdentity) {
        draftRef.current = "";
        setDraft("");
        attachmentsRef.current = [];
        setAttachments([]);
        draftIdentityRef.current = draftIdentity();
        setTarget(undefined);
        setItems([]);
        setItemsTarget("");
      }
      setLastCommandId(result.commandId);
      const completion = commandCompletions.get(result.commandId);
      setNotice(
        completion
          ? completion.status === "completed"
            ? "Completed"
            : completion.error
          : delivery === "followUp"
            ? "Queued"
            : delivery === "steer"
              ? "Steered"
              : "Sent",
      );
      setSendMenuOpen(false);
      onAccepted();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message failed");
    } finally {
      setPending(false);
      textarea.current?.focus();
    }
  };

  const running = snapshot.isRunning;
  const canSend =
    !pending &&
    !ingestingImages &&
    online &&
    Boolean(draft.trim() || attachments.length) &&
    (attachments.length === 0 || Boolean(attachmentCapability));
  const primaryDelivery: InputDelivery = running ? "steer" : "immediate";
  const primaryLabel = pending ? "Sending message" : running ? "Steer message" : "Send message";
  const clearLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = undefined;
  };
  const openSendMenu = () => setSendMenuOpen(true);
  return (
    <footer
      ref={composer}
      class={`composer ${draggingImages ? "dragging-images" : ""}`}
      data-thinking-level={metadata?.thinkingLevel ?? "off"}
      onDragEnter={(event) => {
        if (!attachmentCapability || !event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        setDraggingImages(true);
      }}
      onDragOver={(event) => {
        if (!attachmentCapability || !event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingImages(false);
      }}
      onDrop={(event) => {
        if (!attachmentCapability || !event.dataTransfer?.types.includes("Files")) return;
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        setDraggingImages(false);
        void ingestFiles(files);
      }}
    >
      <div class="composer-border-label composer-border-label-left">
        <span>{contextLabel(metadata?.contextUsage)}</span>
        {metadata ? (
          <>
            <span class="composer-separator">·</span>
            <span
              aria-label={`Whole-session recorded spend: ${costLabel(metadata.sessionCost)}`}
              title="Recorded spend across the whole session tree"
            >
              {costLabel(metadata.sessionCost)}
            </span>
          </>
        ) : null}
      </div>
      {metadata?.model || snapshot.modelControl ? (
        snapshot.modelControl ? (
          <button
            type="button"
            class="composer-border-label composer-border-label-right composer-model-control"
            aria-label="Choose model and thinking"
            title={
              metadata?.model
                ? `${metadata.model.provider}/${metadata.model.id} · ${metadata.thinkingLevel ?? "thinking unavailable"}`
                : "Choose model and thinking"
            }
            onClick={onOpenModelControl}
          >
            <span>
              {metadata?.model
                ? `(${metadata.model.provider}) ${metadata.model.id}`
                : "model / thinking"}
            </span>
            {metadata?.thinkingLevel ? (
              <>
                <span class="composer-separator">·</span>
                <span class="composer-thinking">{metadata.thinkingLevel}</span>
              </>
            ) : null}
          </button>
        ) : (
          <div
            class="composer-border-label composer-border-label-right"
            title={`${metadata!.model!.provider}/${metadata!.model!.id}`}
          >
            <span>
              ({metadata!.model!.provider}) {metadata!.model!.id}
            </span>
            {metadata?.thinkingLevel ? (
              <>
                <span class="composer-separator">·</span>
                <span class="composer-thinking">{metadata.thinkingLevel}</span>
              </>
            ) : null}
          </div>
        )
      ) : null}
      {snapshot.pendingInputs?.length ? (
        <div class="composer-pending" role="list" aria-label="Pending messages">
          {snapshot.pendingInputs.map((item, index) => (
            <PendingInputRow
              key={item.id}
              item={item}
              index={index}
              total={snapshot.pendingInputs.length}
              capability={snapshot.pendingInputBroker}
              mutate={mutatePendingInput}
              onRemoved={() => textarea.current?.focus()}
            />
          ))}
        </div>
      ) : null}
      {attachments.length ? (
        <div class="composer-attachments" role="list" aria-label="Attached images">
          {attachments.map((attachment, index) => (
            <div
              class="composer-attachment"
              role="listitem"
              key={attachment.id}
              aria-label={`Image ${index + 1}, ${attachment.width} by ${attachment.height} pixels`}
            >
              <AttachmentPreview attachment={attachment} />
              <span class="composer-attachment-name" title={attachment.name}>
                {attachment.name}
              </span>
              <span class="composer-attachment-size">
                {attachment.width}×{attachment.height}
              </span>
              <button
                type="button"
                aria-label={`Remove image ${index + 1}`}
                onClick={() =>
                  replaceAttachments(
                    attachmentsRef.current.filter((item) => item.id !== attachment.id),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div class="composer-editor">
        {attachmentCapability ? (
          <input
            ref={fileInput}
            class="composer-file-input"
            type="file"
            multiple
            tabindex={-1}
            accept={attachmentCapability.supportedMimeTypes.join(",")}
            aria-label="Choose images"
            onChange={(event) => {
              void ingestFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
        ) : null}
        <textarea
          ref={textarea}
          class="composer-input"
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={items.length ? "composer-completions" : undefined}
          aria-activedescendant={items.length ? `composer-completion-${active}` : undefined}
          rows={1}
          value={draft}
          placeholder={running ? "Steer the running turn…" : "Send a prompt…"}
          disabled={!online}
          onClick={(event: JSX.TargetedMouseEvent<HTMLTextAreaElement>) =>
            refreshTarget(event.currentTarget.value, event.currentTarget.selectionStart)
          }
          onPaste={(event: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => {
            if (!attachmentCapability) return;
            const items = Array.from(event.clipboardData?.items ?? []);
            const files = items
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter(
                (file): file is File =>
                  file !== null &&
                  attachmentCapability.supportedMimeTypes.some(
                    (mimeType) => mimeType === file.type,
                  ),
              );
            if (!files.length) return;
            const exclusivelySupportedImages = items.every(
              (item) =>
                item.kind === "file" &&
                attachmentCapability.supportedMimeTypes.some((mimeType) => mimeType === item.type),
            );
            if (exclusivelySupportedImages) event.preventDefault();
            void ingestFiles(files);
          }}
          onSelect={(event: JSX.TargetedEvent<HTMLTextAreaElement>) =>
            refreshTarget(event.currentTarget.value, event.currentTarget.selectionStart)
          }
          onInput={(event: JSX.TargetedInputEvent<HTMLTextAreaElement>) => {
            resizeComposerInput(event.currentTarget);
            draftRef.current = event.currentTarget.value;
            draftIdentityRef.current = draftIdentity();
            setDraft(event.currentTarget.value);
            setNotice("");
            setLastCommandId(undefined);
            refreshTarget(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onKeyUp={(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Escape") {
              refreshTarget(event.currentTarget.value, event.currentTarget.selectionStart);
            }
          }}
          onKeyDown={(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && event.altKey) {
              event.preventDefault();
              void send(running ? "steer" : "immediate");
              return;
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send(running ? "followUp" : "immediate");
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              if (items.length) {
                setTarget(undefined);
                setItems([]);
              } else {
                textarea.current?.blur();
              }
              return;
            }
            if (!items.length) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActive((active + delta + items.length) % items.length);
            } else if (event.key === "Tab") {
              event.preventDefault();
              selectCompletion(items[active]);
            }
          }}
        ></textarea>
        {items.length ? (
          <ul id="composer-completions" class="composer-completions" role="listbox">
            {items.map((item, index) => (
              <li
                ref={(element: HTMLLIElement | null) => {
                  optionRefs.current[index] = element;
                }}
                id={`composer-completion-${index}`}
                key={item.value}
                role="option"
                aria-selected={index === active ? "true" : "false"}
                class={index === active ? "active" : ""}
                onMouseDown={(event: JSX.TargetedMouseEvent<HTMLLIElement>) =>
                  event.preventDefault()
                }
                onMouseEnter={() => setActive(index)}
                onClick={() => selectCompletion(item)}
              >
                <span>{item.label}</span>
                {item.description ? <small>{item.description}</small> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {attachmentCapability ? (
        <button
          type="button"
          class="composer-attach-button"
          aria-label="Add image"
          title="Add image"
          disabled={
            pending ||
            ingestingImages ||
            !online ||
            attachments.length >= attachmentCapability.maxAttachments
          }
          onClick={() => fileInput.current?.click()}
        >
          +
        </button>
      ) : null}
      <span
        class={`composer-notice ${notice && !/^(Sent|Steered|Queued|Completed)$/.test(notice) ? "error" : ""}`}
        aria-live="polite"
      >
        {notice}
      </span>
      <div class="composer-send-control">
        <button
          ref={sendButton}
          type="button"
          class="composer-button"
          aria-label={primaryLabel}
          title={primaryLabel}
          aria-haspopup="menu"
          aria-expanded={sendMenuOpen ? "true" : "false"}
          aria-disabled={canSend ? "false" : "true"}
          onClick={() => {
            if (suppressPrimaryClick.current) {
              suppressPrimaryClick.current = false;
              return;
            }
            if (canSend) void send(primaryDelivery);
          }}
          onContextMenu={(event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            openSendMenu();
          }}
          onKeyDown={(event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
            if (
              event.key === "ArrowDown" ||
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              openSendMenu();
            }
          }}
          onPointerDown={(event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            clearLongPress();
            longPressTimer.current = setTimeout(() => {
              suppressPrimaryClick.current = true;
              openSendMenu();
            }, 550);
          }}
          onPointerUp={() => {
            clearLongPress();
            setTimeout(() => {
              suppressPrimaryClick.current = false;
            }, 0);
          }}
          onPointerCancel={clearLongPress}
          onPointerLeave={clearLongPress}
        >
          <span aria-hidden="true">↑</span>
        </button>
        {sendMenuOpen ? (
          <div
            ref={sendMenu}
            class="composer-send-menu"
            role="menu"
            aria-label="Send options"
            onKeyDown={(event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              ];
              const index = buttons.findIndex((button) => button === document.activeElement);
              let next: HTMLButtonElement | undefined;
              if (event.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
              else if (event.key === "ArrowUp")
                next = buttons[(index - 1 + buttons.length) % buttons.length];
              else if (event.key === "Home") next = buttons[0];
              else if (event.key === "End") next = buttons.at(-1);
              else if (event.key === "Escape") {
                event.preventDefault();
                setSendMenuOpen(false);
                sendButton.current?.focus();
                return;
              }
              if (next) {
                event.preventDefault();
                next.focus();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!canSend}
              onClick={() => void send(running ? "steer" : "immediate")}
            >
              {running ? "Steer now" : "Send now"}
            </button>
            {running ? (
              <button
                type="button"
                role="menuitem"
                disabled={!canSend}
                onClick={() => void send("followUp")}
              >
                Queue follow-up
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div class="composer-border-label composer-cwd" title={metadata?.cwd || ""}>
        {cwdLabel(metadata)}
      </div>
    </footer>
  );
}

function exposeMetrics(metrics: SessionMetrics): void {
  (globalThis as { __webUiMetrics?: SessionMetrics }).__webUiMetrics = metrics;
}

export function App({
  root,
  transport,
}: {
  root: Element;
  transport: IncrementalSessionTransport;
}) {
  const renderStarted = performance.now();
  const controller = useSession(transport);
  const state = controller.state;
  const connection = controller.connection;
  const snapshot = useMemo<Snapshot>(
    () => (state ? selectShellSnapshot(state) : EMPTY_SNAPSHOT),
    [state],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [modelControlGeneration, setModelControlGeneration] = useState<string>();
  const paletteOpenRef = useRef(false);
  const cheatsheetOpenRef = useRef(false);
  const modelControlOpenRef = useRef(false);
  const modelControlReturnFocus = useRef<HTMLElement | null>(null);
  const modalOpenRef = useRef(false);
  const dock = useRef<HTMLDivElement>(null);
  const toolExpansionAnchor = useRef<(() => void) | null>(null);
  const preferences = usePreferences(modalOpenRef, (key) => {
    if (key === "tools") toolExpansionAnchor.current?.();
  });
  const disclosure = useDisclosureStore();
  const { awayFromBottom, scrollToBottom } = useStickToBottom(root, state);
  const sessionTitle = resolveSessionTitle(snapshot);

  // The global expand/collapse-all hotkeys drop per-kind overrides so every block
  // follows the new preference default again.
  useEffect(() => disclosure.clearPrefix("thinking:"), [preferences.prefs.thinking]);
  useEffect(() => disclosure.clearPrefix("tools:"), [preferences.prefs.tools]);

  useLayoutEffect(() => {
    recordTiming(controller.metrics, "renderCommit", performance.now() - renderStarted);
  });

  useEffect(() => {
    exposeMetrics(controller.metrics);
  }, [controller.metrics]);

  useEffect(() => {
    document.title = `π – ${sessionTitle}`;
  }, [sessionTitle]);

  // Load older history when the reader reaches the top, including an initial
  // non-scrollable window that would never emit a scroll event.
  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY < window.innerHeight) controller.loadOlder();
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [controller.loadOlder, state?.snapshot.history.beforeCursor]);

  useEffect(() => {
    if (!dock.current) return undefined;
    const update = () =>
      document.documentElement.style.setProperty(
        "--composer-height",
        `${dock.current?.getBoundingClientRect().height ?? 0}px`,
      );
    const observer = new ResizeObserver(update);
    observer.observe(dock.current);
    update();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--composer-height");
    };
  }, []);

  const closeModelControl = () => {
    setModelControlGeneration(undefined);
    requestAnimationFrame(() => {
      const previous = modelControlReturnFocus.current;
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>(".composer-input")?.focus();
    });
  };
  const openModelControl = () => {
    if (!state?.snapshot.modelControl || modelControlOpenRef.current) return;
    modelControlReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(false);
    setCheatsheetOpen(false);
    setModelControlGeneration(state.generation);
  };

  useLayoutEffect(() => {
    paletteOpenRef.current = paletteOpen;
    cheatsheetOpenRef.current = cheatsheetOpen;
    modelControlOpenRef.current = modelControlGeneration !== undefined;
    modalOpenRef.current = paletteOpen || cheatsheetOpen || modelControlGeneration !== undefined;
  }, [paletteOpen, cheatsheetOpen, modelControlGeneration]);

  // The dialog survives every model and thinking change within one session: those
  // arrive as command-epoch or metadata updates, which it reads live. It closes only
  // when the session's generation is replaced (a different session took over) or the
  // model-control capability disappears — plus Escape/backdrop inside the dialog.
  useEffect(() => {
    if (modelControlGeneration === undefined) return;
    if (state?.generation !== modelControlGeneration || !snapshot.modelControl) closeModelControl();
  }, [state?.generation, snapshot.modelControl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editable = isEditableTarget(event.target);
      if (
        !modalOpenRef.current &&
        !event.repeat &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === "KeyM"
      ) {
        event.preventDefault();
        openModelControl();
        return;
      }
      // The cheat sheet opens without taking focus, so Escape closes it at the
      // document level rather than from inside the dialog.
      if (cheatsheetOpenRef.current && event.key === "Escape") {
        event.preventDefault();
        setCheatsheetOpen(false);
        return;
      }
      const dialogOpen =
        paletteOpenRef.current || cheatsheetOpenRef.current || modelControlOpenRef.current;
      if (
        !dialogOpen &&
        !editable &&
        !event.repeat &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        document.querySelector<HTMLElement>(".composer-input")?.focus();
        return;
      }
      if (
        !dialogOpen &&
        !editable &&
        !event.repeat &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key === "?"
      ) {
        event.preventDefault();
        setCheatsheetOpen(true);
        return;
      }
      if (event.repeat || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey))
        return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (modelControlOpenRef.current) return;
      if (cheatsheetOpenRef.current) {
        setCheatsheetOpen(false);
        setPaletteOpen(true);
      } else {
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state?.generation, state?.snapshot.commandEpoch, snapshot.modelControl]);

  useTheme(snapshot.theme);

  return (
    <PrefsContext.Provider value={preferences}>
      <ImageUrlContext.Provider value={(reference) => transport.imageUrl(reference)}>
        <DisclosureContext.Provider value={disclosure}>
          <StatusBar title={sessionTitle} snapshot={snapshot} connection={connection} />
          <SystemPromptPanel snapshot={snapshot} />
          <Transcript
            toolExpansionAnchor={toolExpansionAnchor}
            persisted={state?.snapshot.entries ?? []}
            live={state?.snapshot.liveTail ?? []}
            loadingOlder={controller.loadingOlder}
            hasOlder={state?.snapshot.history.hasMore ?? false}
            onLoadOlder={controller.loadOlder}
          />
          <div ref={dock} class="composer-dock">
            {awayFromBottom ? (
              <button
                type="button"
                class="scroll-to-bottom"
                onClick={scrollToBottom}
                aria-label="Scroll to bottom"
              >
                ↓ bottom
              </button>
            ) : null}
            <Composer
              snapshot={snapshot}
              connection={connection}
              submit={controller.submit}
              mutatePendingInput={controller.mutatePendingInput}
              complete={controller.complete}
              commandCompletions={controller.commandCompletions}
              onOpenModelControl={openModelControl}
              onAccepted={() => setPaletteOpen(false)}
            />
          </div>
          {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
          {cheatsheetOpen ? <CheatSheet onClose={() => setCheatsheetOpen(false)} /> : null}
          {modelControlGeneration !== undefined && snapshot.modelControl ? (
            <ModelControlDialog
              snapshot={snapshot}
              submit={controller.submitModelControl}
              onClose={closeModelControl}
            />
          ) : null}
        </DisclosureContext.Provider>
      </ImageUrlContext.Provider>
    </PrefsContext.Provider>
  );
}
