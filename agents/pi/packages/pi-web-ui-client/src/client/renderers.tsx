// Transcript entry renderers: a Preact port of Pi's HTML exporter reduced to the
// single-column message list. Tool calls live in `./tools/`, one module per owning
// extension. Data is treated as untrusted throughout.
//
// The transcript is virtualized (transcript rows only) so mounted DOM stays bounded
// for multi-thousand-entry sessions. Because rows unmount/remount while scrolling,
// per-block expansion state lives in the `DisclosureContext` store keyed by a stable
// id rather than in each row's `useState`.

import { Component } from "preact";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { LiveEntry, PersistedEntry } from "../wire/protocol.ts";
import {
  array,
  formatTimestamp,
  images,
  parseSkillBlock,
  record,
  str,
  textContent,
} from "./format.ts";
import { markProgrammaticScroll } from "./scroll.ts";
import { Markdown } from "./markdown.tsx";
import { PrefsContext } from "./preferences.ts";
import {
  AgentflowResultMessage,
  BackgroundCompletionMessage,
  BackgroundMonitorEventMessage,
  ToolCall,
} from "./tools/index.tsx";
import {
  ExpandableOutput,
  ImageBlock,
  isPlainDisclosureClick,
  useDisclosure,
} from "./tools/shared.tsx";
import {
  indexBoundedTranscript,
  PersistedTranscriptIndex,
  type ToolResults,
} from "./transcript-index.ts";

function Timestamp({ ts }: { ts: unknown }) {
  const { prefs } = useContext(PrefsContext);
  if (!prefs.timestamps) return null;
  const value = formatTimestamp(ts);
  return value ? <div class="message-timestamp">{value}</div> : null;
}

/** A collapsed-by-default block with a one-line summary while closed. */
function Expandable({
  className,
  label,
  collapsed,
  dkey,
  children,
}: {
  className: string;
  label: ComponentChildren;
  collapsed: ComponentChildren;
  dkey: string;
  children?: ComponentChildren;
}) {
  const [open, setOpen] = useDisclosure(dkey, false);
  const toggle = () => setOpen(!open);
  return (
    <div
      class={`${className} clickable-disclosure`}
      onClick={(event) => {
        if (isPlainDisclosureClick(event)) toggle();
      }}
    >
      <button
        type="button"
        class="disclosure-toggle"
        aria-expanded={open ? "true" : "false"}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        <span class={`${className}-label`}>{label}</span>
        {open ? null : <span class={`${className}-collapsed`}>{collapsed}</span>}
      </button>
      {open ? children : null}
    </div>
  );
}

function ThinkingBlock({ text, dkey }: { text: string; dkey: string }) {
  const { prefs } = useContext(PrefsContext);
  const [open, setOpen] = useDisclosure(dkey, prefs.thinking);
  if (!open) {
    return (
      <button
        type="button"
        class="thinking-collapsed"
        aria-expanded="false"
        onClick={() => setOpen(true)}
      >
        thinking... (click to expand)
      </button>
    );
  }
  return (
    <div class="thinking-block">
      <button
        type="button"
        class="thinking-toggle"
        aria-expanded="true"
        aria-label="Collapse thinking"
        onClick={() => setOpen(false)}
      >
        thinking... (click to collapse)
      </button>
      <div class="thinking-text">
        <Markdown text={text} />
      </div>
    </div>
  );
}

