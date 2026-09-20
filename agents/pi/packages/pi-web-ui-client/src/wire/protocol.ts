import {
  Array as TypeArray,
  Boolean as TypeBoolean,
  Literal as TypeLiteral,
  Null as TypeNull,
  Number as TypeNumber,
  Object as TypeObject,
  Optional as TypeOptional,
  String as TypeString,
  Union as TypeUnion,
  Unknown as TypeUnknown,
  type Static,
  type TProperties,
} from "typebox";
import { Check } from "typebox/value";
import { LIMITS } from "./limits.ts";
import {
  CompletionItemSchema,
  ImageAttachmentCapabilitySchema,
  ImageMimeTypeSchema,
  isModelControlCapabilityValid,
  ModelControlCapabilitySchema,
  PendingInputBrokerCapabilitySchema,
  PendingInputSchema,
  QueueMutationRejectionReasonSchema,
  SessionMetadataSchema,
  SnapshotThemeSchema,
  ThinkingLevelSchema,
  type ImageAttachmentCapability,
  type ModelControlCapability,
} from "./schema.ts";
export type { ImageAttachmentCapability } from "./schema.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  TypeObject(properties, { additionalProperties: false });
const IdSchema = TypeString({ minLength: 1, maxLength: LIMITS.maxIdentityChars });
const CursorSchema = TypeString({ minLength: 1, maxLength: LIMITS.maxCursorChars });

export const PROTOCOL_VERSION = 1 as const;
export const GenerationSchema = TypeString({
  minLength: 1,
  maxLength: LIMITS.maxGenerationChars,
  pattern: "^[A-Za-z0-9._~-]+$",
});
export type Generation = Static<typeof GenerationSchema>;

export const RevisionSchema = TypeNumber({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
});
export type Revision = Static<typeof RevisionSchema>;

/** The payload stays untrusted; the wrapper supplies the durable renderer identity. */
export const PersistedEntrySchema = StrictObject({ id: IdSchema, payload: TypeUnknown() });
export type PersistedEntry = Static<typeof PersistedEntrySchema>;

/** Live rows have identities independent from eventual persisted entry identities. */
export const LiveEntrySchema = StrictObject({ id: IdSchema, payload: TypeUnknown() });
export type LiveEntry = Static<typeof LiveEntrySchema>;

export const SnapshotHistorySchema = StrictObject({
  historyGeneration: GenerationSchema,
  beforeCursor: TypeUnion([CursorSchema, TypeNull()]),
  hasMore: TypeBoolean(),
  oldestEntryId: TypeUnion([IdSchema, TypeNull()]),
});
export type SnapshotHistory = Static<typeof SnapshotHistorySchema>;

export const RunningStateSchema = StrictObject({
  isRunning: TypeBoolean(),
  workingWord: TypeOptional(TypeString({ maxLength: 512 })),
});
export type RunningState = Static<typeof RunningStateSchema>;

export const SessionSnapshotDataSchema = StrictObject({
  commandEpoch: GenerationSchema,
  imageAttachments: TypeOptional(ImageAttachmentCapabilitySchema),
  pendingInputBroker: TypeOptional(PendingInputBrokerCapabilitySchema),
  modelControl: TypeOptional(ModelControlCapabilitySchema),
  header: TypeUnion([TypeObject({}, { additionalProperties: true }), TypeNull()]),
  leafId: TypeUnion([IdSchema, TypeNull()]),
  sessionName: TypeOptional(TypeString({ maxLength: LIMITS.maxMetadataStringChars })),
  systemPrompt: TypeString({ maxLength: LIMITS.maxSystemPromptChars }),
  entries: TypeArray(PersistedEntrySchema, { maxItems: LIMITS.maxSnapshotEntries }),
  liveTail: TypeArray(LiveEntrySchema, { maxItems: LIMITS.maxLiveEntries }),
  history: SnapshotHistorySchema,
  metadata: TypeOptional(SessionMetadataSchema),
  queue: TypeArray(PendingInputSchema, { maxItems: LIMITS.maxPendingInputs }),
  theme: TypeOptional(SnapshotThemeSchema),
  running: RunningStateSchema,
});
export type SessionSnapshotData = Static<typeof SessionSnapshotDataSchema>;

