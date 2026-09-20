import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "@dotfiles/pi-web-ui-client/wire";
import type { ModelControlCapability, ThinkingLevel } from "@dotfiles/pi-web-ui-client/wire";
import type {
  PendingInput,
  PendingInputBrokerCapability,
  Snapshot,
  SnapshotTheme,
} from "../server.js";
import { projectMetadata } from "../projection.js";
import { themePalette } from "../theme.js";
import { LiveSessionProjection } from "./live.js";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function modelControlCapability(
  context: ExtensionContext,
): ModelControlCapability | undefined {
  const source =
    context.scopedModels.length > 0
      ? context.scopedModels.map((item) => item.model)
      : context.modelRegistry.getAvailable();
  const models: ModelControlCapability["models"] = [];
  const seen = new Set<string>();
  for (const model of source) {
    if (
      !model.provider ||
      model.provider.length > LIMITS.maxModelProviderChars ||
      !model.id ||
      model.id.length > LIMITS.maxModelIdChars
    ) {
      continue;
    }
    const name = model.name.slice(0, LIMITS.maxModelNameChars);
    const key = `${model.provider}\0${model.id}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    models.push({ provider: model.provider, id: model.id, name });
    if (models.length === LIMITS.maxModelChoices) break;
  }
  if (models.length === 0 || !context.model) return undefined;
  const uniqueThinkingLevels = [...new Set(supportedThinkingLevels(context.model))];
  if (uniqueThinkingLevels.length === 0) return undefined;
  return { models, thinkingLevels: uniqueThinkingLevels };
}

function supportedThinkingLevels(model: ExtensionContext["model"]): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

export class SessionSnapshotProjection {
  readonly live = new LiveSessionProjection();
  private automaticTheme: [string, string] | undefined;
  private automaticPalette: SnapshotTheme | undefined;
  private cachedTheme: { key: string; value: SnapshotTheme } | undefined;
  private persistedToolResults = new Set<string>();

  constructor(
    readonly context: ExtensionContext,
    private readonly pendingInputs: () => readonly PendingInput[] = () => [],
    private readonly pendingInputBroker: PendingInputBrokerCapability | undefined = undefined,
  ) {}

  setAutomaticTheme(
    automaticTheme: [string, string] | undefined,
    automaticPalette: SnapshotTheme | undefined,
  ): void {
    this.automaticTheme = automaticTheme;
    this.automaticPalette = automaticPalette;
    this.cachedTheme = undefined;
  }

  pollKey(): string {
    return this.context.sessionManager.getLeafId() ?? "";
  }

  entries(): { persisted: unknown[]; live: unknown[] } {
    const persisted = [...this.context.sessionManager.getBranch()];
    this.persistedToolResults = persistedToolResultIds(persisted);
    return { persisted, live: this.live.projectLiveEntries(persisted, this.persistedToolResults) };
  }

  liveEntries(): unknown[] {
    return this.live.projectLiveEntries([], this.persistedToolResults);
  }

  snapshot(): Snapshot {
    const sm = this.context.sessionManager;
    return {
      header: sm.getHeader(),
      leafId: sm.getLeafId()?.slice(0, 512) ?? null,
      sessionName: sm.getSessionName?.()?.slice(0, LIMITS.maxMetadataStringChars),
      isRunning: !this.context.isIdle(),
      workingWord: this.live.workingWord?.slice(0, 512),
      theme: this.snapshotTheme(),
      systemPrompt: this.context.getSystemPrompt().slice(0, LIMITS.maxSystemPromptChars),
      metadata: projectMetadata(this.context),
      ...(this.pendingInputBroker === undefined
        ? {}
        : { pendingInputBroker: this.pendingInputBroker }),
      pendingInputs: this.pendingInputs().slice(-LIMITS.maxPendingInputs),
      entries: [],
    };
  }

  private snapshotTheme(): SnapshotTheme {
    const themeKey = this.automaticTheme
      ? `auto:${this.automaticTheme.join("/")}`
      : `single:${this.context.ui.theme.name}`;
    if (this.cachedTheme?.key !== themeKey) {
      let value: SnapshotTheme;
      if (this.automaticTheme && this.automaticPalette) {
        value = this.automaticPalette;
      } else {
        const palette = themePalette(this.context.ui.theme, this.context.ui.theme.name === "light");
        value = { auto: false, light: palette, dark: palette };
      }
      this.cachedTheme = { key: themeKey, value };
    }
    return this.cachedTheme.value;
  }
}

function persistedToolResultIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const message = (entry as { message?: { role?: string; toolCallId?: string } }).message;
    if (message?.role === "toolResult" && message.toolCallId) ids.add(message.toolCallId);
  }
  return ids;
}
