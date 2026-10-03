import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT =
  "Name coding sessions. Return only a concise 3-5 word lowercase title with no quotes, punctuation, or explanation.";
const ATTEMPT_ENTRY = "automatic-session-name-attempt";
const TIMEOUT_MS = 25_000;
type NamingContext = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">;
type GenerateName = (
  ctx: NamingContext,
  transcript: string,
  signal: AbortSignal,
) => Promise<string | null>;

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function firstExchangeTranscript(ctx: NamingContext): string | null {
  let user = "";
  let assistant = "";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    if (!user && entry.message.role === "user") user = textContent(entry.message.content).trim();
    else if (user && !assistant && entry.message.role === "assistant")
      assistant = textContent(entry.message.content).trim();
    if (user && assistant) break;
  }
  if (!user || !assistant) return null;
  return `User request:\n${user.slice(0, 1_200)}\n\nAssistant outcome:\n${assistant.slice(0, 1_200)}`.slice(
    0,
    2_400,
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
  const words = title.split(" ");
  if (words.length < 3 || words.length > 5 || title.length > 60) return null;
  return words.every((word) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(word)) ? title : null;
}

export async function generateSessionName(
  ctx: NamingContext,
  transcript: string,
  signal: AbortSignal,
): Promise<string | null> {
  const model =
    (ctx.model ? ctx.modelRegistry.find(ctx.model.provider, "gpt-5.6-luna") : undefined) ??
    ctx.model;
  if (!model || signal.aborted) return null;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    onAbort = () => {
      controller.abort();
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onAbort, TIMEOUT_MS);
  });
  try {
    if (signal.aborted) return null;
    const generated = ctx.modelRegistry
      .complete(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Create a title for this exchange:\n\n${transcript}`,
              timestamp: Date.now(),
            },
          ],
          tools: [],
        },
        { signal: controller.signal, maxTokens: 128 },
      )
      .then(
        (message) => {
          if (message.stopReason === "error" || message.stopReason === "aborted") return null;
          return normalizeSessionName(textContent(message.content));
        },
        () => null,
      );
    return await Promise.race([generated, cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function createAutomaticSessionNameExtension(
  generateName: GenerateName = generateSessionName,
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
      if (
        attempted ||
        nameWasTouched ||
        pi.getSessionName() !== undefined ||
        !ctx.sessionManager.getSessionFile()
      )
        return;
      const transcript = firstExchangeTranscript(ctx);
      if (!transcript) return;
      attempted = true;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        pi.appendEntry(ATTEMPT_ENTRY, { sessionId });
      } catch {
        /* Keep the in-memory attempt guard if persistence fails. */
      }
      const token = { epoch, sessionId, controller: new AbortController() };
      active = token;
      void generateName(ctx, transcript, token.controller.signal)
        .then((name) => {
          if (
            !name ||
            active !== token ||
            token.controller.signal.aborted ||
            token.epoch !== epoch ||
            ctx.sessionManager.getSessionId() !== token.sessionId ||
            nameWasTouched ||
            pi.getSessionName() !== undefined
          )
            return;
          const normalized = normalizeSessionName(name);
          if (!normalized) return;
          settingAutomaticName = true;
          try {
            pi.setSessionName(normalized);
          } finally {
            settingAutomaticName = false;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (active === token) active = undefined;
        });
    });
    pi.on("session_shutdown", invalidate);
  };
}

export default createAutomaticSessionNameExtension();
