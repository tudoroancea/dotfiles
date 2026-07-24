import { Fragment } from "preact";
import type {
  PersistedEntry,
  ProjectedMessage,
  SessionState,
  ToolExecution,
} from "../../shared/wire.js";
import { asArray, asRecord, normalizeTool } from "../lib/tool-model.js";
import { JsonView } from "./JsonView.js";
import { CustomMessageView, MessageView } from "./Message.js";
import { ToolCall } from "./ToolCall.js";

const INTERNAL_CUSTOM_TYPE = "web-ui-startup";

interface PersistedToolCall {
  name: string;
  args: Record<string, unknown>;
}

function collectToolCalls(entries: readonly PersistedEntry[]): Map<string, PersistedToolCall> {
  const calls = new Map<string, PersistedToolCall>();
  for (const entry of entries) {
    if (entry.entryType !== "message") continue;
    const message = asRecord(asRecord(entry.payload).message);
    if (message.role !== "assistant") continue;
    for (const block of asArray(message.content)) {
      const call = asRecord(block);
      if (call.type !== "toolCall" || typeof call.id !== "string") continue;
      calls.set(call.id, {
        name: typeof call.name === "string" ? call.name : "tool",
        args: asRecord(call.arguments),
      });
    }
  }
  return calls;
}

function EntryView({
  entry,
  toolCalls,
}: {
  entry: PersistedEntry;
  toolCalls: ReadonlyMap<string, PersistedToolCall>;
}) {
  const payload = asRecord(entry.payload);

  if (entry.entryType === "message") {
    return <MessageView message={payload.message as ProjectedMessage} toolCalls={toolCalls} />;
  }

  if (entry.entryType === "custom_message") {
    const customType = typeof payload.customType === "string" ? payload.customType : "custom";
    if (payload.display === false) return null;
    return (
      <CustomMessageView
        customType={customType}
        content={asArray(payload.content)}
        details={asRecord(payload.details)}
      />
    );
  }

  if (entry.entryType === "custom" || entry.entryType === "web-ui-startup") return null;

  return (
    <article class="message message--custom">
      <div class="message__gutter" aria-hidden="true">
        <span class="message__glyph">·</span>
      </div>
      <div class="message__body">
        <div class="message__byline">{entry.entryType}</div>
        <JsonView value={payload} />
      </div>
    </article>
  );
}

function isRenderable(entry: PersistedEntry): boolean {
  const payload = asRecord(entry.payload);
  if (payload.customType === INTERNAL_CUSTOM_TYPE) return false;
  return true;
}

function messageIdentity(message: ProjectedMessage): string {
  return [
    message.role,
    message.timestamp ?? "",
    message.toolCallId ?? "",
    message.customType ?? "",
  ].join(":");
}

function persistedMessageState(entries: readonly PersistedEntry[]) {
  const messages = new Set<string>();
  const toolResults = new Set<string>();
  for (const entry of entries) {
    if (entry.entryType !== "message") continue;
    const message = asRecord(asRecord(entry.payload).message) as ProjectedMessage;
    messages.add(messageIdentity(message));
    if (message.role === "toolResult" && message.toolCallId) toolResults.add(message.toolCallId);
  }
  return { messages, toolResults };
}

function messageToolIds(message: ProjectedMessage): string[] {
  return asArray(message.content)
    .map(asRecord)
    .filter((block) => block.type === "toolCall" && typeof block.id === "string")
    .map((block) => block.id as string);
}

function LiveSequence({
  messages,
  partial,
  tools,
}: {
  messages: readonly ProjectedMessage[];
  partial?: ProjectedMessage;
  tools: readonly ToolExecution[];
}) {
  const byId = new Map(tools.map((tool) => [tool.toolCallId, tool]));
  const rendered = new Set<string>();
  const afterMessage = (message: ProjectedMessage) =>
    messageToolIds(message)
      .map((id) => byId.get(id))
      .filter((tool): tool is ToolExecution => Boolean(tool));

  return (
    <>
      {messages.map((message, index) => {
        if (message.role === "toolResult" && message.toolCallId && byId.has(message.toolCallId))
          return null;
        const associated = afterMessage(message);
        for (const tool of associated) rendered.add(tool.toolCallId);
        return (
          <Fragment key={`final-${message.timestamp ?? index}`}>
            <MessageView message={message} />
            {associated.map((tool) => (
              <ToolCall key={tool.toolCallId} view={normalizeTool(tool)} />
            ))}
          </Fragment>
        );
      })}
      {partial ? (
        <Fragment>
          <MessageView message={partial} partial />
          {afterMessage(partial).map((tool) => {
            rendered.add(tool.toolCallId);
            return <ToolCall key={tool.toolCallId} view={normalizeTool(tool)} />;
          })}
        </Fragment>
      ) : null}
      {tools
        .filter((tool) => !rendered.has(tool.toolCallId))
        .map((tool) => (
          <ToolCall key={tool.toolCallId} view={normalizeTool(tool)} />
        ))}
    </>
  );
}

/** The conversation timeline: persisted branch plus live overlays. */
export function Timeline({ state }: { state: SessionState }) {
  const { persisted, live } = state;
  const entries = persisted.entries.filter(isRenderable);
  const persistedLive = persistedMessageState(entries);
  const liveMessages = live.finalizedMessages.filter(
    (message) => !persistedLive.messages.has(messageIdentity(message)),
  );
  const tools = [...live.tools]
    .filter((tool) => !persistedLive.toolResults.has(tool.toolCallId))
    .sort((left, right) => left.ordinal - right.ordinal);
  const toolCalls = collectToolCalls(entries);
  const isEmpty =
    entries.length === 0 &&
    live.finalizedMessages.length === 0 &&
    !live.partialAssistant &&
    tools.length === 0;

  if (isEmpty) {
    return (
      <div class="timeline timeline--empty">
        <p class="timeline__empty">
          No activity yet. Send a prompt to start driving this Pi session.
        </p>
      </div>
    );
  }

  return (
    <div class="timeline">
      {persisted.entriesTruncated ? (
        <p class="timeline__truncated">Earlier history is not shown.</p>
      ) : null}
      {entries.map((entry) => (
        <EntryView key={entry.id} entry={entry} toolCalls={toolCalls} />
      ))}
      <LiveSequence
        messages={liveMessages}
        {...(live.partialAssistant ? { partial: live.partialAssistant } : {})}
        tools={tools}
      />
    </div>
  );
}
