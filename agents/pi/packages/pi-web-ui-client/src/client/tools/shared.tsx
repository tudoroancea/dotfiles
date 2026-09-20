// Presentational primitives shared by more than one tool group.
//
// Everything here is used by at least two of the group modules (or by a group and
// the entry renderers). Anything used by a single tool lives with that tool.

import type { ComponentChildren, JSX } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { ImageOmissionReason, ImageReference, RemoteImageBlock } from "../../wire/schema.ts";
import { DisclosureContext } from "../disclosure.ts";
import { replaceTabs, statusIcon } from "../format.ts";
import { ImageUrlContext } from "../image-transport.ts";
import { PrefsContext } from "../preferences.ts";
import type { ToolStatus } from "./types.ts";

/** How often a live row re-reads the clock. Nothing here has sub-second resolution. */
const LIVE_TICK_MS = 1_000;

/**
 * A clock for the elapsed times of work that is still going.
 *
 * A transcript re-renders when an operation arrives, so an elapsed time decoded against `now`
 * advances in jumps and freezes entirely once the last operation for a run has been seen. The
 * caller decodes against the returned `now`, works out from the result whether anything is still
 * live, and reports it back through `setLive` from an effect; only then does the interval exist.
 * A settled row therefore never re-renders on its own, which is what keeps the fixtures
 * deterministic. Liveness cannot simply be an argument here: it is read off the decoded view,
 * and decoding needs the clock this hook owns.
 *
 * The terminal solves the same problem with `liveRedraw` in `agent/extensions/lib/tools/live.ts`.
 */
export function useLiveNow(): { now: number; setLive: (live: boolean) => void } {
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!live) return;
    // The window's timer, not the ambient one: a host that tears the window down — a test
    // harness closing its DOM — then takes the interval with it.
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [live]);
  return { now, setLive };
}

/** Read/toggle a block's expansion from the row-independent disclosure store. */
export function useDisclosure(
  dkey: string,
  fallback: boolean,
): [boolean, (value: boolean) => void] {
  const store = useContext(DisclosureContext);
  return [store.resolve(dkey, fallback), (value: boolean) => store.set(dkey, value)];
}

/** Whether a container click should toggle its disclosure rather than an inner control. */
export function isPlainDisclosureClick(event: { target: EventTarget | null }): boolean {
  const interactive =
    event.target instanceof Element
      ? event.target.closest(
          "button, a, [role='button'], [role='link'], input, select, textarea, label, summary",
        )
      : null;
  return !interactive && !window.getSelection()?.toString();
}

/** Marks an argument whose payload carried something other than a string. */
export function InvalidArg() {
  return <span class="tool-error">[invalid arg]</span>;
}

/**
 * The text a listing or search tool returns, split into content lines and the
 * bracketed notice those tools append (`…\n\n[500 entries limit reached. …]`).
 *
 * Counting raw lines would fold that notice, its blank separator, and the
 * empty-result sentinels into the total, which is why a collapsed summary and its
 * own expanded content could disagree. The notice is actionable rather than
 * content, so it is surfaced separately and never counted.
 *
 * Formats verified against `pi-coding-agent/dist/core/tools/{ls,grep,find}.js` and
 * `@ff-labs/pi-fff/src/index.ts`.
 */
export function listResult(text: string): { lines: readonly string[]; notice: string } {
  const trimmed = text.trimEnd();
  const notice = /\n\n\[([\s\S]*)\]$/.exec(trimmed);
  const body = notice ? trimmed.slice(0, notice.index) : trimmed;
  const empty =
    !body ||
    body === "(empty directory)" ||
    body === "(no output)" ||
    body === "No matches found" ||
    body === "No files found matching pattern";
  return {
    lines: empty ? [] : body.split("\n").filter((line) => line.trim() !== ""),
    notice: notice ? notice[1] : "",
  };
}

/** The bracketed limit/truncation notice a listing tool appended, if any. */
export function ResultNotice({ notice }: { notice: string }) {
  return notice ? <div class="result-notice">[{notice}]</div> : null;
}

function Lines({ text }: { text: string }) {
  return (
    <>
      {replaceTabs(text)
        .split("\n")
        .map((line, index) => (
          <div key={index}>{line}</div>
        ))}
    </>
  );
}

