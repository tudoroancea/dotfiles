interface LiveTool {
  toolCallId: string;
  toolName: string;
  content: unknown[];
  details: unknown;
  isError: boolean;
  isPartial: boolean;
  hasResult: boolean;
  timestamp: string | undefined;
}

function normalizeResultContent(raw: unknown): { content: unknown[]; details: unknown } {
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    const record = raw as { content: unknown[]; details?: unknown };
    return { content: record.content, details: record.details };
  }
  if (typeof raw === "string") {
    return { content: [{ type: "text", text: raw }], details: undefined };
  }
  if (raw == null) return { content: [], details: undefined };
  return { content: [{ type: "text", text: JSON.stringify(raw) }], details: undefined };
}

export class LiveSessionProjection {
  workingWord: string | undefined;
  private assistant: { message: unknown; timestamp: string } | undefined;
  private readonly tools = new Map<string, LiveTool>();

  projectEntries(branch: unknown[]): unknown[] {
    return [...branch, ...this.projectLiveEntries(branch)];
  }

  projectLiveEntries(
    branch: readonly unknown[],
    knownPersistedResults?: ReadonlySet<string>,
  ): unknown[] {
    const entries: unknown[] = [];
    if (this.assistant && displayableAssistant(this.assistant.message)) {
      entries.push({
        type: "message",
        id: "live-assistant",
        parentId: null,
        timestamp: this.assistant.timestamp,
        message: this.assistant.message,
      });
    }

    const persistedResults = new Set(knownPersistedResults);
    for (const entry of knownPersistedResults ? [] : branch) {
      const record = entry as { type?: string; message?: { role?: string; toolCallId?: string } };
      if (
        record.type === "message" &&
        record.message?.role === "toolResult" &&
        record.message.toolCallId
      ) {
        persistedResults.add(record.message.toolCallId);
      }
    }
    for (const tool of this.tools.values()) {
      if (!tool.hasResult || persistedResults.has(tool.toolCallId)) continue;
      entries.push({
        type: "message",
        id: `live-tr-${tool.toolCallId}`,
        parentId: null,
        timestamp: tool.timestamp,
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
    return entries;
  }

  setWorkingWord(data: unknown): void {
    const message = (data as { message?: unknown } | undefined)?.message;
    this.workingWord = typeof message === "string" ? message : undefined;
  }

  messageStart(event: unknown): void {
    const message = (
      event as { message?: { role?: string; content?: unknown; timestamp?: unknown } }
    ).message;
    if (message?.role === "assistant") {
      this.assistant = { message, timestamp: messageTimestamp(message) };
    }
  }

  messageUpdate(event: unknown): void {
    const message = (event as { message?: { role?: string; timestamp?: unknown } }).message;
    if (message?.role === "assistant") {
      this.assistant = {
        message,
        timestamp: this.assistant?.timestamp ?? messageTimestamp(message),
      };
    }
  }

  messageEnd(event: unknown): void {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") this.assistant = undefined;
  }

  toolStart(event: unknown): void {
    const typed = event as { toolCallId: string; toolName: string };
    this.tools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content: [],
      details: undefined,
      isError: false,
      isPartial: true,
      hasResult: false,
      timestamp: undefined,
    });
  }

  toolUpdate(event: unknown): void {
    const typed = event as { toolCallId: string; toolName: string; partialResult: unknown };
    const { content, details } = normalizeResultContent(typed.partialResult);
    const previous = this.tools.get(typed.toolCallId);
    const hasResult = content.length > 0;
    this.tools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content,
      details,
      isError: false,
      isPartial: true,
      hasResult,
      timestamp: previous?.timestamp ?? (hasResult ? new Date().toISOString() : undefined),
    });
  }

  toolEnd(event: unknown): void {
    const typed = event as {
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
    const { content, details } = normalizeResultContent(typed.result);
    const previous = this.tools.get(typed.toolCallId);
    this.tools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content,
      details,
      isError: typed.isError,
      isPartial: false,
      hasResult: true,
      timestamp: previous?.timestamp ?? new Date().toISOString(),
    });
  }

  clearLive(): void {
    this.assistant = undefined;
    this.tools.clear();
  }

  reset(): void {
    this.clearLive();
  }
}

function messageTimestamp(message: { timestamp?: unknown }): string {
  return typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString();
}

function displayableAssistant(value: unknown): boolean {
  const content = (value as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    if (!item || typeof item !== "object") return false;
    const part = item as { type?: unknown; text?: unknown; thinking?: unknown };
    return (
      (typeof part.text === "string" && part.text.length > 0) ||
      (typeof part.thinking === "string" && part.thinking.length > 0) ||
      part.type === "toolCall"
    );
  });
}
