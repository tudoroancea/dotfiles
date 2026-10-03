// The TUI tool-call renderer contract.
//
// Pi splits a tool call into `renderCall` for the header and `renderResult` for the body,
// then appends both into one status-tinted Box. `defineRenderer` wires each spec's header
// and body into those slots.
//
// Tool arguments come from the model, so they are routinely incomplete (streaming) or
// wrong-typed. Each spec declares one `decode` step, the single untrusted-to-typed
// boundary; after it every header and body works on typed data. The coercion helpers are
// the browser's, so `[invalid arg]` appears in the same places in both surfaces.

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

/**
 * Local mirror of Pi's per-call render context, which is not part of the public export
 * surface. It must stay structurally identical to `ToolRenderContext` so a built-in
 * renderer can be called with a context received here — that is how the expanded state of
 * `read`/`ls`/`grep`/`find` is delegated back to Pi.
 */
export interface SlotContext {
  /** The call's current arguments, shared by both slots. */
  readonly args: unknown;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly expanded: boolean;
  readonly isError: boolean;
  readonly isPartial: boolean;
  readonly executionStarted: boolean;
  readonly argsComplete: boolean;
  readonly showImages: boolean;
  /** The component this slot returned last time, for in-place reuse. */
  readonly lastComponent: Component | undefined;
  /** Scratch space that survives across renders of this row. */
  readonly state: Record<string, unknown>;
  /** Request a redraw of this row. */
  readonly invalidate: () => void;
}

/** A tool result decoded once per render, before any renderer sees it. */
export interface ResultView {
  /** The result's text blocks, joined and trimmed. */
  readonly text: string;
  /** Structured payload; each tool's own decoder narrows it further. */
  readonly details: unknown;
  readonly isError: boolean;
  /** A streamed intermediate result: more of it is still coming. */
  readonly isPartial: boolean;
  readonly imageCount: number;
}

/** What a renderer may return: styled text (wrapped by `Text`) or its own component. */
export type Rendering = string | Component | undefined;

export interface RenderContext {
  /** The global tool-output expansion state. Every renderer must handle both values. */
  readonly expanded: boolean;
  readonly theme: Theme;
  readonly cwd: string;
  /**
   * Scratch space that survives across renders of this row — the terminal's answer to the
   * browser's disclosure store. Used to pin values that would otherwise drift between
   * redraws, such as the "now" an elapsed time is measured against.
   */
  readonly state: Record<string, unknown>;
  /**
   * Ask for this row to be redrawn, which re-runs both slots. A renderer showing something
   * that moves on its own — an elapsed time — drives it through `liveRedraw` in `./live.ts`
   * rather than calling this directly.
   */
  readonly invalidate: () => void;
}

export interface RendererSpec<A> {
  /** Every tool name this spec renders. */
  readonly names: readonly string[];
  /**
   * The one untrusted-to-typed boundary for this call. A tool whose header depends on its
   * result reads `result` here so the whole render shares one decode. This runs on every
   * render, so heavier decoding belongs behind a `ctx.state` cache.
   */
  decode(raw: Readonly<Record<string, unknown>>, result: ResultView | undefined): A;
  /**
   * One row naming the call. `ctx.expanded` chooses compact or full detail. Omitted when a
   * built-in's own header should be inherited: Pi resolves renderer inheritance per slot,
   * so leaving this off keeps the built-in `renderCall` (hyperlinked paths, skill labels).
   */
  header?(args: A, ctx: RenderContext): Rendering;
  /** The result. Must render something meaningful in both expansion states. */
  body?(args: A, result: ResultView, ctx: RenderContext): Rendering;
}

/**
 * The two slots Pi's tool-execution shell renders, plus the names they apply to. A slot left
 * undefined inherits the built-in renderer for that tool, if there is one.
 */
export interface Renderer {
  readonly names: readonly string[];
  // The slot signatures are Pi's, with the schema-typed argument and detail types erased:
  // these renderers reach their typed view through `decode`, not through the tool's schema,
  // and the erasure is what lets one renderer be attached to several registrations.
  renderCall?: (args: any, theme: Theme, ctx: SlotContext) => Component;
  renderResult?: (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    ctx: SlotContext,
  ) => Component;
}

export function decodeResult(
  result: AgentToolResult<unknown> | undefined,
  options: ToolRenderResultOptions,
  isError: boolean,
): ResultView {
  const content = result?.content ?? [];
  return {
    text: content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim(),
    details: result?.details,
    isError,
    isPartial: options.isPartial,
    imageCount: content.filter((part) => part.type === "image").length,
  };
}

/**
 * Styled text becomes a `Text`, which word-wraps and preserves ANSI. The instance from the
 * previous render of the same slot is reused, so a redraw mutates one component instead of
 * allocating; a renderer that needs per-row truncation returns its own component instead.
 *
 * An empty string renders zero lines — that is how a collapsed body shows nothing.
 */
function component(rendering: Rendering, last: Component | undefined): Component {
  if (rendering !== undefined && typeof rendering !== "string") return rendering;
  const text = last instanceof Text ? last : new Text("", 0, 0);
  text.setText(rendering ?? "");
  return text;
}

export function defineRenderer<A>(spec: RendererSpec<A>): Renderer {
  const context = (ctx: SlotContext, theme: Theme): RenderContext => ({
    expanded: ctx.expanded,
    theme,
    cwd: ctx.cwd,
    state: ctx.state,
    invalidate: ctx.invalidate,
  });
  const header = spec.header;
  const body = spec.body;
  return {
    names: spec.names,
    renderCall: header
      ? (raw, theme, ctx) =>
          component(
            header(spec.decode(raw ?? {}, undefined), context(ctx, theme)),
            ctx.lastComponent,
          )
      : undefined,
    renderResult: body
      ? (result, options, theme, ctx) => {
          const view = decodeResult(result, options, ctx.isError);
          const args = spec.decode((ctx.args ?? {}) as Record<string, unknown>, view);
          return component(body(args, view, context(ctx, theme)), ctx.lastComponent);
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Argument coercion
//
// `requiredText` keeps the difference between "the tool omitted this" ("") and "the payload
// carried something that is not a string" (null), so a renderer can flag a malformed call
// instead of silently drawing an empty row. Optional arguments have no such distinction to
// make and collapse to a neutral value.
// ---------------------------------------------------------------------------

export function requiredText(value: unknown): string | null {
  if (typeof value === "string") return value;
  return value == null ? "" : null;
}

export function optionalText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function flag(value: unknown): boolean {
  return value === true;
}

/** A string list argument, accepting the single-string form some tools allow. */
export function textList(value: unknown): readonly string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** How many items a list-shaped argument carries, without materializing it. */
export function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