const EnvelopeHeader = {
  version: TypeLiteral(PROTOCOL_VERSION),
  generation: GenerationSchema,
  revision: RevisionSchema,
};

export const SessionSnapshotEnvelopeSchema = StrictObject({
  ...EnvelopeHeader,
  type: TypeLiteral("snapshot"),
  snapshot: SessionSnapshotDataSchema,
});
export type SessionSnapshotEnvelope = Static<typeof SessionSnapshotEnvelopeSchema>;

export const AppendOperationSchema = StrictObject({
  kind: TypeLiteral("append"),
  afterId: TypeUnion([IdSchema, TypeNull()]),
  entries: TypeArray(PersistedEntrySchema, { minItems: 1, maxItems: LIMITS.maxAppendEntries }),
});
export const LiveTailOperationSchema = StrictObject({
  kind: TypeLiteral("live-tail"),
  entries: TypeArray(LiveEntrySchema, { maxItems: LIMITS.maxLiveEntries }),
});
export const MetadataOperationSchema = StrictObject({
  kind: TypeLiteral("metadata"),
  metadata: SessionMetadataSchema,
});
export const QueueOperationSchema = StrictObject({
  kind: TypeLiteral("queue"),
  queue: TypeArray(PendingInputSchema, { maxItems: LIMITS.maxPendingInputs }),
});
export const ThemeOperationSchema = StrictObject({
  kind: TypeLiteral("theme"),
  theme: TypeUnion([SnapshotThemeSchema, TypeNull()]),
});
export const RunningOperationSchema = StrictObject({
  kind: TypeLiteral("running"),
  running: RunningStateSchema,
});
export const SessionOperationSchema = TypeUnion([
  AppendOperationSchema,
  LiveTailOperationSchema,
  MetadataOperationSchema,
  QueueOperationSchema,
  ThemeOperationSchema,
  RunningOperationSchema,
]);
export type SessionOperation = Static<typeof SessionOperationSchema>;

export const OperationBatchEnvelopeSchema = StrictObject({
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("operations"),
  generation: GenerationSchema,
  fromRevision: RevisionSchema,
  revision: RevisionSchema,
  operations: TypeArray(SessionOperationSchema, { minItems: 1, maxItems: LIMITS.maxOperations }),
});
export type OperationBatchEnvelope = Static<typeof OperationBatchEnvelopeSchema>;

export const ResetEnvelopeSchema = StrictObject({
  ...EnvelopeHeader,
  type: TypeLiteral("reset"),
  reason: TypeString({ minLength: 1, maxLength: LIMITS.maxResetReasonChars }),
  snapshot: SessionSnapshotDataSchema,
});
export type ResetEnvelope = Static<typeof ResetEnvelopeSchema>;

export const HistoryRequestSchema = StrictObject({
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("history-request"),
  generation: GenerationSchema,
  revision: RevisionSchema,
  historyGeneration: GenerationSchema,
  beforeCursor: CursorSchema,
  beforeId: IdSchema,
  limit: TypeNumber({ minimum: 1, maximum: LIMITS.maxHistoryPageSize, multipleOf: 1 }),
});
export type HistoryRequest = Static<typeof HistoryRequestSchema>;

export const HistoryPageEnvelopeSchema = StrictObject({
  ...EnvelopeHeader,
  type: TypeLiteral("history-page"),
  historyGeneration: GenerationSchema,
  beforeId: IdSchema,
  entries: TypeArray(PersistedEntrySchema, {
    minItems: 1,
    maxItems: LIMITS.maxHistoryEntries,
  }),
  nextCursor: TypeUnion([CursorSchema, TypeNull()]),
  hasMore: TypeBoolean(),
});
export type HistoryPageEnvelope = Static<typeof HistoryPageEnvelopeSchema>;

