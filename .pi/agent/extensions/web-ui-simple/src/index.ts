import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  getPackageDir,
  SettingsManager,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  fallbackFileCompletions,
  mentionCompletions,
  type PendingInput,
  type SessionMetadata,
  type Snapshot,
  type SnapshotTheme,
  startServer,
  type ThemePalette,
  type WebUiServer,
} from "./server.js";

export {
  type CompletionItem,
  fallbackFileCompletions,
  mentionCompletions,
  startServer,
  type InputDelivery,
  type PendingInput,
  type SessionMetadata,
  type Snapshot,
  type SnapshotTheme,
  type WebUiServer,
} from "./server.js";

// ---------------------------------------------------------------------------
// A deliberately tiny browser companion for the current Pi session.
//
// The whole surface is: a Node loopback HTTP server that serves a static Preact
// app shell and streams a fresh full snapshot of the active branch over SSE.
// There is no wire protocol, no reducer, no pagination — every relevant Pi
// event simply re-broadcasts the current transcript.
// ---------------------------------------------------------------------------

const BROADCAST_DEBOUNCE_MS = 60;
const PROMPT_ADMISSION_TTL_MS = 30_000;

interface TailscaleServe {
  close(): Promise<void>;
}

interface LiveTool {
  toolCallId: string;
  toolName: string;
  content: unknown[];
  details: unknown;
  isError: boolean;
  isPartial: boolean;
  hasResult: boolean;
}

function normalizeResultContent(raw: unknown): { content: unknown[]; details: unknown } {
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    const record = raw as { content: unknown[]; details?: unknown };
    return { content: record.content, details: record.details };
  }
  if (typeof raw === "string")
    return { content: [{ type: "text", text: raw }], details: undefined };
  if (raw == null) return { content: [], details: undefined };
  return { content: [{ type: "text", text: JSON.stringify(raw) }], details: undefined };
}

function ansi256ToHex(index: number): string {
  const basic = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];
  if (index < 16) return basic[index];
  if (index < 232) {
    const cube = index - 16;
    const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    return `#${[Math.floor(cube / 36), Math.floor((cube % 36) / 6), cube % 6]
      .map((value) => channel(value).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  const gray = Math.min(255, 8 + (index - 232) * 10)
    .toString(16)
    .padStart(2, "0");
  return `#${gray}${gray}${gray}`;
}

