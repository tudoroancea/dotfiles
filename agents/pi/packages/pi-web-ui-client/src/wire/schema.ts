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
  type TRecord,
} from "typebox";
import { Check } from "typebox/value";
import { LIMITS } from "./limits.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  TypeObject(properties, { additionalProperties: false });

const ThemePaletteValueSchema = TypeString({ maxLength: LIMITS.maxThemeValueChars });
export const ThemePaletteSchema = {
  "~kind": "Record",
  type: "object",
  patternProperties: { "^[\\s\\S]*$": ThemePaletteValueSchema },
  additionalProperties: false,
  maxProperties: LIMITS.maxThemeProperties,
  propertyNames: TypeString({ maxLength: LIMITS.maxThemeKeyChars }),
} as const as unknown as TRecord<"^.*$", typeof ThemePaletteValueSchema> & {
  readonly maxProperties: number;
  readonly propertyNames: ReturnType<typeof TypeString>;
};
export type ThemePalette = Static<typeof ThemePaletteSchema>;

export const SnapshotThemeSchema = StrictObject({
  auto: TypeBoolean(),
  light: ThemePaletteSchema,
  dark: ThemePaletteSchema,
});
export type SnapshotTheme = Static<typeof SnapshotThemeSchema>;

export const ImageMimeTypeSchema = TypeUnion([
  TypeLiteral("image/png"),
  TypeLiteral("image/jpeg"),
  TypeLiteral("image/webp"),
]);
export type ImageMimeType = Static<typeof ImageMimeTypeSchema>;

export const ImageAttachmentCapabilitySchema = StrictObject({
  supportedMimeTypes: TypeArray(ImageMimeTypeSchema, {
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  }),
  maxAttachments: TypeNumber({ minimum: 1, maximum: LIMITS.maxImagesPerEntry, multipleOf: 1 }),
  maxBytesPerImage: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageBytes, multipleOf: 1 }),
  maxTotalBytes: TypeNumber({
    minimum: 1,
    maximum: LIMITS.maxImageSourceBytesPerEntry,
    multipleOf: 1,
  }),
  maxWidth: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageWidth, multipleOf: 1 }),
  maxHeight: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageHeight, multipleOf: 1 }),
  maxPixels: TypeNumber({ minimum: 1, maximum: LIMITS.maxImagePixels, multipleOf: 1 }),
  maxTotalPixels: TypeNumber({ minimum: 1, maximum: LIMITS.maxImagePixels, multipleOf: 1 }),
});
export type ImageAttachmentCapability = Static<typeof ImageAttachmentCapabilitySchema>;

export const ImageOmissionReasonSchema = TypeUnion([
  TypeLiteral("invalid-data"),
  TypeLiteral("unsupported-format"),
  TypeLiteral("signature-mismatch"),
  TypeLiteral("animated-image"),
  TypeLiteral("image-too-large"),
  TypeLiteral("dimensions-exceeded"),
  TypeLiteral("pixels-exceeded"),
  TypeLiteral("count-exceeded"),
  TypeLiteral("aggregate-bytes-exceeded"),
]);
export type ImageOmissionReason = Static<typeof ImageOmissionReasonSchema>;

export const ImageReferenceSchema = StrictObject({
  type: TypeLiteral("image-reference"),
  id: TypeString({
    minLength: 32,
    maxLength: LIMITS.maxImageIdChars,
    pattern: "^[A-Za-z0-9_-]+$",
  }),
  mimeType: ImageMimeTypeSchema,
  width: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageWidth, multipleOf: 1 }),
  height: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageHeight, multipleOf: 1 }),
  byteLength: TypeNumber({ minimum: 1, maximum: LIMITS.maxImageBytes, multipleOf: 1 }),
});
export type ImageReference = Static<typeof ImageReferenceSchema>;

export const ImageOmissionSchema = StrictObject({
  type: TypeLiteral("image-omission"),
  reason: ImageOmissionReasonSchema,
});
export type ImageOmission = Static<typeof ImageOmissionSchema>;
export const RemoteImageBlockSchema = TypeUnion([ImageReferenceSchema, ImageOmissionSchema]);
export type RemoteImageBlock = Static<typeof RemoteImageBlockSchema>;

export function isImageReference(value: unknown): value is ImageReference {
  return Check(ImageReferenceSchema, value) && value.width * value.height <= LIMITS.maxImagePixels;
}

export function isImageOmission(value: unknown): value is ImageOmission {
  return Check(ImageOmissionSchema, value);
}

export const ContextUsageSchema = StrictObject({
  tokens: TypeUnion([TypeNumber(), TypeNull()]),
  contextWindow: TypeNumber(),
  percent: TypeUnion([TypeNumber(), TypeNull()]),
});
export type ContextUsage = Static<typeof ContextUsageSchema>;

