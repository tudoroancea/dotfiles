import { Type, type Static } from "typebox";
import { LIMITS } from "./limits.js";

export const PROTOCOL_VERSION = 6 as const;

const RevisionSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const GenerationSchema = Type.String({ minLength: 1, maxLength: 128 });
const CommandIdSchema = Type.String({ minLength: 1, maxLength: LIMITS.commandIdUtf8Bytes });
const PromptSchema = Type.String({ minLength: 1, maxLength: LIMITS.promptUtf8Bytes });
const JsonSchema = Type.Unknown();

export const ProjectedMessageSchema = Type.Object(
  {
    role: Type.String(),
    content: Type.Array(JsonSchema),
    timestamp: Type.Optional(Type.Number()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    stopReason: Type.Optional(Type.String()),
    errorMessage: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    isError: Type.Optional(Type.Boolean()),
    details: Type.Optional(JsonSchema),
    usage: Type.Optional(JsonSchema),
    customType: Type.Optional(Type.String()),
    display: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PersistedEntrySchema = Type.Object(
  {
    id: Type.String(),
    parentId: Type.Union([Type.String(), Type.Null()]),
    timestamp: Type.String(),
    entryType: Type.String(),
    payload: JsonSchema,
  },
  { additionalProperties: false },
);

export const PersistedStateSchema = Type.Object(
  {
    sessionId: Type.String(),
    leafId: Type.Union([Type.String(), Type.Null()]),
    entries: Type.Array(PersistedEntrySchema),
    entriesTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ToolExecutionSchema = Type.Object(
  {
    toolCallId: Type.String(),
    toolName: Type.String(),
    ordinal: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("error")]),
    args: JsonSchema,
    result: Type.Optional(JsonSchema),
    isError: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const LiveStateSchema = Type.Object(
  {
    isRunning: Type.Boolean(),
    partialAssistant: Type.Optional(ProjectedMessageSchema),
    finalizedMessages: Type.Array(ProjectedMessageSchema),
    tools: Type.Array(ToolExecutionSchema),
  },
  { additionalProperties: false },
);

export const SessionMetadataSchema = Type.Object(
  {
    cwd: Type.String(),
    isIdle: Type.Boolean(),
    model: Type.Optional(
      Type.Object(
        {
          provider: Type.String(),
          id: Type.String(),
          name: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    thinkingLevel: Type.Optional(Type.String()),
    contextUsage: Type.Optional(
      Type.Object(
        {
          tokens: Type.Union([Type.Number(), Type.Null()]),
          contextWindow: Type.Number(),
          percent: Type.Union([Type.Number(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    activeTools: Type.Array(Type.String()),
    sessionCost: Type.Optional(Type.Number({ minimum: 0 })),
    piVersion: Type.Optional(Type.String()),
    home: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SessionStateSchema = Type.Object(
  {
    persisted: PersistedStateSchema,
    live: LiveStateSchema,
    metadata: SessionMetadataSchema,
  },
  { additionalProperties: false },
);

export const StatePatchSchema = Type.Object(
  {
    persisted: Type.Optional(PersistedStateSchema),
    live: Type.Optional(LiveStateSchema),
    metadata: Type.Optional(SessionMetadataSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);

const ProtocolVersionSchema = Type.Literal(PROTOCOL_VERSION);

const MutatingCommandBase = {
  commandId: CommandIdSchema,
  generation: GenerationSchema,
};

export const ClientCommandSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("prompt"), ...MutatingCommandBase, content: PromptSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("steer"), ...MutatingCommandBase, content: PromptSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("follow_up"), ...MutatingCommandBase, content: PromptSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("abort"), ...MutatingCommandBase },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("snapshot"),
      commandId: CommandIdSchema,
      generation: Type.Optional(GenerationSchema),
      revision: Type.Optional(RevisionSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("ping"), commandId: CommandIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("provider_snapshot"),
      commandId: CommandIdSchema,
      generation: GenerationSchema,
      provider: Type.Union([Type.Literal("agentflow"), Type.Literal("background")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("provider_action"),
      commandId: CommandIdSchema,
      generation: GenerationSchema,
      provider: Type.Union([Type.Literal("agentflow"), Type.Literal("background")]),
      action: Type.String({ minLength: 1, maxLength: 64 }),
      payload: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("complete"),
      commandId: CommandIdSchema,
      generation: GenerationSchema,
      completionKind: Type.Union([Type.Literal("slash"), Type.Literal("mention")]),
      query: Type.String({ maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
]);

export const ReadyMessageSchema = Type.Object(
  {
    type: Type.Literal("ready"),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    revision: RevisionSchema,
  },
  { additionalProperties: false },
);

export const SnapshotMessageSchema = Type.Object(
  {
    type: Type.Literal("snapshot"),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    revision: RevisionSchema,
    commandId: Type.Optional(CommandIdSchema),
    state: SessionStateSchema,
  },
  { additionalProperties: false },
);

export const StateUpdateMessageSchema = Type.Object(
  {
    type: Type.Literal("state_update"),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    baseRevision: RevisionSchema,
    revision: RevisionSchema,
    patch: StatePatchSchema,
  },
  { additionalProperties: false },
);

export const CommandResponseMessageSchema = Type.Object(
  {
    type: Type.Literal("command_response"),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    commandId: Type.Optional(CommandIdSchema),
    command: Type.Optional(Type.String()),
    accepted: Type.Boolean(),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PongMessageSchema = Type.Object(
  {
    type: Type.Literal("pong"),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    commandId: CommandIdSchema,
  },
  { additionalProperties: false },
);

export const CompletionItemSchema = Type.Object(
  {
    value: Type.String({ maxLength: 1024 }),
    label: Type.String({ maxLength: 512 }),
    description: Type.Optional(Type.String({ maxLength: 1024 })),
    source: Type.Optional(Type.String({ maxLength: 32 })),
  },
  { additionalProperties: false },
);

export const CompletionResultMessageSchema = Type.Object(
  {
    type: Type.Literal("completion_result"),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    commandId: CommandIdSchema,
    completionKind: Type.Union([Type.Literal("slash"), Type.Literal("mention")]),
    query: Type.String({ maxLength: 512 }),
    items: Type.Array(CompletionItemSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);

export const ProviderMessageSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("provider_snapshot"),
      Type.Literal("provider_update"),
      Type.Literal("provider_action_result"),
    ]),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    provider: Type.Union([Type.Literal("agentflow"), Type.Literal("background")]),
    revision: Type.Integer({ minimum: 0 }),
    commandId: Type.Optional(CommandIdSchema),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ResyncRequiredMessageSchema = Type.Object(
  {
    type: Type.Literal("resync_required"),
    protocolVersion: ProtocolVersionSchema,
    generation: GenerationSchema,
    revision: RevisionSchema,
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const ServerMessageSchema = Type.Union([
  ReadyMessageSchema,
  SnapshotMessageSchema,
  StateUpdateMessageSchema,
  CommandResponseMessageSchema,
  PongMessageSchema,
  CompletionResultMessageSchema,
  ProviderMessageSchema,
  ResyncRequiredMessageSchema,
]);

export type ProjectedMessage = Static<typeof ProjectedMessageSchema>;
export type PersistedEntry = Static<typeof PersistedEntrySchema>;
export type PersistedState = Static<typeof PersistedStateSchema>;
export type ToolExecution = Static<typeof ToolExecutionSchema>;
export type LiveState = Static<typeof LiveStateSchema>;
export type SessionMetadata = Static<typeof SessionMetadataSchema>;
export type SessionState = Static<typeof SessionStateSchema>;
export type StatePatch = Static<typeof StatePatchSchema>;
export type ClientCommand = Static<typeof ClientCommandSchema>;
export type ReadyMessage = Static<typeof ReadyMessageSchema>;
export type SnapshotMessage = Static<typeof SnapshotMessageSchema>;
export type StateUpdateMessage = Static<typeof StateUpdateMessageSchema>;
export type CommandResponseMessage = Static<typeof CommandResponseMessageSchema>;
export type PongMessage = Static<typeof PongMessageSchema>;
export type CompletionItem = Static<typeof CompletionItemSchema>;
export type CompletionResultMessage = Static<typeof CompletionResultMessageSchema>;
export type ProviderMessage = Static<typeof ProviderMessageSchema>;
export type ResyncRequiredMessage = Static<typeof ResyncRequiredMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
