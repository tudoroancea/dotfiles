import {
  Array as TypeArray,
  Boolean as TypeBoolean,
  Literal as TypeLiteral,
  Number as TypeNumber,
  Object as TypeObject,
  Optional as TypeOptional,
  String as TypeString,
  Union as TypeUnion,
  type Static,
  type TProperties,
} from "typebox";
import { Check } from "typebox/value";

/**
 * Browser-only normalization limits for opaque questionnaire transcript payloads.
 * These are renderer-view limits, not obligations on transcript producers or wire envelopes.
 */
export const QUESTIONNAIRE_LIMITS = {
  maxQuestions: 32,
  maxOptionsPerQuestion: 32,
  maxAnswers: 32,
  maxQuestionCandidates: 128,
  maxOptionCandidates: 128,
  maxAnswerCandidates: 128,
  maxContentCandidates: 16,
  maxIdChars: 256,
  maxLabelChars: 256,
  maxPromptChars: 1_024,
  maxDescriptionChars: 512,
  maxValueChars: 1_024,
  maxErrorChars: 1_024,
  maxOmittedCount: 1_000_000,
} as const;

const StrictObject = <T extends TProperties>(properties: T) =>
  TypeObject(properties, { additionalProperties: false });
const CountSchema = TypeNumber({
  minimum: 0,
  maximum: QUESTIONNAIRE_LIMITS.maxOmittedCount,
  multipleOf: 1,
});

export const QuestionnaireAnswerViewSchema = StrictObject({
  id: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxIdChars }),
  label: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxValueChars }),
  value: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxValueChars }),
  wasCustom: TypeBoolean(),
  index: TypeOptional(
    TypeNumber({ minimum: 0, maximum: QUESTIONNAIRE_LIMITS.maxOptionCandidates, multipleOf: 1 }),
  ),
  truncated: TypeBoolean(),
});
export type QuestionnaireAnswerView = Static<typeof QuestionnaireAnswerViewSchema>;

export const QuestionnaireOptionViewSchema = StrictObject({
  value: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxValueChars }),
  label: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxLabelChars }),
  description: TypeOptional(TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxDescriptionChars })),
  selected: TypeBoolean(),
  truncated: TypeBoolean(),
});
export type QuestionnaireOptionView = Static<typeof QuestionnaireOptionViewSchema>;

export const QuestionnaireQuestionViewSchema = StrictObject({
  id: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxIdChars }),
  label: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxLabelChars }),
  prompt: TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxPromptChars }),
  options: TypeArray(QuestionnaireOptionViewSchema, {
    maxItems: QUESTIONNAIRE_LIMITS.maxOptionsPerQuestion,
  }),
  answer: TypeOptional(QuestionnaireAnswerViewSchema),
  omittedOptions: CountSchema,
  truncated: TypeBoolean(),
});
export type QuestionnaireQuestionView = Static<typeof QuestionnaireQuestionViewSchema>;

export const QuestionnaireStatusSchema = TypeUnion([
  TypeLiteral("running"),
  TypeLiteral("completed"),
  TypeLiteral("cancelled"),
  TypeLiteral("failed"),
]);
export type QuestionnaireStatus = Static<typeof QuestionnaireStatusSchema>;

/** Strict, bounded renderer-view data transfer object derived from TypeBox. */
export const QuestionnaireRendererViewSchema = StrictObject({
  status: QuestionnaireStatusSchema,
  questions: TypeArray(QuestionnaireQuestionViewSchema, {
    maxItems: QUESTIONNAIRE_LIMITS.maxQuestions,
  }),
  orphanAnswers: TypeArray(QuestionnaireAnswerViewSchema, {
    maxItems: QUESTIONNAIRE_LIMITS.maxAnswers,
  }),
  omittedQuestions: CountSchema,
  omittedAnswers: CountSchema,
  truncated: TypeBoolean(),
  unusable: TypeBoolean(),
  error: TypeOptional(TypeString({ maxLength: QUESTIONNAIRE_LIMITS.maxErrorChars })),
});
export type QuestionnaireRendererView = Static<typeof QuestionnaireRendererViewSchema>;

const EMPTY_VIEW: QuestionnaireRendererView = {
  status: "running",
  questions: [],
  orphanAnswers: [],
  omittedQuestions: 0,
  omittedAnswers: 0,
  truncated: false,
  unusable: true,
};

type RawRecord = Record<string, unknown>;

function record(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function boundedLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return Math.min(value.length, QUESTIONNAIRE_LIMITS.maxOmittedCount);
}

function text(value: unknown, maximum: number, fallback = ""): [string, boolean] {
  if (typeof value !== "string") return [fallback, false];
  return [value.slice(0, maximum), value.length > maximum];
}