function ansiToHex(ansi: string, fallback: string): string {
  const rgb = ansi.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
  if (rgb) {
    return `#${rgb
      .slice(1)
      .map((value) => Number(value).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  const indexed = ansi.match(/\x1b\[(?:38|48);5;(\d+)m/);
  return indexed ? ansi256ToHex(Number(indexed[1])) : fallback;
}

function colorLuminance(color: string): number {
  const channels = color
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function adjustColor(color: string, factor: number): string {
  return `#${color
    .slice(1)
    .match(/.{2}/g)!
    .map((value) =>
      Math.min(255, Math.round(Number.parseInt(value, 16) * factor))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const THEME_FOREGROUND: readonly ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
];

const THEME_BACKGROUNDS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

function themePalette(theme: Theme, light: boolean): ThemePalette {
  const palette: ThemePalette = {};
  const base = ansiToHex(theme.getBgAnsi("userMessageBg"), light ? "#e8e8e8" : "#343541");
  const isLight = colorLuminance(base) > 0.5;
  const fallbackText = isLight ? "#1f2328" : "#e5e5e7";
  for (const name of THEME_FOREGROUND) {
    palette[name] = ansiToHex(theme.getFgAnsi(name), fallbackText);
  }
  for (const name of THEME_BACKGROUNDS) {
    palette[name] = ansiToHex(theme.getBgAnsi(name), base);
  }
  return completePalette(palette);
}

function completePalette(palette: ThemePalette): ThemePalette {
  palette.thinkingMax ??= palette.thinkingXhigh;
  palette.hover = palette.selectedBg;
  const base = palette.userMessageBg;
  const isLight = colorLuminance(base) > 0.5;
  palette["body-bg"] = adjustColor(base, isLight ? 1.03 : 0.7);
  palette["container-bg"] = adjustColor(base, isLight ? 1 : 0.85);
  palette.colorScheme = isLight ? "light" : "dark";
  return palette;
}

function resolveThemeValue(
  value: unknown,
  variables: Record<string, unknown>,
  visited = new Set<string>(),
): string | number {
  if (
    typeof value === "number" ||
    value === "" ||
    (typeof value === "string" && value.startsWith("#"))
  ) {
    return value;
  }
  if (typeof value !== "string" || visited.has(value) || !(value in variables)) {
    throw new Error("Invalid theme color");
  }
  visited.add(value);
  return resolveThemeValue(variables[value], variables, visited);
}

async function themePaletteFromFile(
  name: string,
  light: boolean,
): Promise<ThemePalette | undefined> {
  const paths = [
    join(getAgentDir(), "themes", `${name}.json`),
    join(getPackageDir(), "dist", "modes", "interactive", "theme", `${name}.json`),
  ];
  for (const path of paths) {
    try {
      const json = JSON.parse(await readFile(path, "utf8")) as {
        vars?: Record<string, unknown>;
        colors?: Record<string, unknown>;
      };
      if (!json.colors) continue;
      const variables = json.vars ?? {};
      const resolved = Object.fromEntries(
        Object.entries(json.colors).map(([key, value]) => [
          key,
          resolveThemeValue(value, variables),
        ]),
      );
      const baseValue = resolved.userMessageBg;
      const base =
        typeof baseValue === "number"
          ? ansi256ToHex(baseValue)
          : baseValue || (light ? "#e8e8e8" : "#343541");
      const isLight = colorLuminance(base) > 0.5;
      const fallbackText = isLight ? "#1f2328" : "#e5e5e7";
      const palette = Object.fromEntries(
        Object.entries(resolved).map(([key, value]) => [
          key,
          typeof value === "number"
            ? ansi256ToHex(value)
            : value || (key.endsWith("Bg") ? base : fallbackText),
        ]),
      );
      return completePalette(palette);
    } catch {
      // Try the next standard theme location.
    }
  }
  return undefined;
}

function parseAutomaticTheme(setting: string | undefined): [string, string] | undefined {
  if (!setting) return undefined;
  const names = setting.split("/").map((name) => name.trim());
  return names.length === 2 && names.every(Boolean) ? [names[0], names[1]] : undefined;
}

function sessionCost(context: ExtensionContext): number {
  let unkeyed = 0;
  const keyed = new Map<string, number>();
  const addDetails = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const details = value as { cost?: unknown; costId?: unknown; costs?: unknown };
    if (typeof details.cost === "number" && Number.isFinite(details.cost) && details.cost >= 0) {
      if (typeof details.costId === "string") {
        keyed.set(details.costId, Math.max(keyed.get(details.costId) ?? 0, details.cost));
      } else unkeyed += details.cost;
    }
    if (!Array.isArray(details.costs)) return;
    for (const item of details.costs) {
      if (!item || typeof item !== "object") continue;
      const record = item as { costId?: unknown; cost?: unknown };
      if (
        typeof record.costId === "string" &&
        typeof record.cost === "number" &&
        Number.isFinite(record.cost) &&
        record.cost >= 0
      ) {
        keyed.set(record.costId, Math.max(keyed.get(record.costId) ?? 0, record.cost));
      }
    }
  };

  const addUsage = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const total = (value as { cost?: { total?: unknown } }).cost?.total;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) unkeyed += total;
  };

  for (const candidate of context.sessionManager.getEntries()) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as unknown as Record<string, unknown>;
    if (entry.type === "custom" && entry.customType === "agentflow-cost") {
      addDetails(entry.data);
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "agentflow-result") {
      addDetails(entry.details);
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(entry.usage);
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === "assistant" || message.role === "toolResult") addUsage(message.usage);
    if (message.role === "toolResult" || message.role === "custom") addDetails(message.details);
  }
  return unkeyed + [...keyed.values()].reduce((sum, cost) => sum + cost, 0);
}