function AssistantMessage({
  id,
  entry,
  results,
}: {
  id: string;
  entry: unknown;
  results: ToolResults;
}) {
  const e = record(entry);
  const content = array(record(e.message).content).map(record);
  return (
    <div class="assistant-message">
      <Timestamp ts={e.timestamp} />
      {content.map((block, index) => {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          return (
            <div key={index} class="assistant-text">
              <Markdown text={block.text} />
            </div>
          );
        }
        if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          return (
            <ThinkingBlock key={index} text={block.thinking} dkey={`thinking:${id}:${index}`} />
          );
        }
        return null;
      })}
      {content
        .filter((block) => block.type === "toolCall")
        .map((block, index) => {
          const callId = typeof block.id === "string" ? block.id : "";
          return (
            <ToolCall
              key={callId || index}
              name={str(block.name) || "unknown"}
              args={record(block.arguments)}
              result={results.get(callId)}
              dkey={`tools:${id}:${callId || index}`}
            />
          );
        })}
      {record(e.message).stopReason === "aborted" ? <div class="error-text">Aborted</div> : null}
      {record(e.message).stopReason === "error" ? (
        <div class="error-text">
          Error: {str(record(e.message).errorMessage) || "Unknown error"}
        </div>
      ) : null}
    </div>
  );
}

