import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT =
  "Name coding sessions. Return only a concise 3-5 word lowercase title with no quotes, punctuation, or explanation.";
const MAX_TRANSCRIPT_CHARS = 2_400;
const MAX_TITLE_CHARS = 60;
const TIMEOUT_MS = 25_000;
const ATTEMPT_ENTRY = "automatic-session-name-attempt";

type NamingContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "sessionManager">;

type NamingDependencies = {
  generateName: (
    ctx: NamingContext,
    transcript: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
};

const textContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
};

export function firstExchangeTranscript(ctx: NamingContext): string | null {
  let user = "";
  let assistant = "";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!user && message.role === "user") user = textContent(message.content).trim();
    else if (user && !assistant && message.role === "assistant")
      assistant = textContent(message.content).trim();
    if (user && assistant) break;
  }
  if (!user || !assistant) return null;
  return `User request:\n${user.slice(0, 1_200)}\n\nAssistant outcome:\n${assistant.slice(0, 1_200)}`.slice(
    0,
    MAX_TRANSCRIPT_CHARS,
  );
}

export function normalizeSessionName(value: string): string | null {
  const raw = value.trim();
  if (!raw || [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return null;
  const title = raw
    .replace(/^#{1,6}\s*/, "")
    .replace(/^["'`*_\s]+|["'`*_\s]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const words = title.split(" ").filter(Boolean);
  if (words.length < 3 || words.length > 5 || title.length > MAX_TITLE_CHARS) return null;
  if (!words.every((word) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(word))) return null;
  return title;
}

export function selectNamingModel(ctx: NamingContext): Model<any> | undefined {
  const provider = ctx.model?.provider;
  return (provider ? ctx.modelRegistry.find(provider, "gpt-5.6-luna") : undefined) ?? ctx.model;
}

export async function generateSessionName(
  ctx: NamingContext,
  transcript: string,
  signal: AbortSignal,
): Promise<string | null> {
  const model = selectNamingModel(ctx);
  if (!model || signal.aborted) return null;

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  if (signal.aborted) return null;

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager,
    model,
    modelRegistry: ctx.modelRegistry,
    thinkingLevel: "low",
    noTools: "all",
  });

  const abortChild = () => void session.abort().catch(() => undefined);
  let settleAbort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    settleAbort = () => {
      abortChild();
      resolve("aborted");
    };
    signal.addEventListener("abort", settleAbort, { once: true });
  });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      abortChild();
      resolve("timeout");
    }, TIMEOUT_MS);
  });
  try {
    if (signal.aborted) return null;
    const prompted = session
      .prompt(`Create a title for this exchange:\n\n${transcript}`, {
        expandPromptTemplates: false,
        source: "extension",
      })
      .then(
        () => "completed" as const,
        () => "failed" as const,
      );
    const outcome = await Promise.race([prompted, aborted, timedOut]);
    if (outcome !== "completed" || signal.aborted) return null;
    const last = [...session.messages]
      .reverse()
      .find(
        (message): message is Extract<AgentMessage, { role: "assistant" }> =>
          message.role === "assistant",
      );
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") return null;
    return normalizeSessionName(textContent(last.content));
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", settleAbort);
    session.dispose();
  }
}

export function createAutomaticSessionNameExtension(
  dependencies: NamingDependencies = { generateName: generateSessionName },
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let epoch = 0;
    let attempted = false;
    let nameWasTouched = false;
    let settingAutomaticName = false;
    let active: { epoch: number; sessionId: string; controller: AbortController } | undefined;

    const invalidate = () => {
      epoch += 1;
      active?.controller.abort();
      active = undefined;
    };

    pi.on("session_start", (_event, ctx) => {
      invalidate();
      const sessionId = ctx.sessionManager.getSessionId();
      const entries = ctx.sessionManager.getEntries();
      attempted = entries.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === ATTEMPT_ENTRY &&
          (entry.data as { sessionId?: unknown } | undefined)?.sessionId === sessionId,
      );
      nameWasTouched =
        pi.getSessionName() !== undefined || entries.some((entry) => entry.type === "session_info");
    });

    pi.on("session_info_changed", () => {
      if (settingAutomaticName) return;
      nameWasTouched = true;
      active?.controller.abort();
      active = undefined;
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (attempted || nameWasTouched || pi.getSessionName() !== undefined) return;
      if (!ctx.sessionManager.getSessionFile()) return;
      const transcript = firstExchangeTranscript(ctx);
      if (!transcript) return;

      attempted = true;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        pi.appendEntry(ATTEMPT_ENTRY, { sessionId });
      } catch {
        // The in-memory guard still prevents duplicate attempts in this runtime.
      }
      const token = {
        epoch,
        sessionId,
        controller: new AbortController(),
      };
      active = token;
      const namingContext: NamingContext = {
        cwd: ctx.cwd,
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        sessionManager: ctx.sessionManager,
      };

      void dependencies
        .generateName(namingContext, transcript, token.controller.signal)
        .then((name) => {
          if (!name || active !== token || token.controller.signal.aborted) return;
          if (token.epoch !== epoch || ctx.sessionManager.getSessionId() !== token.sessionId)
            return;
          if (nameWasTouched || pi.getSessionName() !== undefined) return;
          settingAutomaticName = true;
          try {
            pi.setSessionName(name);
          } finally {
            settingAutomaticName = false;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (active === token) active = undefined;
        });
    });

    pi.on("session_shutdown", () => {
      invalidate();
    });
  };
}

export default createAutomaticSessionNameExtension();