function projectMetadata(context: ExtensionContext): SessionMetadata {
  const usage = context.getContextUsage();
  return {
    cwd: String(context.cwd).slice(0, 4096),
    home: homedir().slice(0, 4096),
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
    thinkingLevel: context.thinkingLevel,
  };
}

function startTailscaleServe(
  localOrigin: string,
  port: number,
  onReady: (origin: string) => void,
  onFailure: (reason: string) => void,
): TailscaleServe {
  const child = spawn("tailscale", ["serve", "--yes", `--https=${port}`, localOrigin], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  let ready = false;
  let closing = false;
  let failureReported = false;
  let processClosed = false;
  const emergencyCleanup = () => killProcessTree("SIGTERM");
  process.once("exit", emergencyCleanup);
  const closed = new Promise<void>((resolvePromise) => {
    child.once("close", () => {
      processClosed = true;
      process.off("exit", emergencyCleanup);
      resolvePromise();
    });
  });

  function inspectOutput(chunk: Buffer): void {
    output = (output + chunk.toString("utf8")).slice(-8192);
    const match = output.match(/https:\/\/[^\s/]+\.ts\.net(?::\d+)?/i);
    if (!match || ready) return;
    ready = true;
    onReady(match[0]);
  }

  function reportFailure(reason: string): void {
    if (closing || failureReported) return;
    failureReported = true;
    onFailure(reason);
  }

  function killProcessTree(signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process group may already have exited; fall back to the direct child.
      }
    }
    child.kill(signal);
  }

  function waitForClose(timeoutMs: number): Promise<boolean> {
    if (processClosed) return Promise.resolve(true);
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), timeoutMs);
      void closed.then(() => {
        clearTimeout(timer);
        resolvePromise(true);
      });
    });
  }

  child.stdout.on("data", inspectOutput);
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput = (errorOutput + chunk.toString("utf8")).slice(-4096);
    inspectOutput(chunk);
  });
  child.on("error", (error) => reportFailure(error.message));
  child.on("exit", (code, signal) => {
    if (closing) return;
    const detail = errorOutput.trim().split("\n").at(-1);
    reportFailure(
      detail ||
        (signal
          ? `tailscale serve stopped (${signal})`
          : `tailscale serve exited with code ${code ?? "unknown"}`),
    );
  });

  return {
    async close() {
      closing = true;
      if (processClosed) return;
      killProcessTree("SIGTERM");
      if (await waitForClose(2000)) return;
      killProcessTree("SIGKILL");
      await waitForClose(1000);
    },
  };
}

