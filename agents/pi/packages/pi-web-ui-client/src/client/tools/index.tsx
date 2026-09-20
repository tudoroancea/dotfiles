// Tool-call rendering: the name-to-renderer registry and the box every call lives in.
//
// Each group module owns the tools of one extension and exports plain
// `RegisteredTool` values (see `types.ts` for the contract). Registration is a flat
// map, so a call's renderer is one lookup and an unrecognized tool falls back to the
// generic view rather than disappearing.

import { useContext } from "preact/hooks";
import { PrefsContext } from "../preferences.ts";
import { AGENTFLOW_TOOLS } from "./agentflow.tsx";
import { BACKGROUND_TOOLS } from "./background.tsx";
import { BUILTIN_TOOLS } from "./builtin.tsx";
import { FFF_TOOLS } from "./fff.tsx";
import { fallbackRendering, OTHER_TOOLS } from "./other.tsx";
import { WEB_ACCESS_TOOLS } from "./web-access.tsx";
import { ToolBox, useDisclosure } from "./shared.tsx";
import {
  decodeToolResult,
  resultStatus,
  type RegisteredTool,
  type ToolRendering,
} from "./types.ts";

const REGISTRY: ReadonlyMap<string, RegisteredTool> = new Map(
  [
    ...BUILTIN_TOOLS,
    ...FFF_TOOLS,
    ...AGENTFLOW_TOOLS,
    ...BACKGROUND_TOOLS,
    ...WEB_ACCESS_TOOLS,
    ...OTHER_TOOLS,
  ].flatMap((tool) => tool.names.map((name) => [name, tool] as const)),
);

/** Every tool with a dedicated renderer. Anything else uses the generic fallback. */
export const REGISTERED_TOOL_NAMES: readonly string[] = [...REGISTRY.keys()];

/**
 * One tool call and its result, in a box that expands on click anywhere. Per-call
 * expansion defaults to the global tool-output preference, whose hotkey clears every
 * per-call override; text selection and nested controls keep working. The box is a
 * plain clickable container so its text stays in the accessibility tree, and the
 * keyboard-accessible disclosure control is the hidden button in the header row.
 *
 * Every renderer reads that one `expanded` flag and draws both states. Nested
 * disclosures exist only for content that stays unbounded inside an expanded box.
 */
export function ToolCall({
  name,
  args,
  result,
  dkey,
}: {
  name: string;
  args: Readonly<Record<string, unknown>>;
  /** The matching `toolResult` message, absent while the call is still running. */
  result: Readonly<Record<string, unknown>> | undefined;
  dkey: string;
}) {
  const { prefs } = useContext(PrefsContext);
  const [expanded, setExpanded] = useDisclosure(`${dkey}:box`, prefs.tools);
  const view = decodeToolResult(result);
  const ctx = { expanded, dkey };
  const tool = REGISTRY.get(name);
  const rendering: ToolRendering = tool
    ? tool.render(args, view, ctx)
    : { ...fallbackRendering(name, args, view, ctx), status: resultStatus(view) };
  return (
    <ToolBox
      status={rendering.status}
      label={`${name} tool call`}
      headerClass={rendering.headerClass}
      header={rendering.header}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      {rendering.body}
    </ToolBox>
  );
}

export { AgentflowResultMessage } from "./agentflow.tsx";
export { BackgroundCompletionMessage, BackgroundMonitorEventMessage } from "./background.tsx";