const Base64DataSchema = TypeString({
  minLength: 4,
  maxLength: Math.ceil(LIMITS.maxImageBytes / 3) * 4,
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const OutboundImageAttachmentSchema = StrictObject({
  type: TypeLiteral("image-attachment"),
  mimeType: ImageMimeTypeSchema,
  width: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageWidth, multipleOf: 1 }),
  height: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageHeight, multipleOf: 1 }),
  byteLength: TypeNumber({
    minimum: 1,
    maximum: LIMITS.maxImageBytes,
    multipleOf: 1,
  }),
  data: Base64DataSchema,
});
export type OutboundImageAttachment = Static<typeof OutboundImageAttachmentSchema>;

export const SessionCommandSchema = StrictObject({
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("command"),
  commandId: IdSchema,
  generation: GenerationSchema,
  commandEpoch: GenerationSchema,
  content: TypeString({ maxLength: LIMITS.maxInputChars }),
  delivery: TypeUnion([TypeLiteral("immediate"), TypeLiteral("steer"), TypeLiteral("followUp")]),
});
export type SessionCommand = Static<typeof SessionCommandSchema>;

/**
 * Negotiated image command used only when the current snapshot advertises
 * `imageAttachments`. `SessionCommandSchema` remains the compatible text-only
 * contract; transports accept `OutboundCommandSchema` and hosts route image
 * commands through separately bounded authoritative raster admission. Managed
 * hosts must consume this shared schema and inspector rather than widening or
 * reinterpreting the text command.
 */
export const ImageAttachmentCommandSchema = StrictObject({
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("image-command"),
  commandId: IdSchema,
  generation: GenerationSchema,
  commandEpoch: GenerationSchema,
  content: TypeString({ maxLength: LIMITS.maxInputChars }),
  delivery: TypeUnion([TypeLiteral("immediate"), TypeLiteral("steer"), TypeLiteral("followUp")]),
  attachments: TypeArray(OutboundImageAttachmentSchema, {
    minItems: 1,
    maxItems: LIMITS.maxImagesPerEntry,
  }),
});
export type ImageAttachmentCommand = Static<typeof ImageAttachmentCommandSchema>;

const QueueItemVersionSchema = TypeNumber({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
});
const QueueMutationBase = {
  version: TypeLiteral(PROTOCOL_VERSION),
  commandId: IdSchema,
  generation: GenerationSchema,
  commandEpoch: GenerationSchema,
  itemId: IdSchema,
  expectedItemVersion: QueueItemVersionSchema,
};
export const QueueEditCommandSchema = StrictObject({
  ...QueueMutationBase,
  type: TypeLiteral("queue-edit"),
  content: TypeString({ maxLength: LIMITS.maxInputChars }),
});
export const QueueRemoveCommandSchema = StrictObject({
  ...QueueMutationBase,
  type: TypeLiteral("queue-remove"),
});
export const QueueMutationCommandSchema = TypeUnion([
  QueueEditCommandSchema,
  QueueRemoveCommandSchema,
]);
export type QueueMutationCommand = Static<typeof QueueMutationCommandSchema>;

const ModelControlCommandBase = {
  version: TypeLiteral(PROTOCOL_VERSION),
  commandId: IdSchema,
  generation: GenerationSchema,
  commandEpoch: GenerationSchema,
};
export const SetModelCommandSchema = StrictObject({
  ...ModelControlCommandBase,
  type: TypeLiteral("set-model"),
  provider: TypeString({ minLength: 1, maxLength: LIMITS.maxModelProviderChars }),
  modelId: TypeString({ minLength: 1, maxLength: LIMITS.maxModelIdChars }),
});
export type SetModelCommand = Static<typeof SetModelCommandSchema>;

export const SetThinkingCommandSchema = StrictObject({
  ...ModelControlCommandBase,
  type: TypeLiteral("set-thinking"),
  thinkingLevel: ThinkingLevelSchema,
});
export type SetThinkingCommand = Static<typeof SetThinkingCommandSchema>;