export default function webUiSimpleExtension(pi: ExtensionAPI): void {
  let server: WebUiServer | undefined;
  let tailscaleServe: TailscaleServe | undefined;
  let remoteOrigin: string | undefined;
  let context: ExtensionContext | undefined;
  let broadcastTimer: NodeJS.Timeout | undefined;
  let automaticTheme: [string, string] | undefined;
  let automaticPalette: SnapshotTheme | undefined;
  let cachedTheme: { key: string; value: SnapshotTheme } | undefined;
  let workingWord: string | undefined;
  let autocompleteProvider: AutocompleteProvider | undefined;
  let promptAdmission = false;
  let promptAdmissionTimer: NodeJS.Timeout | undefined;
  let pendingAdmission: { content: string; resolve: (accepted: boolean) => void } | undefined;

  // Live overlay: streaming assistant message plus in-progress tool executions
  // that are not yet persisted into the branch.
  let liveAssistant: unknown | undefined;
  const liveTools = new Map<string, LiveTool>();
  let pendingInputs: PendingInput[] = [];

  function buildSnapshot(): Snapshot {
    if (!context) {
      return {
        header: null,
        leafId: null,
        sessionName: undefined,
        isRunning: false,
        workingWord: undefined,
        theme: undefined,
        systemPrompt: "",
        metadata: undefined,
        pendingInputs: [],
        entries: [],
      };
    }
    const sm = context.sessionManager;
    const themeKey = automaticTheme
      ? `auto:${automaticTheme.join("/")}`
      : `single:${context.ui.theme.name}`;
    if (cachedTheme?.key !== themeKey) {
      let value: SnapshotTheme;
      if (automaticTheme && automaticPalette) {
        value = automaticPalette;
      } else {
        const palette = themePalette(context.ui.theme, context.ui.theme.name === "light");
        value = { auto: false, light: palette, dark: palette };
      }
      cachedTheme = { key: themeKey, value };
    }
    const snapshotTheme = cachedTheme.value;
    const entries: unknown[] = [...sm.getBranch()];

    if (liveAssistant) {
      entries.push({
        type: "message",
        id: "live-assistant",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: liveAssistant,
      });
    }

    const persistedResults = new Set<string>();
    for (const entry of entries) {
      const record = entry as { type?: string; message?: { role?: string; toolCallId?: string } };
      if (
        record.type === "message" &&
        record.message?.role === "toolResult" &&
        record.message.toolCallId
      ) {
        persistedResults.add(record.message.toolCallId);
      }
    }
    for (const tool of liveTools.values()) {
      if (!tool.hasResult || persistedResults.has(tool.toolCallId)) continue;
      entries.push({
        type: "message",
        id: `live-tr-${tool.toolCallId}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          content: tool.content,
          details: tool.details,
          isError: tool.isError,
          isPartial: tool.isPartial,
        },
      });
    }

    return {
      header: sm.getHeader(),
      leafId: sm.getLeafId(),
      sessionName: sm.getSessionName?.(),
      isRunning: !context.isIdle(),
      workingWord,
      theme: snapshotTheme,
      systemPrompt: context.getSystemPrompt(),
      metadata: projectMetadata(context),
      pendingInputs,
      entries,
    };
  }

  function scheduleBroadcast(): void {
    if (!server || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      server?.broadcast();
    }, BROADCAST_DEBOUNCE_MS);
    broadcastTimer.unref?.();
  }

  function clearLive(): void {
    liveAssistant = undefined;
    liveTools.clear();
  }

  function settlePromptAdmission(accepted: boolean): void {
    promptAdmission = false;
    if (promptAdmissionTimer) clearTimeout(promptAdmissionTimer);
    promptAdmissionTimer = undefined;
    const pending = pendingAdmission;
    pendingAdmission = undefined;
    pending?.resolve(accepted);
  }

  async function copyUrl(commandContext: ExtensionCommandContext, origin?: string): Promise<void> {
    if (!server) {
      commandContext.ui.notify("Pi Web UI (simple) is not running in this mode.", "error");
      return;
    }
    const url = server.bootstrapUrl(origin);
    if (commandContext.mode === "rpc") {
      commandContext.ui.notify(url, "info");
      return;
    }
    try {
      await copyToClipboard(url);
      commandContext.ui.notify(
        origin ? "Remote Web UI link copied." : "Local Web UI link copied.",
        "info",
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "clipboard unavailable";
      commandContext.ui.notify(`Could not copy Web UI link: ${reason}`, "error");
    }
  }

  pi.registerCommand("copy-url", {
    description: "Copy a local authenticated Pi Web UI link",
    handler: async (_args: string, commandContext: ExtensionCommandContext): Promise<void> => {
      await copyUrl(commandContext);
    },
  });

  pi.registerCommand("copy-remote-url", {
    description: "Copy a tailnet-authenticated Pi Web UI link",
    handler: async (_args: string, commandContext: ExtensionCommandContext): Promise<void> => {
      if (!remoteOrigin) {
        commandContext.ui.notify(
          tailscaleServe
            ? "The remote Web UI is still starting. Try again shortly."
            : "The remote Web UI is unavailable. Check that Tailscale is installed and connected.",
          "error",
        );
        return;
      }
      await copyUrl(commandContext, remoteOrigin);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    if (tailscaleServe) await tailscaleServe.close();
    if (server) await server.close();
    tailscaleServe = undefined;
    remoteOrigin = undefined;
    clearLive();
    pendingInputs = [];
    context = ctx;
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    automaticTheme = parseAutomaticTheme(settings.getThemeSetting());
    if (automaticTheme) {
      const lightTheme = ctx.ui.getTheme(automaticTheme[0]);
      const darkTheme = ctx.ui.getTheme(automaticTheme[1]);
      const light =
        (lightTheme && themePalette(lightTheme, true)) ??
        (await themePaletteFromFile(automaticTheme[0], true));
      const dark =
        (darkTheme && themePalette(darkTheme, false)) ??
        (await themePaletteFromFile(automaticTheme[1], false));
      if (light && dark) automaticPalette = { auto: true, light, dark };
      else automaticTheme = undefined;
    }
    autocompleteProvider = undefined;
    ctx.ui.addAutocompleteProvider((current) => {
      autocompleteProvider = current;
      return current;
    });
    if (!autocompleteProvider) {
      const managedFd = join(getAgentDir(), "bin", process.platform === "win32" ? "fd.exe" : "fd");
      let fdPath: string | undefined;
      try {
        await access(managedFd);
        fdPath = managedFd;
      } catch {
        const lookup = await pi.exec(process.platform === "win32" ? "where" : "which", ["fd"]);
        if (lookup.code === 0) fdPath = lookup.stdout.trim().split(/\r?\n/)[0];
      }
      if (fdPath) autocompleteProvider = new CombinedAutocompleteProvider([], ctx.cwd, fdPath);
    }
    server = await startServer(buildSnapshot, {
      submitInput: async (content, delivery) => {
        if (!context || context !== ctx) return { accepted: false, error: "Session changed" };
        const idle = context.isIdle();
        if (delivery === "immediate") {
          if (!idle || promptAdmission) {
            return { accepted: false, error: "Pi is busy; choose Steer or Queue" };
          }
          if (!context.model) return { accepted: false, error: "No model is selected" };
          if (!(await context.modelRegistry.getProviderAuth(context.model.provider))) {
            return { accepted: false, error: "The selected model is not authenticated" };
          }
          if (context !== ctx) return { accepted: false, error: "Session changed" };
          if (!context.isIdle() || promptAdmission) {
            return { accepted: false, error: "Pi is busy; choose Steer or Queue" };
          }
          promptAdmission = true;
          const admitted = new Promise<boolean>((resolve) => {
            pendingAdmission = { content, resolve };
          });
          promptAdmissionTimer = setTimeout(
            () => settlePromptAdmission(false),
            PROMPT_ADMISSION_TTL_MS,
          );
          promptAdmissionTimer.unref?.();
          try {
            pi.sendUserMessage(content);
          } catch (error) {
            settlePromptAdmission(false);
            throw error;
          }
          if (!(await admitted)) {
            return { accepted: false, error: "Pi did not accept the message" };
          }
        } else {
          if (idle) return { accepted: false, error: "Pi is idle; send a prompt instead" };
          pi.sendUserMessage(content, { deliverAs: delivery });
          pendingInputs = [
            ...pendingInputs,
            { id: randomBytes(8).toString("base64url"), content, delivery },
          ];
          scheduleBroadcast();
        }
        return { accepted: true };
      },
      completeMention: (query, signal) =>
        autocompleteProvider
          ? mentionCompletions(autocompleteProvider, query, signal)
          : fallbackFileCompletions(ctx.cwd, query, signal),
    });
    const activeServer = server;
    tailscaleServe = startTailscaleServe(
      activeServer.origin,
      activeServer.port,
      (origin) => {
        if (server !== activeServer) return;
        remoteOrigin = origin;
        if (ctx.mode === "tui") {
          ctx.ui.notify("Remote Web UI ready — use /copy-remote-url.", "info");
        } else {
          process.stderr.write(`Pi Web UI (simple, tailnet): ${origin}\n`);
        }
      },
      (reason) => {
        if (server !== activeServer) return;
        tailscaleServe = undefined;
        remoteOrigin = undefined;
        const message = `Remote Web UI unavailable: ${reason}`;
        if (ctx.mode === "tui") ctx.ui.notify(message, "warning");
        else process.stderr.write(`Pi Web UI (simple): ${message}\n`);
      },
    );
    if (ctx.mode === "tui") {
      ctx.ui.notify(
        `Pi Web UI (simple): ${server.url} — use /copy-url locally or /copy-remote-url from your tailnet.`,
        "info",
      );
    } else {
      process.stderr.write(`Pi Web UI (simple, local): ${server.url}\n`);
    }
  });

  pi.on("input", (event) => {
    if (
      event.source === "extension" &&
      pendingAdmission &&
      event.text === pendingAdmission.content
    ) {
      settlePromptAdmission(true);
    }
  });

  pi.events.on("working-word:change", (data) => {
    const message = (data as { message?: unknown } | undefined)?.message;
    workingWord = typeof message === "string" ? message : undefined;
    scheduleBroadcast();
  });

  pi.on("agent_start", () => scheduleBroadcast());
  pi.on("message_start", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "user") {
      const content = (message as { content?: unknown }).content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((item) => item?.type === "text" && typeof item.text === "string")
                .map((item) => item.text)
                .join("")
            : "";
      if (pendingAdmission && text === pendingAdmission.content) settlePromptAdmission(true);
      let pendingIndex = pendingInputs.findIndex(
        (item) => item.content === text && item.delivery === "steer",
      );
      if (pendingIndex < 0) pendingIndex = pendingInputs.findIndex((item) => item.content === text);
      if (pendingIndex >= 0) {
        pendingInputs = [
          ...pendingInputs.slice(0, pendingIndex),
          ...pendingInputs.slice(pendingIndex + 1),
        ];
      }
    } else if (message?.role === "assistant") liveAssistant = message;
    scheduleBroadcast();
  });
  pi.on("message_update", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") liveAssistant = message;
    scheduleBroadcast();
  });
  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") liveAssistant = undefined;
    scheduleBroadcast();
  });

  pi.on("tool_execution_start", (event) => {
    const typed = event as { toolCallId: string; toolName: string };
    liveTools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content: [],
      details: undefined,
      isError: false,
      isPartial: true,
      hasResult: false,
    });
    scheduleBroadcast();
  });
  pi.on("tool_execution_update", (event) => {
    const typed = event as { toolCallId: string; toolName: string; partialResult: unknown };
    const { content, details } = normalizeResultContent(typed.partialResult);
    liveTools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content,
      details,
      isError: false,
      isPartial: true,
      hasResult: content.length > 0,
    });
    scheduleBroadcast();
  });
  pi.on("tool_execution_end", (event) => {
    const typed = event as {
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
    const { content, details } = normalizeResultContent(typed.result);
    liveTools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content,
      details,
      isError: typed.isError,
      isPartial: false,
      hasResult: true,
    });
    scheduleBroadcast();
  });

  pi.on("agent_settled", () => {
    clearLive();
    pendingInputs = [];
    scheduleBroadcast();
  });
  pi.on("model_select", () => scheduleBroadcast());
  pi.on("thinking_level_select", () => scheduleBroadcast());
  pi.on("session_tree", () => {
    clearLive();
    pendingInputs = [];
    scheduleBroadcast();
  });
  pi.on("session_compact", () => {
    clearLive();
    scheduleBroadcast();
  });
  pi.on("session_info_changed", () => scheduleBroadcast());

  pi.on("session_shutdown", async () => {
    const active = server;
    const activeTailscaleServe = tailscaleServe;
    server = undefined;
    tailscaleServe = undefined;
    remoteOrigin = undefined;
    context = undefined;
    automaticTheme = undefined;
    automaticPalette = undefined;
    cachedTheme = undefined;
    workingWord = undefined;
    autocompleteProvider = undefined;
    settlePromptAdmission(false);
    pendingInputs = [];
    clearLive();
    if (broadcastTimer) clearTimeout(broadcastTimer);
    if (promptAdmissionTimer) clearTimeout(promptAdmissionTimer);
    broadcastTimer = undefined;
    promptAdmissionTimer = undefined;
    if (activeTailscaleServe) await activeTailscaleServe.close();
    if (active) await active.close();
  });
}