function resultText(result: RawRecord | null): { value: string; truncated: boolean } {
  if (!result || !Array.isArray(result.content)) return { value: "", truncated: false };
  let value = "";
  let truncated = result.content.length > QUESTIONNAIRE_LIMITS.maxContentCandidates;
  const count = Math.min(result.content.length, QUESTIONNAIRE_LIMITS.maxContentCandidates);
  for (let index = 0; index < count; index += 1) {
    const item = record(result.content[index]);
    if (!item || item.type !== "text" || typeof item.text !== "string") continue;
    const separator = value ? "\n" : "";
    const remaining = QUESTIONNAIRE_LIMITS.maxErrorChars - value.length - separator.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    value += separator + item.text.slice(0, remaining);
    truncated ||= item.text.length > remaining;
  }
  return { value, truncated };
}

interface DecodedAnswer {
  view: QuestionnaireAnswerView;
  rawId: string;
  rawLabel: string | null;
  rawValue: string | null;
  rawIndex?: number;
}

function decodeAnswers(raw: unknown): {
  answers: DecodedAnswer[];
  omitted: number;
  truncated: boolean;
} {
  if (!Array.isArray(raw)) return { answers: [], omitted: 0, truncated: false };
  const answers: DecodedAnswer[] = [];
  const scan = Math.min(raw.length, QUESTIONNAIRE_LIMITS.maxAnswerCandidates);
  let stringTruncated = false;
  for (
    let index = 0;
    index < scan && answers.length < QUESTIONNAIRE_LIMITS.maxAnswers;
    index += 1
  ) {
    const candidate = record(raw[index]);
    if (!candidate || typeof candidate.id !== "string") continue;
    const [id, idCut] = text(candidate.id, QUESTIONNAIRE_LIMITS.maxIdChars);
    const [value, valueCut] = text(candidate.value, QUESTIONNAIRE_LIMITS.maxValueChars);
    const [label, labelCut] = text(
      candidate.label,
      QUESTIONNAIRE_LIMITS.maxValueChars,
      value || "[answer unavailable]",
    );
    const rawIndex = candidate.index;
    const validRawIndex =
      typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) && rawIndex >= 1
        ? rawIndex
        : undefined;
    const answer: QuestionnaireAnswerView = {
      id,
      label,
      value: value || label,
      wasCustom: candidate.wasCustom === true,
      ...(validRawIndex !== undefined && validRawIndex <= QUESTIONNAIRE_LIMITS.maxOptionCandidates
        ? { index: validRawIndex }
        : {}),
      truncated: idCut || labelCut || valueCut,
    };
    stringTruncated ||= answer.truncated;
    answers.push({
      view: answer,
      rawId: candidate.id,
      rawLabel: typeof candidate.label === "string" ? candidate.label : null,
      rawValue: typeof candidate.value === "string" ? candidate.value : null,
      ...(validRawIndex === undefined ? {} : { rawIndex: validRawIndex }),
    });
  }
  const omitted = Math.max(0, boundedLength(raw) - answers.length);
  return { answers, omitted, truncated: stringTruncated };
}

function decodeQuestions(
  raw: unknown,
  answers: DecodedAnswer[],
): {
  questions: QuestionnaireQuestionView[];
  joinedAnswers: Set<DecodedAnswer>;
  omitted: number;
  truncated: boolean;
} {
  if (!Array.isArray(raw))
    return { questions: [], joinedAnswers: new Set(), omitted: 0, truncated: false };
  const questions: QuestionnaireQuestionView[] = [];
  const joinedAnswers = new Set<DecodedAnswer>();
  const scan = Math.min(raw.length, QUESTIONNAIRE_LIMITS.maxQuestionCandidates);
  let nestedTruncated = false;
  for (
    let sourceIndex = 0;
    sourceIndex < scan && questions.length < QUESTIONNAIRE_LIMITS.maxQuestions;
    sourceIndex += 1
  ) {
    const candidate = record(raw[sourceIndex]);
    if (!candidate) continue;
    const rawId = typeof candidate.id === "string" ? candidate.id : `q${sourceIndex + 1}`;
    const [id, idCut] = text(rawId, QUESTIONNAIRE_LIMITS.maxIdChars);
    const [label, labelCut] = text(
      candidate.label,
      QUESTIONNAIRE_LIMITS.maxLabelChars,
      `Q${sourceIndex + 1}`,
    );
    const [prompt, promptCut] = text(
      candidate.prompt,
      QUESTIONNAIRE_LIMITS.maxPromptChars,
      "[question unavailable]",
    );
    const decodedAnswer = answers.find((item) => item.rawId === rawId);
    if (decodedAnswer) joinedAnswers.add(decodedAnswer);
    const answer = decodedAnswer?.view;
    const rawOptions = candidate.options;
    const decodedOptions: Array<{
      view: QuestionnaireOptionView;
      rawLabel: string | null;
      rawValue: string | null;
      sourceIndex: number;
    }> = [];
    let optionStringTruncated = false;
    if (Array.isArray(rawOptions)) {
      const optionScan = Math.min(rawOptions.length, QUESTIONNAIRE_LIMITS.maxOptionCandidates);
      for (
        let optionIndex = 0;
        optionIndex < optionScan &&
        decodedOptions.length < QUESTIONNAIRE_LIMITS.maxOptionsPerQuestion;
        optionIndex += 1
      ) {
        const option = record(rawOptions[optionIndex]);
        if (!option) continue;
        const [value, valueCut] = text(
          option.value,
          QUESTIONNAIRE_LIMITS.maxValueChars,
          `option-${optionIndex + 1}`,
        );
        const [optionLabel, optionLabelCut] = text(
          option.label,
          QUESTIONNAIRE_LIMITS.maxLabelChars,
          "[option unavailable]",
        );
        const [description, descriptionCut] = text(
          option.description,
          QUESTIONNAIRE_LIMITS.maxDescriptionChars,
        );
        const truncated = valueCut || optionLabelCut || descriptionCut;
        optionStringTruncated ||= truncated;
        decodedOptions.push({
          view: {
            value,
            label: optionLabel,
            ...(typeof option.description === "string" ? { description } : {}),
            selected: false,
            truncated,
          },
          rawLabel: typeof option.label === "string" ? option.label : null,
          rawValue: typeof option.value === "string" ? option.value : null,
          sourceIndex: optionIndex,
        });
      }
    }
    if (decodedAnswer && answer && !answer.wasCustom) {
      const hasValidIndex =
        decodedAnswer.rawIndex !== undefined &&
        Array.isArray(rawOptions) &&
        decodedAnswer.rawIndex <= rawOptions.length &&
        record(rawOptions[decodedAnswer.rawIndex - 1]) !== null;
      const selected =
        decodedAnswer.rawIndex !== undefined
          ? hasValidIndex
            ? decodedOptions.find((option) => option.sourceIndex === decodedAnswer.rawIndex! - 1)
            : undefined
          : ((decodedAnswer.rawValue === null
              ? undefined
              : decodedOptions.find((option) => option.rawValue === decodedAnswer.rawValue)) ??
            (decodedAnswer.rawLabel === null
              ? undefined
              : decodedOptions.find((option) => option.rawLabel === decodedAnswer.rawLabel)));
      if (selected) selected.view.selected = true;
    }
    const options = decodedOptions.map((option) => option.view);
    const omittedOptions = Math.max(0, boundedLength(rawOptions) - options.length);
    const truncated = idCut || labelCut || promptCut || optionStringTruncated;
    nestedTruncated ||= truncated;
    questions.push({
      id,
      label,
      prompt,
      options,
      ...(answer ? { answer } : {}),
      omittedOptions,
      truncated,
    });
  }
  const omitted = Math.max(0, boundedLength(raw) - questions.length);
  return { questions, joinedAnswers, omitted, truncated: nestedTruncated };
}