function UserMessage({ id, entry }: { id: string; entry: unknown }) {
  const e = record(entry);
  const content = record(e.message).content;
  const text = textContent(content);
  const attachedImages = images(content);
  const skill = parseSkillBlock(text);

  if (skill) {
    return (
      <div class="skill-user-entry">
        <Timestamp ts={e.timestamp} />
        <Expandable
          className="skill-invocation"
          label={`[skill] ${skill.name}`}
          collapsed={`${skill.name} (click to expand)`}
          dkey={`misc:${id}:skill`}
        >
          <div class="skill-invocation-content">
            <Markdown text={skill.content} />
          </div>
        </Expandable>
        {skill.userMessage || attachedImages.length ? (
          <div class="user-message">
            <ImageBlock list={attachedImages} cls="message-image" />
            {skill.userMessage ? <Markdown text={skill.userMessage} /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div class="user-message">
      <Timestamp ts={e.timestamp} />
      <ImageBlock list={attachedImages} cls="message-image" />
      {text.trim() ? <Markdown text={text} /> : null}
    </div>
  );
}

/** A `!`-prefixed shell command the user ran directly, not a `bash` tool call. */
function BashExecution({ id, entry }: { id: string; entry: unknown }) {
  const e = record(entry);
  const msg = record(e.message);
  const exitCode = msg.exitCode;
  const isError = msg.cancelled === true || (typeof exitCode === "number" && exitCode !== 0);
  return (
    <div class={`tool-execution ${isError ? "error" : "success"}`}>
      <Timestamp ts={e.timestamp} />
      <div class="tool-command">$ {str(msg.command)}</div>
      {msg.output ? (
        <ExpandableOutput text={str(msg.output) || ""} maxLines={10} dkey={`tools:${id}:out`} />
      ) : null}
      {msg.cancelled === true ? (
        <div class="tool-error">(cancelled)</div>
      ) : isError ? (
        <div class="tool-error">(exit {String(exitCode)})</div>
      ) : null}
    </div>
  );
}

/** An extension-injected message the extension asked to display. */
function CustomMessage({ id, entry }: { id: string; entry: unknown }) {
  const e = record(entry);
  const customType = str(e.customType);
  const details = e.details;
  const content = typeof e.content === "string" ? e.content : textContent(e.content);

  if (customType === "background-process-completion") {
    return (
      <div class="hook-message">
        <Timestamp ts={e.timestamp} />
        <BackgroundCompletionMessage details={details} dkey={`misc:${id}:bg-completion`} />
      </div>
    );
  }
  if (customType === "background-monitor-event") {
    return (
      <div class="hook-message">
        <Timestamp ts={e.timestamp} />
        <BackgroundMonitorEventMessage
          details={details}
          content={content}
          dkey={`misc:${id}:bg-monitor`}
        />
      </div>
    );
  }
  if (customType === "agentflow-result" && Object.keys(record(record(details).snapshot)).length) {
    return (
      <>
        <Timestamp ts={e.timestamp} />
        <AgentflowResultMessage details={details} dkey={`misc:${id}:agentflow-result`} />
      </>
    );
  }
  return (
    <div class="hook-message">
      <Timestamp ts={e.timestamp} />
      <div class="hook-type">[{customType}]</div>
      <Markdown text={content} />
    </div>
  );
}

function Entry({ id, entry, results }: { id: string; entry: unknown; results: ToolResults }) {
  const { prefs } = useContext(PrefsContext);
  const e = record(entry);

  if (e.type === "message") {
    const role = record(e.message).role;
    if (role === "user") return <UserMessage id={id} entry={entry} />;
    if (role === "assistant") return <AssistantMessage id={id} entry={entry} results={results} />;
    if (role === "bashExecution") return <BashExecution id={id} entry={entry} />;
    return null; // toolResult is rendered inside its tool call
  }

  if (e.type === "model_change") {
    if (!prefs.switches) return null;
    return (
      <div class="model-change">
        <Timestamp ts={e.timestamp} />
        Switched to model:{" "}
        <span class="model-name">
          {str(e.provider)}/{str(e.modelId)}
        </span>
      </div>
    );
  }

  if (e.type === "thinking_level_change") {
    if (!prefs.switches) return null;
    return (
      <div class="model-change">
        <Timestamp ts={e.timestamp} />
        Thinking level: <span class="model-name">{str(e.thinkingLevel)}</span>
      </div>
    );
  }

  if (e.type === "compaction") {
    const tokens = Number(e.tokensBefore || 0).toLocaleString();
    return (
      <Expandable
        className="compaction"
        label="[compaction]"
        collapsed={`Compacted from ${tokens} tokens`}
        dkey={`misc:${id}:compaction`}
      >
        <div class="compaction-content">{str(e.summary)}</div>
      </Expandable>
    );
  }

  if (e.type === "branch_summary") {
    return (
      <div class="branch-summary">
        <Timestamp ts={e.timestamp} />
        <div class="branch-summary-header">Branch Summary</div>
        <Markdown text={str(e.summary) || ""} />
      </div>
    );
  }

  if (e.type === "custom_message" && e.display) return <CustomMessage id={id} entry={entry} />;

  return null;
}

class EntryBoundary extends Component<
  { id: string; entry: unknown; results: ToolResults },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render(
    { id, entry, results }: { id: string; entry: unknown; results: ToolResults },
    { failed }: { failed: boolean },
  ) {
    if (failed) return <div class="hook-message">[Unsupported transcript entry]</div>;
    return <Entry id={id} entry={entry} results={results} />;
  }
}

function transcriptGap(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--line-height");
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 18;
}

interface GlobalToolAnchor {
  rowKey: string;
  rowIndex: number;
  headerIndex: number;
  viewportTop: number;
  frame: number | undefined;
  frames: number;
  stableFrames: number;
  deadline: number;
  cancelOnInput: (event: Event) => void;
}

export function Transcript({
  toolExpansionAnchor,
  persisted,
  live,
  loadingOlder = false,
  hasOlder = false,
  onLoadOlder,
}: {
  toolExpansionAnchor?: { current: (() => void) | null };
  persisted: readonly PersistedEntry[];
  live: readonly LiveEntry[];
  loadingOlder?: boolean;
  hasOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  const { prefs } = useContext(PrefsContext);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointerReadingLine = useRef<number | null>(null);
  const globalToolAnchor = useRef<GlobalToolAnchor | null>(null);
  const persistedIndexRef = useRef(new PersistedTranscriptIndex());

  const persistedIndex = useMemo(
    () => persistedIndexRef.current.update(persisted, prefs.switches),
    [persisted, prefs.switches],
  );
  // liveTail is independently bounded by the wire protocol, so scanning it on
  // replacement is predictable and avoids coupling transient identities to history.
  const liveIndex = useMemo(
    () => indexBoundedTranscript(live, "l", prefs.switches),
    [live, prefs.switches],
  );
  const results = useMemo<ToolResults>(
    () => ({
      get: (toolCallId) =>
        liveIndex.toolResults.get(toolCallId) ?? persistedIndex.toolResults.get(toolCallId),
    }),
    [persistedIndex, liveIndex],
  );

  const persistedRows = persistedIndex.rows;
  const liveRows = liveIndex.rows;
  const rowCount = persistedRows.length + liveRows.length;
  const rowAt = (index: number) =>
    index < persistedRows.length ? persistedRows[index] : liveRows[index - persistedRows.length];
  const rowIndexByKey = useMemo(
    () =>
      new Map([
        ...persistedRows.map((row, index) => [row.key, index] as const),
        ...liveRows.map((row, index) => [row.key, persistedRows.length + index] as const),
      ]),
    [persistedRows, liveRows],
  );
  const rowIndexByKeyRef = useRef(rowIndexByKey);
  rowIndexByKeyRef.current = rowIndexByKey;

  const gap = useMemo(transcriptGap, []);

  // The window virtualizer positions rows in document coordinates, so it needs the
  // transcript viewport's distance from the top of the document (its `offsetTop`)
  // as `scrollMargin`. That offset shifts whenever layout above the transcript
  // changes — the status bar, the toggleable system-prompt panel, or the
  // "Loading earlier messages…" status — so it is measured in a layout-safe effect
  // (synchronously, before paint) and kept reactive rather than read once at render.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const measure = () =>
      setScrollMargin((previous) => {
        const next = viewport.offsetTop;
        return previous === next ? previous : next;
      });
    measure();
    // Content above the transcript changes the offset by resizing the surrounding
    // layout; observe it so the margin tracks system-prompt/history-status changes.
    const observer = new ResizeObserver(measure);
    const parent = viewport.offsetParent ?? document.documentElement;
    if (parent instanceof Element) observer.observe(parent);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    const trackPointer = (event: PointerEvent) => {
      const viewport = viewportRef.current;
      pointerReadingLine.current =
        viewport && event.target instanceof Node && viewport.contains(event.target)
          ? event.clientY
          : null;
    };
    window.addEventListener("pointermove", trackPointer, { passive: true });
    return () => window.removeEventListener("pointermove", trackPointer);
  }, []);

  // Re-measure synchronously for the discrete layout changes this component drives.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport)
      setScrollMargin((previous) =>
        previous === viewport.offsetTop ? previous : viewport.offsetTop,
      );
  }, [loadingOlder, rowCount, prefs.systemPrompt]);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    // Conservative per-row estimate; every row is dynamically measured on mount.
    estimateSize: () => 96,
    overscan: 6,
    gap,
    getItemKey: (index) => rowAt(index)?.key ?? index,
    scrollMargin,
    anchorTo: "end",
    // App-level stickiness owns whether growth follows. The virtualizer cannot infer
    // that synchronously during an append without racing the latest window scroll.
    followOnAppend: false,
    // …and the virtualizer's own measurement compensations race the document's
    // committed layout: it can jump to a position computed from its measurement
    // cache before the DOM has grown to match, after which the browser clamps the
    // jump and nothing re-scrolls — the first open then rests a few entries above
    // the bottom. The end-anchoring branch is disabled below (its threshold is
    // never reachable), and the per-item compensation is disabled right after
    // creation (this virtual-core version reads that option from an instance
    // field it never assigns, so the option alone cannot disable it). The app's
    // stickiness then owns every measurement-driven scroll; the scrollToFn
    // override only routes the virtualizer's remaining scrolls (prepend anchors)
    // through the same programmatic marker the stickiness uses.
    scrollEndThreshold: -1,
    scrollToFn: (offset, options) => {
      // Round to device-pixel-safe integers so the emitted scroll event matches
      // the marked target exactly (the stickiness echo test tolerates 1px).
      const y = Math.round(offset + (options.adjustments ?? 0));
      markProgrammaticScroll(y);
      window.scrollTo({ top: y, behavior: options.behavior ?? "auto" });
    },
  });
  // Work around the virtual-core bug: resizeItem reads
  // `this.shouldAdjustScrollPositionOnItemSizeChange` (an instance field that is
  // never populated from the options), so set the field directly to disable the
  // per-item measurement compensation.
  (
    virtualizer as unknown as {
      shouldAdjustScrollPositionOnItemSizeChange?: () => boolean;
    }
  ).shouldAdjustScrollPositionOnItemSizeChange = () => false;

  const stopGlobalToolAnchor = (clearVirtualizerTarget = false) => {
    const anchor = globalToolAnchor.current;
    if (anchor?.frame !== undefined) cancelAnimationFrame(anchor.frame);
    if (anchor) {
      window.removeEventListener("wheel", anchor.cancelOnInput);
      window.removeEventListener("pointerdown", anchor.cancelOnInput);
      window.removeEventListener("touchstart", anchor.cancelOnInput);
      window.removeEventListener("keydown", anchor.cancelOnInput);
      if (clearVirtualizerTarget) virtualizer.scrollToOffset(window.scrollY);
    }
    globalToolAnchor.current = null;
  };
  const cancelGlobalToolAnchorOnInput = () => {
    stopGlobalToolAnchor(true);
    // Wheel/touch default scrolling happens after its listener. Clear any
    // scrollToIndex reconciliation again on the next frame at the user's new offset.
    requestAnimationFrame(() => virtualizer.scrollToOffset(window.scrollY));
  };
  const resolveAnchorIndex = (anchor: GlobalToolAnchor): number =>
    rowIndexByKeyRef.current.get(anchor.rowKey) ?? -1;
  const correctGlobalToolAnchor = () => {
    const anchor = globalToolAnchor.current;
    if (!anchor) return;
    anchor.frame = undefined;
    anchor.frames += 1;
    const rowIndex = resolveAnchorIndex(anchor);
    if (rowIndex < 0) {
      stopGlobalToolAnchor(true);
      return;
    }
    anchor.rowIndex = rowIndex;

    const row = viewportRef.current?.querySelector<HTMLElement>(
      `.message-row[data-index="${rowIndex}"]`,
    );
    const header = row
      ? Array.from(row.querySelectorAll<HTMLElement>(".tool-disclosure-toggle"), (toggle) =>
          toggle.parentElement instanceof HTMLElement ? toggle.parentElement : null,
        ).filter((element): element is HTMLElement => element !== null)[anchor.headerIndex]
      : undefined;

    if (!header) {
      // A large global reflow can move the focal row outside the mounted range
      // before its ResizeObserver measurement arrives. Re-mount it by stable
      // transcript index, then refine against the real header rectangle.
      virtualizer.scrollToIndex(rowIndex, { align: "start" });
      anchor.stableFrames = 0;
    } else {
      const delta = header.getBoundingClientRect().top - anchor.viewportTop;
      if (Math.abs(delta) > 0.5) {
        const target = Math.round(
          Math.max(
            0,
            Math.min(
              window.scrollY + delta,
              document.documentElement.scrollHeight - window.innerHeight,
            ),
          ),
        );
        if (Math.abs(target - window.scrollY) > 0.5) virtualizer.scrollToOffset(target);
        anchor.stableFrames = 0;
      } else {
        anchor.stableFrames += 1;
      }
    }

    if ((anchor.frames >= 30 && anchor.stableFrames >= 8) || performance.now() >= anchor.deadline) {
      stopGlobalToolAnchor(true);
      return;
    }
    anchor.frame = requestAnimationFrame(correctGlobalToolAnchor);
  };
  const captureGlobalToolAnchor = () => {
    stopGlobalToolAnchor(true);
    const viewport = viewportRef.current;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (!viewport || maxScroll <= 0 || maxScroll - window.scrollY <= 2) return;

    const composerTop = document
      .querySelector<HTMLElement>(".composer-dock")
      ?.getBoundingClientRect().top;
    const usableBottom = Math.max(
      0,
      Math.min(
        window.innerHeight,
        composerTop && composerTop > 0 ? composerTop : window.innerHeight,
      ),
    );
    const pointerY = pointerReadingLine.current;
    const readingLine =
      pointerY !== null && pointerY >= 0 && pointerY < usableBottom ? pointerY : usableBottom / 2;
    const headers = Array.from(
      viewport.querySelectorAll<HTMLElement>(".tool-disclosure-toggle"),
      (toggle) => toggle.parentElement,
    ).filter((header): header is HTMLElement => {
      if (!(header instanceof HTMLElement)) return false;
      const rect = header.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < usableBottom;
    });
    const header = headers.reduce<HTMLElement | null>((closest, candidate) => {
      if (!closest) return candidate;
      const candidateRect = candidate.getBoundingClientRect();
      const closestRect = closest.getBoundingClientRect();
      return Math.abs((candidateRect.top + candidateRect.bottom) / 2 - readingLine) <
        Math.abs((closestRect.top + closestRect.bottom) / 2 - readingLine)
        ? candidate
        : closest;
    }, null);
    const row = header?.closest<HTMLElement>(".message-row");
    const rowIndex = Number(row?.dataset.index);
    if (!header || !row || !Number.isInteger(rowIndex)) return;
    const rowHeaders = Array.from(
      row.querySelectorAll<HTMLElement>(".tool-disclosure-toggle"),
      (toggle) => toggle.parentElement,
    ).filter((element): element is HTMLElement => element instanceof HTMLElement);
    const headerIndex = rowHeaders.indexOf(header);
    if (headerIndex < 0) return;

    const rowKey = rowAt(rowIndex)?.key;
    if (!rowKey) return;
    const cancelOnInput = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      )
        return;
      cancelGlobalToolAnchorOnInput();
    };
    globalToolAnchor.current = {
      rowKey,
      rowIndex,
      headerIndex,
      viewportTop: header.getBoundingClientRect().top,
      frame: requestAnimationFrame(correctGlobalToolAnchor),
      frames: 0,
      stableFrames: 0,
      deadline: performance.now() + 1_000,
      cancelOnInput,
    };
    window.addEventListener("wheel", cancelOnInput, { passive: true });
    window.addEventListener("pointerdown", cancelOnInput, { passive: true });
    window.addEventListener("touchstart", cancelOnInput, { passive: true });
    window.addEventListener("keydown", cancelOnInput);
  };

  useLayoutEffect(() => {
    if (toolExpansionAnchor) toolExpansionAnchor.current = captureGlobalToolAnchor;
  });
  useEffect(
    () => () => {
      stopGlobalToolAnchor();
      if (toolExpansionAnchor) toolExpansionAnchor.current = null;
    },
    [toolExpansionAnchor],
  );

  if (rowCount === 0) {
    return <div class="notice">Waiting for the first message in this session…</div>;
  }

  const items = virtualizer.getVirtualItems();
  return (
    <div id="messages">
      {hasOlder || loadingOlder ? (
        <div class="history-status" role="status" aria-live="polite">
          {loadingOlder ? (
            "Loading earlier messages…"
          ) : (
            <button type="button" onClick={onLoadOlder}>
              Load earlier messages
            </button>
          )}
        </div>
      ) : null}
      <div
        class="messages-viewport"
        ref={viewportRef}
        style={{ position: "relative", height: `${virtualizer.getTotalSize()}px`, width: "100%" }}
      >
        {items.map((item) => {
          const row = rowAt(item.index);
          return (
            <div
              key={item.key}
              class="message-row"
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start - scrollMargin}px)`,
              }}
            >
              <EntryBoundary id={row.id} entry={row.payload} results={results} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