export const ModelControlCommandSchema = TypeUnion([
  SetModelCommandSchema,
  SetThinkingCommandSchema,
]);
export type ModelControlCommand = Static<typeof ModelControlCommandSchema>;

export function isModelControlCommandPreflightValid(
  value: unknown,
  capability?: ModelControlCapability,
): value is ModelControlCommand {
  if (!Check(ModelControlCommandSchema, value) || !isModelControlCapabilityValid(capability))
    return false;
  return value.type === "set-model"
    ? capability.models.some(
        (model) => model.provider === value.provider && model.id === value.modelId,
      )
    : capability.thinkingLevels.includes(value.thinkingLevel);
}

export const OutboundCommandSchema = TypeUnion([
  SessionCommandSchema,
  ImageAttachmentCommandSchema,
]);
export type OutboundCommand = Static<typeof OutboundCommandSchema>;

/**
 * Structural, advertised-capability, and canonical-base64 preflight only.
 * A host must still decode under byte limits; perform bounded PNG/JPEG/WebP signature,
 * container, animation, and actual-dimension validation; compare actual dimensions with
 * declarations; and enforce per-image and aggregate actual pixels before acceptance.
 */
export function isImageAttachmentCommandPreflightValid(
  value: unknown,
  capability?: ImageAttachmentCapability,
): value is ImageAttachmentCommand {
  if (!Check(ImageAttachmentCommandSchema, value)) return false;
  if (!capability || !Check(ImageAttachmentCapabilitySchema, capability)) return false;
  if (value.attachments.length > capability.maxAttachments) return false;

  let totalBytes = 0;
  let totalDeclaredPixels = 0;
  for (const attachment of value.attachments) {
    if (!capability.supportedMimeTypes.includes(attachment.mimeType)) return false;
    if (attachment.byteLength > capability.maxBytesPerImage) return false;
    if (attachment.width > capability.maxWidth || attachment.height > capability.maxHeight)
      return false;
    const declaredPixels = attachment.width * attachment.height;
    if (declaredPixels > capability.maxPixels) return false;

    const padding = attachment.data.endsWith("==") ? 2 : attachment.data.endsWith("=") ? 1 : 0;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (
      (padding === 2 && (alphabet.indexOf(attachment.data.at(-3) ?? "") & 15) !== 0) ||
      (padding === 1 && (alphabet.indexOf(attachment.data.at(-2) ?? "") & 3) !== 0)
    )
      return false;
    const decodedBytes = (attachment.data.length / 4) * 3 - padding;
    if (decodedBytes !== attachment.byteLength) return false;
    totalBytes += attachment.byteLength;
    totalDeclaredPixels += declaredPixels;
    if (totalBytes > capability.maxTotalBytes || totalDeclaredPixels > capability.maxTotalPixels)
      return false;
  }
  return true;
}

const CommandResponseBase = {
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("command-response"),
  commandId: IdSchema,
  generation: GenerationSchema,
  commandEpoch: GenerationSchema,
};
export const CommandResponseEnvelopeSchema = TypeUnion([
  StrictObject({ ...CommandResponseBase, accepted: TypeLiteral(true) }),
  StrictObject({
    ...CommandResponseBase,
    accepted: TypeLiteral(false),
    error: TypeString({ minLength: 1, maxLength: LIMITS.maxErrorChars }),
    reason: TypeOptional(QueueMutationRejectionReasonSchema),
  }),
]);
export type CommandResponseEnvelope = Static<typeof CommandResponseEnvelopeSchema>;

export const ModelControlRejectionReasonSchema = TypeUnion([
  TypeLiteral("capability-off"),
  TypeLiteral("invalid"),
  TypeLiteral("queue-busy"),
  TypeLiteral("session-changed"),
]);
export type ModelControlRejectionReason = Static<typeof ModelControlRejectionReasonSchema>;

