import { defaultRangeExtractor } from "@tanstack/virtual-core";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PersistedEntry, ProjectedMessage, SessionMetadata } from "../../shared/wire.js";
import { asArray, asRecord, normalizeTool } from "../lib/tool-model.js";
import type { BrowserHistoryStore } from "../history-store.js";
import { createCspVirtualStyleManager } from "../csp-virtual-styles.js";
import type { BrowserSessionSnapshot, BrowserSessionStore } from "../session-store.js";
import { useBrowserHistory } from "../session-store.js";
import { useVirtualizer } from "../use-virtualizer.js";
import { ExpansionContext, useExpansionState } from "./expansion.js";
import { JsonView } from "./JsonView.js";
import { CustomMessageView, MessageView } from "./Message.js";
import { SessionIntro } from "./SessionIntro.js";
import { ToolCall } from "./ToolCall.js";
import {
  anchorScrollOffset,
  buildLiveRows,
  captureTopAnchor,
  distanceFromBottom,
  findRowStart,
  indexPersistedTimeline,
  messageIdentity,
  persistedRowKey,
  type LiveRow,
  type PersistedToolCall,
  type TopAnchor,
} from "./timeline-model.js";

const OVERSCAN = 8;
const ESTIMATED_ROW = 96;
const BOTTOM_THRESHOLD = 64;
const SENTINEL_THRESHOLD = 240;

function EntryView({
  entry,
  toolCalls,
}: {
  entry: PersistedEntry;
  toolCalls: ReadonlyMap<string, PersistedToolCall>;
}) {
  const payload = asRecord(entry.payload);

  if (entry.entryType === "message") {
    return <MessageView message={payload.message as ProjectedMessage} toolCalls={toolCalls} />;
  }

  if (entry.entryType === "custom_message") {
    const customType = typeof payload.customType === "string" ? payload.customType : "custom";
    if (payload.display === false) return null;
    return (
      <CustomMessageView
        customType={customType}
        content={asArray(payload.content)}
        details={asRecord(payload.details)}
      />
    );
  }

  if (entry.entryType === "custom" || entry.entryType === "web-ui-startup") return null;

  return (
    <article class="message message--custom">
      <div class="message__gutter" aria-hidden="true">
        <span class="message__glyph">·</span>
      </div>
      <div class="message__body">
        <div class="message__byline">{entry.entryType}</div>
        <JsonView value={payload} />
      </div>
    </article>
  );
}

function TimelineRowView({
  entry,
  liveRow,
  toolCalls,
}: {
  entry?: PersistedEntry;
  liveRow?: LiveRow;
  toolCalls: ReadonlyMap<string, PersistedToolCall>;
}) {
  if (liveRow?.tool) {
    return <ToolCall id={liveRow.tool.toolCallId} view={normalizeTool(liveRow.tool)} />;
  }
  if (entry?.entryType === "message") {
    const message = asRecord(asRecord(entry.payload).message) as ProjectedMessage;
    if (message.role === "toolResult" && message.toolCallId) {
      const call = toolCalls.get(message.toolCallId);
      return (
        <ToolCall
          id={message.toolCallId}
          view={normalizeTool({
            toolName: message.toolName ?? call?.name ?? "tool",
            args: call?.args,
            result: { content: message.content, details: message.details },
            isError: message.isError === true,
            status: message.isError ? "error" : "completed",
          })}
        />
      );
    }
  }
  if (entry) return <EntryView entry={entry} toolCalls={toolCalls} />;
  if (liveRow?.message) {
    return <MessageView message={liveRow.message} partial={liveRow.partial === true} />;
  }
  return null;
}

interface PendingAnchor {
  anchor: TopAnchor;
  baselineLength: number;
  baselineFirstId: string | undefined;
}

interface HeadRowProps {
  history: {
    hasOlder: boolean;
    loadingOlder: boolean;
    error?: string | undefined;
  };
  metadata?: SessionMetadata;
  sessionId?: string;
  onLoadOlder: () => void;
}

