import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "@dotfiles/pi-web-ui-client/wire";
import type { SessionMetadata, ThinkingLevel } from "@dotfiles/pi-web-ui-client/wire";
import { summarizeSessionCost } from "../../../lib/session-cost.ts";

// Projects Pi session state into the bounded browser metadata DTO. Browser metadata
// deliberately reports recorded spend across the whole session tree.
export function sessionCost(context: ExtensionContext): number {
  return summarizeSessionCost(context.sessionManager.getEntries()).total;
}

export function projectMetadata(context: ExtensionContext): SessionMetadata {
  const usage = context.getContextUsage();
  return {
    cwd: String(context.cwd).slice(0, LIMITS.maxMetadataStringChars),
    home: homedir().slice(0, LIMITS.maxMetadataStringChars),
    contextUsage: usage
      ? {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: usage.percent,
        }
      : undefined,
    sessionCost: sessionCost(context),
    model: context.model
      ? {
          provider: String(context.model.provider).slice(0, 128),
          id: String(context.model.id).slice(0, 256),
          name: String(context.model.name).slice(0, 256),
        }
      : undefined,
    thinkingLevel: isThinkingLevel(context.thinkingLevel) ? context.thinkingLevel : undefined,
  };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}
