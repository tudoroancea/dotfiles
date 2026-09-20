// The tool-call renderer contract.
//
// Transcript payloads are untrusted, so each tool declares one `decode` step that
// turns its raw argument record into a tool-specific typed struct. Everything after
// that point — every header, every body, every nested component — works on typed
// data, and no renderer reaches into an untrusted record itself.
//
// `defineTool` erases the argument type at the registry boundary, so the lookup map
// holds plain `RegisteredTool` values while each spec stays strongly typed.

import type { ComponentChildren } from "preact";
import type { RemoteImageBlock } from "../../wire/schema.ts";
import { images } from "../format.ts";

/** Tone of the box a call renders in; drives the `tool-execution` CSS class. */
export type ToolStatus = "pending" | "success" | "error";

export interface ToolContext {
  /** The box's expansion state. Every renderer must handle both values. */
  readonly expanded: boolean;
  /** Disclosure-store key prefix for content with its own nested expansion. */
  readonly dkey: string;
}

/** A tool result decoded once per call, before any renderer sees it. */
export interface ToolResultView {
  /** The result's text blocks, joined and trimmed. */
  readonly text: string;
  readonly images: readonly RemoteImageBlock[];
  /** Structured payload; each tool's own decoder narrows it further. */
  readonly details: unknown;
  readonly isError: boolean;
  /** A streamed intermediate result: more of it is still coming. */
  readonly isPartial: boolean;
}

export function decodeToolResult(
  message: Readonly<Record<string, unknown>> | undefined,
): ToolResultView | undefined {
  if (!message) return undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const part = block as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return {
    text: parts.join("\n").trim(),
    images: images(message.content),
    details: message.details,
    isError: message.isError === true,
    isPartial: message.isPartial === true,
  };
}

export interface ToolRendering {
  /** Header row class; `tool-command` and `custom-tool-header` are the variants. */
  readonly headerClass: string;
  readonly header: ComponentChildren;
  readonly body: ComponentChildren;
  readonly status: ToolStatus;
}

export interface ToolSpec<A> {
  /** Every tool name this spec renders. */
  readonly names: readonly string[];
  readonly headerClass?: string;
  /**
   * The one untrusted-to-typed boundary for this call. Most tools only need their
   * arguments; a tool whose header or box tone depends on its result reads `result`
   * here so the whole render shares one decode. Heavier result decoding belongs in
   * a memoized component instead, since this runs on every render.
   */
  decode(raw: Readonly<Record<string, unknown>>, result: ToolResultView | undefined): A;
  /** One row naming the call. `ctx.expanded` chooses compact or full detail. */
  header(args: A, ctx: ToolContext): ComponentChildren;
  /** The result. Must render something meaningful in both expansion states. */
  body?(args: A, result: ToolResultView | undefined, ctx: ToolContext): ComponentChildren;
  /** Overrides the result-derived status when the tool tracks its own state. */
  status?(args: A, result: ToolResultView | undefined): ToolStatus;
}

export interface RegisteredTool {
  readonly names: readonly string[];
  render(
    raw: Readonly<Record<string, unknown>>,
    result: ToolResultView | undefined,
    ctx: ToolContext,
  ): ToolRendering;
}

/**
 * Rebuild the minimal raw result record the wire decoders read. They take untrusted
 * transcript shapes by design, so they are fed the same shape back rather than being
 * coupled to this module's decoded view.
 */
export function rawResult(view: ToolResultView): Record<string, unknown> {
  return {
    content: [{ type: "text", text: view.text }],
    details: view.details,
    isError: view.isError,
    isPartial: view.isPartial,
  };
}

/** A call with no result yet is pending; a streamed partial one still is. */
export function resultStatus(result: ToolResultView | undefined): ToolStatus {
  if (!result) return "pending";
  if (result.isError) return "error";
  return result.isPartial ? "pending" : "success";
}

export function defineTool<A>(spec: ToolSpec<A>): RegisteredTool {
  return {
    names: spec.names,
    render(raw, result, ctx) {
      const args = spec.decode(raw, result);
      return {
        headerClass: spec.headerClass ?? "tool-header",
        header: spec.header(args, ctx),
        body: spec.body?.(args, result, ctx) ?? null,
        status: spec.status?.(args, result) ?? resultStatus(result),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Argument coercion
//
// `requiredText` keeps the difference between "the tool omitted this" ("") and
// "the payload carried something that is not a string" (null), so a renderer can
// flag a malformed transcript instead of silently drawing an empty row. Optional
// arguments have no such distinction to make and collapse to a neutral value.
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