/** The one-line result summary a collapsed box shows in place of full output. */
export function Summary({ text, status }: { text: string; status?: ToolStatus }) {
  if (!text) return null;
  return (
    <div
      class={`compact-result ${status === "error" ? "error" : status === "success" ? "success" : ""}`}
    >
      {text}
    </div>
  );
}

/** Full output inside an expanded box, tinted when the call failed. */
export function Output({ text, isError = false }: { text: string; isError?: boolean }) {
  if (!text) return null;
  return (
    <div class={`tool-output ${isError ? "error-output" : ""}`}>
      <Lines text={text} />
    </div>
  );
}

/**
 * Terminal-style output with its own expansion, for content that stays unbounded
 * even inside an expanded box (a run's prompt, a job's output tail).
 */
export function ExpandableOutput({
  text,
  maxLines,
  tone = "",
  dkey,
}: {
  text: string;
  maxLines: number;
  tone?: string;
  dkey: string;
}) {
  const { prefs } = useContext(PrefsContext);
  const [expanded, setExpanded] = useDisclosure(dkey, prefs.tools);
  const clean = replaceTabs(text);
  const lines = clean.split("\n");
  const remaining = lines.length - maxLines;

  if (remaining <= 0) {
    return (
      <div class={`tool-output ${tone}`}>
        <Lines text={clean} />
      </div>
    );
  }
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setExpanded(!expanded);
  };
  const onClick = () => {
    if (window.getSelection()?.toString()) return;
    setExpanded(!expanded);
  };
  return (
    <div
      class={`tool-output expandable ${tone}`}
      role="button"
      tabindex={0}
      aria-expanded={expanded ? "true" : "false"}
      aria-label={expanded ? "Collapse tool output" : "Expand tool output"}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <Lines text={expanded ? clean : lines.slice(0, maxLines).join("\n")} />
      {expanded ? null : <div class="expand-hint">... ({remaining} more lines)</div>}
    </div>
  );
}

/**
 * Header for the four search tools (the built-in `grep`/`find` and fff's
 * `ffgrep`/`fffind`): the pattern is the call, and the flags that narrow it follow
 * as a `·`-separated tail.
 */
export function SearchHeader({
  label,
  pattern,
  details,
}: {
  label: string;
  /** `null` when the payload carried a non-string pattern. */
  pattern: string | null;
  details: readonly string[];
}) {
  const tail = details.filter(Boolean).join(" · ");
  return (
    <>
      <span class="tool-name">{label}</span>{" "}
      <span class="tool-path">{pattern === null ? <InvalidArg /> : pattern || "…"}</span>
      {tail ? <span class="line-count"> · {tail}</span> : null}
    </>
  );
}

/** Heading for one section of an expanded card. */
export function SectionTitle({ children }: { children: ComponentChildren }) {
  return <span class="agentflow-expanded-section-title">{children}</span>;
}

/** One row of a `Facts` list. Empty values drop out so no blank rows appear. */
export interface Fact {
  label: string;
  value: string;
  error?: boolean;
}

