import { asRecord, normalizeTool, str } from "../lib/tool-model.js";
import { AgentflowSnapshot } from "../render/agentflow.js";
import type { ProjectedMessage } from "../../shared/wire.js";
import { ContentBlocks } from "./ContentBlocks.js";
import { ToolCall } from "./ToolCall.js";

const ROLE_GLYPH: Record<string, string> = {
  user: "›",
  assistant: "◆",
  system: "※",
  toolResult: "▸",
};

function roleGlyph(role: string): string {
  return ROLE_GLYPH[role] ?? "·";
}

/** A projected chat message: user/assistant prose, or a tool result panel. */
export function MessageView({
  message,
  partial = false,
  toolCalls,
}: {
  message: ProjectedMessage;
  partial?: boolean;
  toolCalls?: ReadonlyMap<string, { name: string; args: Record<string, unknown> }>;
}) {
  if (message.role === "toolResult") {
    const call = message.toolCallId ? toolCalls?.get(message.toolCallId) : undefined;
    const view = normalizeTool({
      toolName: message.toolName ?? call?.name ?? "tool",
      args: call?.args,
      result: { content: message.content, details: message.details },
      isError: message.isError === true,
      status: message.isError ? "error" : "completed",
    });
    return <ToolCall view={view} {...(message.toolCallId ? { id: message.toolCallId } : {})} />;
  }

  const role = message.role;
  return (
    <article
      class={`message message--${role}${partial ? " message--partial" : ""}`}
      data-role={role}
    >
      <div class="message__gutter" aria-hidden="true">
        <span class="message__glyph">{roleGlyph(role)}</span>
      </div>
      <div class="message__body">
        <ContentBlocks content={message.content} />
        {message.errorMessage ? <p class="message__error">{message.errorMessage}</p> : null}
        {partial ? (
          <span class="message__caret" aria-label="streaming">
            ▍
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** A persisted custom_message, dispatched by its custom type. */
export function CustomMessageView({
  customType,
  content,
  details,
}: {
  customType: string;
  content: readonly unknown[];
  details: Record<string, unknown>;
}) {
  const snapshot = asRecord(details.snapshot);
  const jobs = Array.isArray(details.jobs) ? details.jobs.map(asRecord) : [];
  return (
    <article class="message message--custom" data-custom={customType}>
      <div class="message__gutter" aria-hidden="true">
        <span class="message__glyph">✳</span>
      </div>
      <div class="message__body">
        <div class="message__byline">{customType.replace(/[-_]/g, " ")}</div>
        <ContentBlocks content={content} />
        {customType === "agentflow-result" && Object.keys(snapshot).length > 0 ? (
          <AgentflowSnapshot snapshot={snapshot} />
        ) : null}
        {jobs.length > 0 ? <CustomJobLines jobs={jobs} /> : null}
      </div>
    </article>
  );
}

function CustomJobLines({ jobs }: { jobs: readonly Record<string, unknown>[] }) {
  return (
    <ul class="custom-jobs">
      {jobs.map((job, index) => (
        <li key={str(job.jobId) ?? index} class="custom-jobs__item">
          <span class="custom-jobs__id">{str(job.jobId)}</span>
          <span class={`custom-jobs__status custom-jobs__status--${str(job.status) ?? "unknown"}`}>
            {str(job.status)}
          </span>
        </li>
      ))}
    </ul>
  );
}