export const ModelControlResponseEnvelopeSchema = TypeUnion([
  StrictObject({ ...CommandResponseBase, accepted: TypeLiteral(true) }),
  StrictObject({
    ...CommandResponseBase,
    accepted: TypeLiteral(false),
    error: TypeString({ minLength: 1, maxLength: LIMITS.maxErrorChars }),
    reason: ModelControlRejectionReasonSchema,
  }),
]);
export type ModelControlResponseEnvelope = Static<typeof ModelControlResponseEnvelopeSchema>;
export const isModelControlResponseEnvelope = (
  value: unknown,
): value is ModelControlResponseEnvelope => Check(ModelControlResponseEnvelopeSchema, value);

/** Eventual completion is a separate envelope; command acceptance is admission-only. */
export const CommandCompletionEnvelopeSchema = TypeUnion([
  StrictObject({
    version: TypeLiteral(PROTOCOL_VERSION),
    type: TypeLiteral("command-completion"),
    commandId: IdSchema,
    generation: GenerationSchema,
    commandEpoch: GenerationSchema,
    revision: RevisionSchema,
    status: TypeLiteral("completed"),
  }),
  StrictObject({
    version: TypeLiteral(PROTOCOL_VERSION),
    type: TypeLiteral("command-completion"),
    commandId: IdSchema,
    generation: GenerationSchema,
    commandEpoch: GenerationSchema,
    revision: RevisionSchema,
    status: TypeLiteral("failed"),
    error: TypeString({ minLength: 1, maxLength: LIMITS.maxErrorChars }),
  }),
]);
export type CommandCompletionEnvelope = Static<typeof CommandCompletionEnvelopeSchema>;

export const CompletionQuerySchema = StrictObject({
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("completion-request"),
  generation: GenerationSchema,
  query: TypeString({ maxLength: LIMITS.maxCompletionQueryChars }),
});
export type CompletionQuery = Static<typeof CompletionQuerySchema>;

export const CompletionResultEnvelopeSchema = StrictObject({
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("completion-response"),
  generation: GenerationSchema,
  items: TypeArray(CompletionItemSchema, { maxItems: LIMITS.maxCompletionItems }),
});
export type CompletionResultEnvelope = Static<typeof CompletionResultEnvelopeSchema>;

export const ErrorEnvelopeSchema = StrictObject({
  version: TypeLiteral(PROTOCOL_VERSION),
  type: TypeLiteral("error"),
  generation: TypeOptional(GenerationSchema),
  commandId: TypeOptional(IdSchema),
  code: TypeString({ minLength: 1, maxLength: 128, pattern: "^[A-Z0-9_]+$" }),
  message: TypeString({ minLength: 1, maxLength: LIMITS.maxErrorChars }),
  recoverable: TypeBoolean(),
});
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const ServerEnvelopeSchema = TypeUnion([
  SessionSnapshotEnvelopeSchema,
  OperationBatchEnvelopeSchema,
  ResetEnvelopeSchema,
  HistoryPageEnvelopeSchema,
  CommandResponseEnvelopeSchema,
  CommandCompletionEnvelopeSchema,
  CompletionResultEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type ServerEnvelope = Static<typeof ServerEnvelopeSchema>;

export const isServerEnvelope = (value: unknown): value is ServerEnvelope =>
  Check(ServerEnvelopeSchema, value);
export const isSessionSnapshotEnvelope = (value: unknown): value is SessionSnapshotEnvelope =>
  Check(SessionSnapshotEnvelopeSchema, value);
export const isOperationBatchEnvelope = (value: unknown): value is OperationBatchEnvelope =>
  Check(OperationBatchEnvelopeSchema, value);
export const isResetEnvelope = (value: unknown): value is ResetEnvelope =>
  Check(ResetEnvelopeSchema, value);
export const isHistoryPageEnvelope = (value: unknown): value is HistoryPageEnvelope =>
  Check(HistoryPageEnvelopeSchema, value);