export function Facts({ items }: { items: readonly Fact[] }) {
  const visible = items.filter((item) => item.value !== "");
  if (!visible.length) return null;
  return (
    <dl class="tool-facts">
      {visible.map((item, index) => (
        <div key={index} class={`tool-fact ${item.error ? "error" : ""}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The status line that closes a run or job card: an icon and state, then a
 * `·`-separated tail of facts, then the box's own expansion hint.
 */
export function StatusLine({
  status,
  state,
  parts,
  expanded,
}: {
  /** A wire status string; also selects the `status-*` colour class. */
  status: string;
  /** The state text, when it should read differently from `status`. */
  state?: string;
  parts: readonly string[];
  expanded: boolean;
}) {
  return (
    <div class="tool-run-summary">
      <span class={`agentflow-run-status status-${status}`}>
        {statusIcon(status)} {state ?? status}
      </span>
      {parts.filter(Boolean).map((part, index) => (
        <span key={index}> · {part}</span>
      ))}
      <span> · click to {expanded ? "collapse" : "expand"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_OMISSION_TEXT: Record<ImageOmissionReason, string> = {
  "invalid-data": "Image unavailable: invalid image data",
  "unsupported-format": "Image unavailable: unsupported image format",
  "signature-mismatch": "Image unavailable: file type does not match its contents",
  "animated-image": "Image unavailable: animated images are not supported",
  "image-too-large": "Image unavailable: image file is too large",
  "dimensions-exceeded": "Image unavailable: image dimensions are too large",
  "pixels-exceeded": "Image unavailable: image pixel count is too large",
  "count-exceeded": "Image unavailable: too many images in this update",
  "aggregate-bytes-exceeded": "Image unavailable: images in this update are too large",
};

const IMAGE_FRAME_CAP = 500;
const MAX_IMAGE_RETRIES = 2;

function imageFrameDimensions(image: ImageReference): { width: number; height: number } {
  const scale = Math.min(1, IMAGE_FRAME_CAP / image.width, IMAGE_FRAME_CAP / image.height);
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

function retryUrl(src: string, attempt: number): string {
  if (attempt === 0) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}retry=${attempt}`;
}

function ReferencedImage({ image, cls }: { image: ImageReference; cls: string }) {
  const imageUrl = useContext(ImageUrlContext);
  const src = imageUrl(image);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const frame = imageFrameDimensions(image);
  const showFailure = failed || !src;
  const displayedFrame = showFailure
    ? { width: Math.max(frame.width, 240), height: Math.max(frame.height, 88) }
    : frame;
  useEffect(() => {
    setFailed(false);
    setAttempt(0);
  }, [image.id, src]);
  return (
    <div
      class="image-frame"
      role="group"
      aria-label="Attached image"
      style={{
        position: "relative",
        width: `${displayedFrame.width}px`,
        height: `${displayedFrame.height}px`,
        maxWidth: "100%",
        margin: "calc(var(--line-height) / 2) 0 0",
        overflow: "hidden",
        borderRadius: "4px",
      }}
    >
      {showFailure ? (
        <div
          class="image-placeholder image-error"
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            boxSizing: "border-box",
            width: "100%",
            height: "100%",
            minHeight: "88px",
            margin: 0,
            padding: "8px",
            textAlign: "center",
          }}
        >
          <span role="img" aria-label="Image failed to load">
            Image unavailable: failed to load or decode
          </span>
          {src && attempt < MAX_IMAGE_RETRIES ? (
            <button
              type="button"
              onClick={() => {
                setAttempt((value) => value + 1);
                setFailed(false);
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : (
        <img
          class={cls}
          src={retryUrl(src, attempt)}
          width={frame.width}
          height={frame.height}
          alt="Attached image"
          loading="lazy"
          decoding="async"
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            maxWidth: "none",
            maxHeight: "none",
            margin: 0,
            objectFit: "contain",
          }}
          onError={() => setFailed(true)}
          onLoad={(event) => {
            const element = event.currentTarget;
            if (typeof element.decode === "function")
              void element.decode().catch(() => setFailed(true));
          }}
        />
      )}
    </div>
  );
}

export function ImageBlock({ list, cls }: { list: readonly RemoteImageBlock[]; cls: string }) {
  if (!list.length) return null;
  return (
    <div class="message-images">
      {list.map((image, index) =>
        image.type === "image-reference" ? (
          <ReferencedImage key={`reference:${image.id}:${index}`} image={image} cls={cls} />
        ) : (
          <div
            key={`omission:${image.reason}:${index}`}
            class="image-placeholder image-omission"
            role="img"
            aria-label={IMAGE_OMISSION_TEXT[image.reason]}
          >
            {IMAGE_OMISSION_TEXT[image.reason]}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The clickable box every tool call and agent result lives in: a header row with a
 * visually hidden disclosure control, then the body the caller gates on `expanded`.
 * The box is a plain container rather than a `role="button"` so its inner text stays
 * selectable and in the accessibility tree.
 */
export function ToolBox({
  status,
  label,
  headerClass = "tool-header",
  header,
  expanded,
  onToggle,
  children,
}: {
  status: ToolStatus;
  label: string;
  headerClass?: string;
  header: ComponentChildren;
  expanded: boolean;
  onToggle: () => void;
  children?: ComponentChildren;
}) {
  const onBoxClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    // Ignore clicks that land on nested interactive controls (the disclosure
    // toggle, inner long-output expansion, image retry) or on a live text
    // selection; plain clicks anywhere on the box toggle it.
    if (isPlainDisclosureClick(event)) onToggle();
  };
  return (
    <div class={`tool-execution ${status} expandable`} onClick={onBoxClick}>
      <div class={headerClass}>
        <button
          type="button"
          class="tool-disclosure-toggle"
          aria-expanded={expanded ? "true" : "false"}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={onToggle}
        />
        {header}
      </div>
      {children}
    </div>
  );
}