export const ThinkingLevelSchema = TypeUnion([
  TypeLiteral("off"),
  TypeLiteral("minimal"),
  TypeLiteral("low"),
  TypeLiteral("medium"),
  TypeLiteral("high"),
  TypeLiteral("xhigh"),
  TypeLiteral("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const SessionModelSchema = StrictObject({
  provider: TypeString({ maxLength: LIMITS.maxModelProviderChars }),
  id: TypeString({ maxLength: LIMITS.maxModelIdChars }),
  name: TypeString({ maxLength: LIMITS.maxModelNameChars }),
});
export type SessionModel = Static<typeof SessionModelSchema>;

export const ModelChoiceSchema = StrictObject({
  provider: TypeString({ minLength: 1, maxLength: LIMITS.maxModelProviderChars }),
  id: TypeString({ minLength: 1, maxLength: LIMITS.maxModelIdChars }),
  name: TypeString({ minLength: 1, maxLength: LIMITS.maxModelNameChars }),
});
export type ModelChoice = Static<typeof ModelChoiceSchema>;

export const ModelControlCapabilitySchema = StrictObject({
  models: TypeArray(ModelChoiceSchema, {
    minItems: 1,
    maxItems: LIMITS.maxModelChoices,
    uniqueItems: true,
  }),
  thinkingLevels: TypeArray(ThinkingLevelSchema, {
    minItems: 1,
    maxItems: 7,
    uniqueItems: true,
  }),
});
export type ModelControlCapability = Static<typeof ModelControlCapabilitySchema>;

/** Structural validity plus the model identity invariant used by consumers. */
export function isModelControlCapabilityValid(value: unknown): value is ModelControlCapability {
  if (!Check(ModelControlCapabilitySchema, value)) return false;
  const identities = new Set<string>();
  for (const model of value.models) {
    const identity = JSON.stringify([model.provider, model.id]);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

export const SessionMetadataSchema = StrictObject({
  cwd: TypeString({ maxLength: LIMITS.maxMetadataStringChars }),
  home: TypeString({ maxLength: LIMITS.maxMetadataStringChars }),
  contextUsage: TypeOptional(ContextUsageSchema),
  sessionCost: TypeNumber(),
  model: TypeOptional(SessionModelSchema),
  thinkingLevel: TypeOptional(ThinkingLevelSchema),
});
export type SessionMetadata = Static<typeof SessionMetadataSchema>;

export const InputDeliverySchema = TypeUnion([
  TypeLiteral("immediate"),
  TypeLiteral("steer"),
  TypeLiteral("followUp"),
]);
export type InputDelivery = Static<typeof InputDeliverySchema>;

export const PendingInputBrokerCapabilitySchema = StrictObject({
  edit: TypeBoolean(),
  remove: TypeBoolean(),
});
export type PendingInputBrokerCapability = Static<typeof PendingInputBrokerCapabilitySchema>;

export const QueueMutationRejectionReasonSchema = TypeUnion([
  TypeLiteral("stale-item"),
  TypeLiteral("not-found"),
  TypeLiteral("released"),
  TypeLiteral("ambiguous"),
  TypeLiteral("queue-busy"),
  TypeLiteral("capability-off"),
  TypeLiteral("invalid"),
  TypeLiteral("session-changed"),
]);
export type QueueMutationRejectionReason = Static<typeof QueueMutationRejectionReasonSchema>;

export const PendingInputSchema = StrictObject({
  id: TypeString({ maxLength: 256 }),
  content: TypeString({ maxLength: LIMITS.maxInputChars }),
  delivery: TypeUnion([TypeLiteral("steer"), TypeLiteral("followUp")]),
  attachmentCount: TypeOptional(
    TypeNumber({ minimum: 0, maximum: LIMITS.maxImagesPerEntry, multipleOf: 1 }),
  ),
  itemVersion: TypeOptional(
    TypeNumber({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }),
  ),
  editable: TypeOptional(TypeBoolean()),
  state: TypeOptional(TypeUnion([TypeLiteral("held"), TypeLiteral("releasing")])),
});
export type PendingInput = Static<typeof PendingInputSchema>;

const SnapshotHeaderSchema = TypeUnion([
  TypeObject({}, { additionalProperties: true }),
  TypeNull(),
]);

export const SnapshotSchema = StrictObject({
  header: SnapshotHeaderSchema,
  imageAttachments: TypeOptional(ImageAttachmentCapabilitySchema),
  pendingInputBroker: TypeOptional(PendingInputBrokerCapabilitySchema),
  modelControl: TypeOptional(ModelControlCapabilitySchema),
  leafId: TypeUnion([TypeString({ maxLength: 512 }), TypeNull()]),
  sessionName: TypeOptional(TypeString({ maxLength: LIMITS.maxMetadataStringChars })),
  isRunning: TypeBoolean(),
  workingWord: TypeOptional(TypeString({ maxLength: 512 })),
  theme: TypeOptional(SnapshotThemeSchema),
  systemPrompt: TypeString({ maxLength: LIMITS.maxSystemPromptChars }),
  metadata: TypeOptional(SessionMetadataSchema),
  pendingInputs: TypeArray(PendingInputSchema, { maxItems: LIMITS.maxPendingInputs }),
  entries: TypeArray(TypeUnknown(), { maxItems: LIMITS.maxEntries }),
});
export type Snapshot = Static<typeof SnapshotSchema>;

export const CompletionRequestSchema = StrictObject({
  query: TypeString({ maxLength: LIMITS.maxCompletionQueryChars }),
});
export type CompletionRequest = Static<typeof CompletionRequestSchema>;

export const CompletionItemSchema = StrictObject({
  value: TypeString({ maxLength: LIMITS.maxCompletionValueChars }),
  label: TypeString({ maxLength: LIMITS.maxCompletionLabelChars }),
  description: TypeOptional(TypeString({ maxLength: LIMITS.maxCompletionDescriptionChars })),
});
export type CompletionItem = Static<typeof CompletionItemSchema>;

export const CompletionResponseSchema = StrictObject({
  items: TypeArray(CompletionItemSchema, { maxItems: LIMITS.maxCompletionItems }),
});
export type CompletionResponse = Static<typeof CompletionResponseSchema>;

export const SubmittedCommandSchema = StrictObject({
  content: TypeString({ maxLength: LIMITS.maxInputChars }),
  delivery: InputDeliverySchema,
});
export type SubmittedCommand = Static<typeof SubmittedCommandSchema>;

export const CommandAcceptanceSchema = StrictObject({
  accepted: TypeBoolean(),
  error: TypeOptional(TypeString({ maxLength: 512 })),
  reason: TypeOptional(QueueMutationRejectionReasonSchema),
});
export type CommandAcceptance = Static<typeof CommandAcceptanceSchema>;

const UntrustedCompletionResponseSchema = StrictObject({ items: TypeUnknown() });
const UnboundedCompletionItemSchema = StrictObject({
  value: TypeString(),
  label: TypeString(),
  description: TypeOptional(TypeString()),
});

export function isSnapshot(value: unknown): value is Snapshot {
  return (
    Check(SnapshotSchema, value) &&
    (value.modelControl === undefined || isModelControlCapabilityValid(value.modelControl))
  );
}

export function isCompletionRequest(value: unknown): value is CompletionRequest {
  return Check(CompletionRequestSchema, value);
}

export function isCompletionResponse(value: unknown): value is CompletionResponse {
  return Check(CompletionResponseSchema, value);
}

export function isSubmittedCommand(value: unknown): value is SubmittedCommand {
  return Check(SubmittedCommandSchema, value);
}

export function isCommandAcceptance(value: unknown): value is CommandAcceptance {
  return Check(CommandAcceptanceSchema, value);
}

/** Decode the authoritative strict, bounded snapshot envelope. */
export function decodeSnapshot(value: unknown): Snapshot | null {
  return isSnapshot(value) ? value : null;
}

/**
 * Decode completion suggestions best-effort: malformed items are discarded and
 * accepted strings are truncated before the collection is capped.
 */
export function decodeCompletionResponse(value: unknown): CompletionResponse | null {
  if (!Check(UntrustedCompletionResponseSchema, value) || !Array.isArray(value.items)) return null;
  const items: CompletionItem[] = [];
  const candidateCount = Math.min(value.items.length, LIMITS.maxCompletionCandidates);
  for (let index = 0; index < candidateCount; index += 1) {
    const item = value.items[index];
    if (!Check(UnboundedCompletionItemSchema, item)) continue;
    const normalized = {
      value: item.value.slice(0, LIMITS.maxCompletionValueChars),
      label: item.label.slice(0, LIMITS.maxCompletionLabelChars),
      ...(typeof item.description === "string"
        ? { description: item.description.slice(0, LIMITS.maxCompletionDescriptionChars) }
        : {}),
    };
    if (Check(CompletionItemSchema, normalized)) items.push(normalized);
    if (items.length === LIMITS.maxCompletionItems) break;
  }
  const response = { items };
  return isCompletionResponse(response) ? response : null;
}

export function decodeCommandAcceptance(value: unknown): CommandAcceptance | null {
  return isCommandAcceptance(value) ? value : null;
}