function HeadRow({ history, metadata, sessionId, onLoadOlder }: HeadRowProps) {
  if (!history.hasOlder) {
    return (
      <SessionIntro {...(metadata ? { metadata } : {})} {...(sessionId ? { sessionId } : {})} />
    );
  }
  return (
    <div class="timeline__earlier">
      <button
        type="button"
        class="timeline__earlier-button"
        onClick={onLoadOlder}
        disabled={history.loadingOlder}
      >
        {history.loadingOlder
          ? "Loading earlier messages…"
          : history.error
            ? "Retry loading earlier messages"
            : "Load earlier messages"}
      </button>
      {history.error ? <p class="timeline__earlier-error">{history.error}</p> : null}
    </div>
  );
}

export interface TimelineProps {
  store: BrowserSessionStore;
  session: BrowserSessionSnapshot;
  /** Sends one older-history page request; returns whether a request started. */
  onRequestOlder: () => boolean;
}

/** The conversation timeline: a variable-height virtual transcript over paged history. */
export function Timeline({ store, session, onRequestOlder }: TimelineProps) {
  const historyStore: BrowserHistoryStore = store.history;
  const history = useBrowserHistory(store);
  const expansion = useExpansionState();
  const virtualStyles = useMemo(() => createCspVirtualStyleManager(document), []);
  const live = session.state?.live;
  const metadata = session.state?.metadata;
  const sessionId = session.state?.persisted.sessionId;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const focusedKeyRef = useRef<string | null>(null);
  const pendingAnchorRef = useRef<PendingAnchor | undefined>(undefined);
  const restoringAnchorRef = useRef<TopAnchor | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastRevisionRef = useRef(session.revision);

  const historyLength = history.length;

  // One version-scoped scan powers visibility, tool lookup, and overlay de-duplication.
  // Live token updates therefore never rescan persisted history.
  const persistedIndex = useMemo(() => {
    function* entries(): Generator<PersistedEntry> {
      for (let index = 0; index < historyLength; index += 1) {
        const entry = historyStore.at(index);
        if (entry) yield entry;
      }
    }
    return indexPersistedTimeline(entries());
  }, [historyStore, history.version, historyLength]);

  const liveRows = useMemo(() => {
    if (!live) return [] as LiveRow[];
    const messages = live.finalizedMessages.filter(
      (message) => !persistedIndex.messages.has(messageIdentity(message)),
    );
    const tools = [...live.tools]
      .filter((tool) => !persistedIndex.toolResults.has(tool.toolCallId))
      .sort((left, right) => left.ordinal - right.ordinal);
    return buildLiveRows(messages, live.partialAssistant, tools);
  }, [live, persistedIndex]);

  const visibleHistoryLength = persistedIndex.visibleIndexes.length;
  const rowCount = 1 + visibleHistoryLength + liveRows.length;
  const liveKeySignature = liveRows.map((row) => row.key).join("\u0000");
  // The array (and callback below) changes for every logical key-map change,
  // including equal-count branch/live replacement, but not streaming token text.
  const rowKeys = useMemo(() => {
    const keys = [history.hasOlder ? "load" : "intro"];
    for (const storeIndex of persistedIndex.visibleIndexes) {
      const entry = historyStore.at(storeIndex);
      keys.push(entry ? persistedRowKey(entry) : `entry:missing:${storeIndex}`);
    }
    keys.push(...liveRows.map((row) => row.key));
    return keys;
  }, [historyStore, history.hasOlder, persistedIndex, liveKeySignature]);
  const keyToIndex = useMemo(() => new Map(rowKeys.map((key, index) => [key, index])), [rowKeys]);

  const hasOlderRef = useRef(history.hasOlder);
  hasOlderRef.current = history.hasOlder;
  const getItemKey = useCallback(
    (index: number): string => rowKeys[index] ?? `row:${index}`,
    [rowKeys],
  );
  const keyToIndexRef = useRef(keyToIndex);
  keyToIndexRef.current = keyToIndex;

  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    const focusedKey = focusedKeyRef.current;
    const focused = focusedKey === null ? undefined : keyToIndexRef.current.get(focusedKey);
    if (focused !== undefined && focused < range.count && !indexes.includes(focused)) {
      indexes.push(focused);
      indexes.sort((left, right) => left - right);
    }
    return indexes;
  }, []);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW,
    overscan: OVERSCAN,
    getItemKey,
    rangeExtractor,
  });

  const historyGeneration = history.historyGeneration;
  const previousGenerationRef = useRef(historyGeneration);
  useLayoutEffect(() => {
    if (previousGenerationRef.current === historyGeneration) return;
    previousGenerationRef.current = historyGeneration;
    pendingAnchorRef.current = undefined;
    restoringAnchorRef.current = undefined;
    focusedKeyRef.current = null;
    stickRef.current = true;
    lastRevisionRef.current = session.revision;
    setUnseen(0);
    setAtBottom(true);
    expansion.reset();
    // A new lineage may reuse IDs at the same indexes with different heights.
    // Clear TanStack's size ownership before following the new latest row.
    virtualizer.measure();
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [historyGeneration]);

  const loadOlder = useCallback(
    (auto: boolean) => {
      if (!hasOlderRef.current || history.loadingOlder) return;
      if (auto && history.error) return;
      const anchor = captureTopAnchor(
        virtualizer.getVirtualItems(),
        scrollRef.current?.scrollTop ?? 0,
      );
      pendingAnchorRef.current = anchor
        ? {
            anchor,
            baselineLength: historyLength,
            baselineFirstId: historyStore.at(0)?.id,
          }
        : undefined;
      if (!onRequestOlder()) pendingAnchorRef.current = undefined;
    },
    [history.loadingOlder, history.error, historyLength, historyStore, virtualizer, onRequestOlder],
  );

  // A request owns its anchor only until that same in-flight load settles. A
  // version bump from an unrelated live append cannot promote it.
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending || history.loadingOlder) return;
    pendingAnchorRef.current = undefined;
    const firstId = historyStore.at(0)?.id;
    const prepended =
      historyLength > pending.baselineLength &&
      (pending.baselineFirstId === undefined
        ? firstId !== undefined
        : firstId !== pending.baselineFirstId);
    if (!prepended) return;
    const element = scrollRef.current;
    if (!element) return;
    const { anchor } = pending;
    const start = findRowStart(virtualizer.measurementsCache, anchor.key);
    if (start === undefined) return;
    restoringAnchorRef.current = anchor;
    virtualizer.scrollToOffset(anchorScrollOffset(start, anchor.delta));
    stickRef.current = distanceFromBottom(element) < BOTTOM_THRESHOLD;
  }, [history.loadingOlder, history.error, history.version, historyLength, historyStore]);

  // Re-apply the stable anchor while newly mounted prepended rows settle from
  // estimates to measured heights. User input below releases this ownership.
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const anchor = restoringAnchorRef.current;
    if (!anchor) return;
    const start = findRowStart(virtualizer.measurementsCache, anchor.key);
    if (start !== undefined) virtualizer.scrollToOffset(anchorScrollOffset(start, anchor.delta));
  }, [history.version, totalSize]);

  // Keep the latest content in view while the reader is following the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (stickRef.current) {
      element.scrollTop = element.scrollHeight;
      if (unseen !== 0) setUnseen(0);
      if (!atBottom) setAtBottom(true);
    }
  }, [history.version, session.revision, totalSize, rowCount]);

  // Automatically fill the viewport when the loaded content is too short.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !history.hasOlder || history.loadingOlder || history.error) return;
    if (totalSize <= element.clientHeight + BOTTOM_THRESHOLD) loadOlder(true);
  }, [
    history.version,
    history.hasOlder,
    history.loadingOlder,
    history.error,
    totalSize,
    loadOlder,
  ]);

  // Count updates the reader has not yet scrolled down to see.
  useLayoutEffect(() => {
    if (session.revision === lastRevisionRef.current) return;
    lastRevisionRef.current = session.revision;
    if (!stickRef.current) setUnseen((count) => count + 1);
  }, [session.revision]);

  const releaseAnchorOwnership = useCallback(() => {
    pendingAnchorRef.current = undefined;
    restoringAnchorRef.current = undefined;
  }, []);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const following = distanceFromBottom(element) < BOTTOM_THRESHOLD;
    stickRef.current = following;
    setAtBottom(following);
    if (following && unseen !== 0) setUnseen(0);
    if (element.scrollTop < SENTINEL_THRESHOLD) loadOlder(true);
  }, [unseen, loadOlder]);

  const handleFocus = useCallback((event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>("[data-row-key]");
    focusedKeyRef.current = row?.dataset.rowKey ?? null;
  }, []);

  const handleBlur = useCallback((event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !scrollRef.current?.contains(next)) focusedKeyRef.current = null;
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    restoringAnchorRef.current = undefined;
    stickRef.current = true;
    element.scrollTop = element.scrollHeight;
    setUnseen(0);
    setAtBottom(true);
  }, []);

  const items = virtualizer.getVirtualItems();
  const isEmpty = rowCount === 1 && !history.hasOlder;

  useLayoutEffect(() => () => virtualStyles.dispose(), [virtualStyles]);
  // Synchronize before paint. CSSOM mutation of the same-origin authored sheet
  // is permitted by style-src 'self' and creates no inline declaration.
  useLayoutEffect(() => {
    if (isEmpty) virtualStyles.update(0, []);
    else
      virtualStyles.update(
        totalSize,
        items.map((item) => ({ index: item.index, start: item.start })),
      );
  });

  return (
    <div
      class="timeline-region"
      data-history-length={historyLength}
      data-history-complete={history.hasOlder ? "false" : "true"}
    >
      <div
        class="timeline-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={releaseAnchorOwnership}
        onPointerDown={releaseAnchorOwnership}
        onKeyDown={releaseAnchorOwnership}
        onFocusCapture={handleFocus}
        onBlurCapture={handleBlur}
      >
        <ExpansionContext.Provider value={expansion}>
          {isEmpty ? (
            <div class="timeline timeline--empty">
              <SessionIntro
                {...(metadata ? { metadata } : {})}
                {...(sessionId ? { sessionId } : {})}
              />
              <p class="timeline__empty">
                No activity yet. Send a prompt to start driving this Pi session.
              </p>
            </div>
          ) : (
            <div class="timeline" data-virtual-list={virtualStyles.listId}>
              {items.map((item) => {
                const timelineIndex = item.index - 1;
                const storeIndex =
                  timelineIndex >= 0 && timelineIndex < visibleHistoryLength
                    ? persistedIndex.visibleIndexes[timelineIndex]
                    : undefined;
                const entry = storeIndex === undefined ? undefined : historyStore.at(storeIndex);
                const liveRow =
                  timelineIndex >= visibleHistoryLength
                    ? liveRows[timelineIndex - visibleHistoryLength]
                    : undefined;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    data-virtual-index={item.index}
                    data-row-key={item.key}
                    ref={virtualizer.measureElement}
                    class="timeline__row"
                  >
                    {item.index === 0 ? (
                      <HeadRow
                        history={history}
                        {...(metadata ? { metadata } : {})}
                        {...(sessionId ? { sessionId } : {})}
                        onLoadOlder={() => loadOlder(false)}
                      />
                    ) : (
                      <TimelineRowView
                        {...(entry ? { entry } : {})}
                        {...(liveRow ? { liveRow } : {})}
                        toolCalls={persistedIndex.toolCalls}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ExpansionContext.Provider>
      </div>

      <p class="sr-only" role="status" aria-live="polite">
        {history.loadingOlder
          ? "Loading earlier messages"
          : history.error
            ? `Earlier messages failed to load: ${history.error}`
            : ""}
      </p>

      {!atBottom ? (
        <button type="button" class="timeline__jump" onClick={jumpToLatest}>
          Jump to latest
          {unseen > 0 ? (
            <span class="timeline__jump-count" aria-label={`${unseen} new updates`}>
              {unseen}
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