/**
 * Total best-effort decoder for opaque transcript tool args/results. It prefers the
 * questionnaire's normalized result `details.questions`, then falls back to call
 * args. This browser normalization does not alter the producer/envelope contract.
 *
 * Legacy questionnaire error results omit `isError`; a cancelled, unanswered result
 * whose bounded text begins exactly with `Error:` is therefore normalized as failed.
 */
export function decodeQuestionnaireRendererView(
  rawArgs: unknown,
  rawResult?: unknown,
): QuestionnaireRendererView {
  try {
    const args = record(rawArgs);
    const result = record(rawResult);
    const details = record(result?.details);
    const detailQuestions = details?.questions;
    const argQuestions = args?.questions;
    const questionSource =
      Array.isArray(detailQuestions) && detailQuestions.length > 0 ? detailQuestions : argQuestions;
    const decodedAnswers = decodeAnswers(details?.answers);
    const decodedQuestions = decodeQuestions(questionSource, decodedAnswers.answers);
    const orphanAnswers = decodedAnswers.answers
      .filter((answer) => !decodedQuestions.joinedAnswers.has(answer))
      .map((answer) => answer.view);
    const output = resultText(result);
    const cancelled = details?.cancelled === true;
    const unanswered = decodedAnswers.answers.length === 0;
    const legacyError = cancelled && unanswered && output.value.startsWith("Error:");
    const failed = result?.isError === true || legacyError;
    const status: QuestionnaireStatus = failed
      ? "failed"
      : rawResult === undefined || result?.isPartial === true
        ? "running"
        : cancelled
          ? "cancelled"
          : "completed";
    const [error, errorCut] = text(
      output.value || (failed ? "Questionnaire failed" : ""),
      QUESTIONNAIRE_LIMITS.maxErrorChars,
    );
    const errorTruncated = output.truncated || errorCut;
    const unusable =
      decodedQuestions.questions.length === 0 ||
      !decodedQuestions.questions.some((question) => question.prompt !== "[question unavailable]");
    const view: QuestionnaireRendererView = {
      status,
      questions: decodedQuestions.questions,
      orphanAnswers,
      omittedQuestions: decodedQuestions.omitted,
      omittedAnswers: decodedAnswers.omitted,
      truncated:
        decodedQuestions.truncated || decodedAnswers.truncated || (failed && errorTruncated),
      unusable,
      ...(failed ? { error } : {}),
    };
    return Check(QuestionnaireRendererViewSchema, view) ? view : EMPTY_VIEW;
  } catch {
    return EMPTY_VIEW;
  }
}

export function isQuestionnaireRendererView(value: unknown): value is QuestionnaireRendererView {
  return Check(QuestionnaireRendererViewSchema, value);
}
