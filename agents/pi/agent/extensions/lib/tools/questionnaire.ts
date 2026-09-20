// The questionnaire tool's renderer.
//
// Mirrors two browser modules: `src/wire/questionnaire.ts` for the decode boundary and the
// `questionnaire` entry of `src/client/tools/other.tsx` for the view. The questions are model
// arguments and the answers arrive with the result, so one decode reads both and drives the
// header, the tone and the body — as it does there.
//
// This is the one tool whose state is not its result's state: it is answered in the terminal, so
// a settled result can still mean "cancelled". The browser says so by overriding the box tone
// through `status()`, and the terminal cannot: Pi derives its shell's background from
// `isError` alone, and `AgentToolResult` has no `isError` for `execute` to set.
//
// `renderShell: "self"` — drawing our own box, tinted by the questionnaire's own state — was
// tried and rejected. It requires exactly one of the two slots to be non-empty, since there is no
// shared box to append into, and no context field can tell "pending" from "settled" in every
// host: Pi's HTML exporter calls `renderCall` with `isPartial: true` hardcoded and then
// `renderResult` with `isPartial: false`, emitting both
// (`dist/core/export-html/tool-renderer.js`). Any such split therefore duplicates the card in
// every export, with the first copy claiming a settled questionnaire is still awaiting an answer.
// So the tone stays Pi's, and the state is carried by the status line — in the browser's own
// colours — where it is legible either way.
//
// Deliberately not ported from the browser's decoder: its TypeBox re-validation of the
// decoded view, which guards a wire boundary this side does not have. The bounds are ported,
// because the questions come from the model either way.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { oneLine, pluralize, sanitizeRenderedValue, truncate } from "./format.ts";
import { details, toolName } from "./render.ts";
import { defineRenderer, type Renderer, type ResultView } from "./types.ts";

/**
 * Display bounds, mirroring the browser's `QUESTIONNAIRE_LIMITS`. The questions come from the
 * model, so one call can carry thousands of them or megabyte-long prompts; both surfaces bound
 * what they draw and then say how much they left out.
 */
export const QUESTIONNAIRE_LIMITS = {
  maxQuestions: 32,
  maxOptionsPerQuestion: 32,
  maxAnswers: 32,
  maxQuestionCandidates: 128,
  maxOptionCandidates: 128,
  maxAnswerCandidates: 128,
  maxIdChars: 256,
  maxLabelChars: 256,
  maxPromptChars: 1_024,
  maxDescriptionChars: 512,
  maxValueChars: 1_024,
  maxErrorChars: 1_024,
} as const;

export interface QuestionnaireAnswerView {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly wasCustom: boolean;
  readonly truncated: boolean;
}

export interface QuestionnaireOptionView {
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly truncated: boolean;
}

export interface QuestionnaireQuestionView {
  readonly label: string;
  readonly prompt: string;
  readonly options: readonly QuestionnaireOptionView[];
  readonly answer: QuestionnaireAnswerView | undefined;
  readonly omittedOptions: number;
  readonly truncated: boolean;
}

export type QuestionnaireStatus = "running" | "completed" | "cancelled" | "failed";

export interface QuestionnaireView {
  readonly status: QuestionnaireStatus;
  readonly questions: readonly QuestionnaireQuestionView[];
  /** Answers whose question is not in the payload, so nothing else would show them. */
  readonly orphanAnswers: readonly QuestionnaireAnswerView[];
  readonly omittedQuestions: number;
  readonly omittedAnswers: number;
  readonly truncated: boolean;
  /** No question survived decoding, so the question list would be a list of placeholders. */
  readonly unusable: boolean;
  readonly error: string;
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

type RawRecord = Record<string, unknown>;

const record = (value: unknown): RawRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;

/** A bounded, terminal-safe string, plus whether the payload carried more than that. */
function bounded(value: unknown, max: number, fallback: string): [string, boolean] {
  if (typeof value !== "string") return [fallback, false];
  return [sanitizeRenderedValue(value.slice(0, max)), value.length > max];
}

/** One line of it: everything but a prompt is `white-space: normal` in the browser. */
function field(value: unknown, max: number, fallback = ""): [string, boolean] {
  const [text, cut] = bounded(value, max, fallback);
  return [oneLine(text) || fallback, cut];
}

/** Line breaks kept: the browser renders prompts `pre-wrap`, and a `Text` wraps the same. */
const paragraph = (value: unknown, max: number, fallback = ""): [string, boolean] =>
  bounded(value, max, fallback);

/** How many entries a payload array holds beyond the ones that were kept. */
const omitted = (raw: unknown, kept: number): number =>
  Array.isArray(raw) ? Math.max(0, raw.length - kept) : 0;

interface DecodedAnswer {
  readonly view: QuestionnaireAnswerView;
  readonly rawId: string;
  readonly rawLabel: string | null;
  readonly rawValue: string | null;
  /** The 1-based option number the tool recorded, absent for a typed answer. */
  readonly rawIndex: number | undefined;
}

function decodeAnswers(raw: unknown): { answers: DecodedAnswer[]; truncated: boolean } {
  if (!Array.isArray(raw)) return { answers: [], truncated: false };
  const answers: DecodedAnswer[] = [];
  const scan = Math.min(raw.length, QUESTIONNAIRE_LIMITS.maxAnswerCandidates);
  let truncated = false;
  for (let index = 0; index < scan && answers.length < QUESTIONNAIRE_LIMITS.maxAnswers; index++) {
    const candidate = record(raw[index]);
    if (!candidate || typeof candidate.id !== "string") continue;
    const [id, idCut] = field(candidate.id, QUESTIONNAIRE_LIMITS.maxIdChars);
    const [value, valueCut] = field(candidate.value, QUESTIONNAIRE_LIMITS.maxValueChars);
    const [label, labelCut] = field(
      candidate.label,
      QUESTIONNAIRE_LIMITS.maxValueChars,
      value || "[answer unavailable]",
    );
    // Any safe 1-based number counts as a recorded choice, even one past the end of the
    // options: it selects nothing, rather than falling back to matching by value, because the
    // payload did record a choice. Only its absence opens the fallback.
    const rawIndex = candidate.index;
    const optionNumber =
      typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) && rawIndex >= 1
        ? rawIndex
        : undefined;
    truncated ||= idCut || labelCut || valueCut;
    answers.push({
      view: {
        id,
        label,
        value: value || label,
        wasCustom: candidate.wasCustom === true,
        truncated: idCut || labelCut || valueCut,
      },
      rawId: candidate.id,
      rawLabel: typeof candidate.label === "string" ? candidate.label : null,
      rawValue: typeof candidate.value === "string" ? candidate.value : null,
      rawIndex: optionNumber,
    });
  }
  return { answers, truncated };
}

/** One decoded option, plus what it takes to match an answer back to it. */
interface DecodedOption {
  label: string;
  description: string;
  truncated: boolean;
  rawLabel: string | null;
  rawValue: string | null;
  /** Its position in the payload, which is what a recorded `index` counts. */
  sourceIndex: number;
}

/**
 * Which option an answer selected: the recorded 1-based number when the payload has one,
 * otherwise the option whose value — then label — matches, which is all a foreign or
 * pre-`index` payload leaves to go on. A typed answer selects none.
 *
 * The number counts positions in the payload, not in the decoded list, so an entry that was
 * not a record (and so was dropped) must not shift the mark. A number past the end of the
 * payload selects nothing rather than falling through to matching by value, because the
 * payload did record a choice — it just does not correspond to an option.
 */
function selectedOption(
  answer: DecodedAnswer | undefined,
  options: readonly DecodedOption[],
): number {
  if (!answer || answer.view.wasCustom) return -1;
  if (answer.rawIndex !== undefined)
    return options.findIndex((option) => option.sourceIndex === answer.rawIndex! - 1);
  if (answer.rawValue !== null) {
    const byValue = options.findIndex((option) => option.rawValue === answer.rawValue);
    if (byValue !== -1) return byValue;
  }
  if (answer.rawLabel !== null)
    return options.findIndex((option) => option.rawLabel === answer.rawLabel);
  return -1;
}

function decodeQuestions(
  raw: unknown,
  answers: readonly DecodedAnswer[],
): {
  questions: QuestionnaireQuestionView[];
  joined: Set<DecodedAnswer>;
  truncated: boolean;
} {
  if (!Array.isArray(raw)) return { questions: [], joined: new Set(), truncated: false };
  const questions: QuestionnaireQuestionView[] = [];
  const joined = new Set<DecodedAnswer>();
  const scan = Math.min(raw.length, QUESTIONNAIRE_LIMITS.maxQuestionCandidates);
  let truncated = false;
  for (
    let index = 0;
    index < scan && questions.length < QUESTIONNAIRE_LIMITS.maxQuestions;
    index++
  ) {
    const candidate = record(raw[index]);
    if (!candidate) continue;
    const rawId = typeof candidate.id === "string" ? candidate.id : `q${index + 1}`;
    const [, idCut] = field(rawId, QUESTIONNAIRE_LIMITS.maxIdChars);
    const [label, labelCut] = field(
      candidate.label,
      QUESTIONNAIRE_LIMITS.maxLabelChars,
      `Q${index + 1}`,
    );
    const [prompt, promptCut] = paragraph(
      candidate.prompt,
      QUESTIONNAIRE_LIMITS.maxPromptChars,
      "[question unavailable]",
    );
    const answer = answers.find((item) => item.rawId === rawId);
    if (answer) joined.add(answer);

    const rawOptions = candidate.options;
    const decoded: DecodedOption[] = [];
    if (Array.isArray(rawOptions)) {
      const optionScan = Math.min(rawOptions.length, QUESTIONNAIRE_LIMITS.maxOptionCandidates);
      for (
        let optionIndex = 0;
        optionIndex < optionScan && decoded.length < QUESTIONNAIRE_LIMITS.maxOptionsPerQuestion;
        optionIndex++
      ) {
        const option = record(rawOptions[optionIndex]);
        if (!option) continue;
        const [optionLabel, optionLabelCut] = field(
          option.label,
          QUESTIONNAIRE_LIMITS.maxLabelChars,
          "[option unavailable]",
        );
        const [description, descriptionCut] = field(
          option.description,
          QUESTIONNAIRE_LIMITS.maxDescriptionChars,
        );
        const [, valueCut] = field(option.value, QUESTIONNAIRE_LIMITS.maxValueChars);
        decoded.push({
          label: optionLabel,
          description,
          truncated: optionLabelCut || descriptionCut || valueCut,
          rawLabel: typeof option.label === "string" ? option.label : null,
          rawValue: typeof option.value === "string" ? option.value : null,
          sourceIndex: optionIndex,
        });
      }
    }
    const selected = selectedOption(answer, decoded);
    const options = decoded.map((option, optionIndex) => ({
      label: option.label,
      description: option.description,
      selected: optionIndex === selected,
      truncated: option.truncated,
    }));

    // One flag for the question and its options, as the browser has: a question whose only
    // over-long field is an option label is marked on both lines there.
    const questionTruncated =
      idCut || labelCut || promptCut || options.some((option) => option.truncated);
    truncated ||= questionTruncated;
    questions.push({
      label,
      prompt,
      options,
      answer: answer?.view,
      omittedOptions: omitted(rawOptions, options.length),
      truncated: questionTruncated,
    });
  }
  return { questions, joined, truncated };
}

/**
 * The whole view, from the call's arguments and — once there is one — its result. Total by
 * construction: every malformed shape degrades to a placeholder rather than throwing, because
 * a renderer that throws is silently replaced by Pi's generic JSON fallback.
 *
 * The status is the questionnaire's own, not the tool call's: a legacy result carries a
 * cancellation with no answers and an `Error:` message, which is a failure rather than a
 * dismissal.
 */
export function decodeQuestionnaireView(
  rawArgs: unknown,
  result: ResultView | undefined,
): QuestionnaireView {
  const args = record(rawArgs);
  const detail = record(result?.details);
  const detailQuestions = detail?.questions;
  // Answers only exist in the result, and the result's questions are the normalized ones, so
  // they win — but a cancelled or malformed result falls back to what was asked for.
  const source =
    Array.isArray(detailQuestions) && detailQuestions.length > 0
      ? detailQuestions
      : args?.questions;
  const answers = decodeAnswers(detail?.answers);
  const questions = decodeQuestions(source, answers.answers);
  const orphanAnswers = answers.answers
    .filter((answer) => !questions.joined.has(answer))
    .map((answer) => answer.view);

  const cancelled = detail?.cancelled === true;
  const legacyError =
    cancelled && answers.answers.length === 0 && (result?.text ?? "").startsWith("Error:");
  const failed = result?.isError === true || legacyError;
  const status: QuestionnaireStatus = failed
    ? "failed"
    : result === undefined || result.isPartial
      ? "running"
      : cancelled
        ? "cancelled"
        : "completed";
  const [error, errorCut] = paragraph(
    result?.text || (failed ? "Questionnaire failed" : ""),
    QUESTIONNAIRE_LIMITS.maxErrorChars,
  );

  return {
    status,
    questions: questions.questions,
    orphanAnswers,
    omittedQuestions: omitted(source, questions.questions.length),
    omittedAnswers: omitted(detail?.answers, answers.answers.length),
    truncated: questions.truncated || answers.truncated || (failed && errorCut),
    unusable:
      questions.questions.length === 0 ||
      !questions.questions.some((question) => question.prompt !== "[question unavailable]"),
    error: failed ? error : "",
  };
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

/** `questionnaire · 2 questions (Scope, Notes)`. */
function header(theme: Theme, view: QuestionnaireView): string {
  const labels = view.questions
    .map((question) => question.label)
    .filter(Boolean)
    .join(", ");
  return `${toolName(theme, "questionnaire")}${details(theme, [
    `${pluralize(view.questions.length, "question")}${labels ? ` (${truncate(labels, 40)})` : ""}`,
  ])}`;
}

/** The line that is the whole collapsed body, and the first line of the expanded one. */
function statusText(view: QuestionnaireView): string {
  const answered = view.questions.filter((question) => question.answer).length;
  if (view.status === "running") return "Awaiting a response in the questionnaire.";
  if (view.status === "failed") return view.error || "Questionnaire failed.";
  if (view.status === "cancelled") return "Questionnaire was cancelled.";
  return view.omittedQuestions || view.omittedAnswers
    ? `${answered} answers shown for ${view.questions.length} questions shown.`
    : `${answered} of ${view.questions.length} questions answered.`;
}

/** The browser's `.questionnaire-status.status-*` colors. */
const STATUS_TONE = {
  running: "warning",
  completed: "success",
  cancelled: "muted",
  failed: "error",
} as const;

/** `✓ Selected: All`, the browser's `Answer`. */
const answerText = (theme: Theme, answer: QuestionnaireAnswerView): string =>
  `${theme.fg("success", "✓ ")}${answer.wasCustom ? "Custom answer: " : "Selected: "}${
    answer.label || answer.value || "[answer unavailable]"
  }${answer.truncated ? theme.fg("warning", " … [truncated]") : ""}`;

function questionLines(theme: Theme, question: QuestionnaireQuestionView): string[] {
  const lines = [
    `${theme.fg("toolTitle", theme.bold(question.label))} — ${question.prompt}${
      question.truncated ? theme.fg("warning", " … [truncated]") : ""
    }`,
  ];
  if (!question.options.length) lines.push(theme.fg("muted", "  No usable options."));
  for (const option of question.options) {
    const mark = theme.fg("accent", option.selected ? "✓ " : "– ");
    const kind = option.selected ? "Selected: " : "Option: ";
    lines.push(
      `  ${mark}${theme.fg("toolOutput", `${kind}${option.label}`)}${
        option.description ? theme.fg("dim", ` — ${option.description}`) : ""
      }${option.truncated ? theme.fg("warning", " … [truncated]") : ""}`,
    );
  }
  if (question.omittedOptions)
    lines.push(theme.fg("warning", `  ${pluralize(question.omittedOptions, "option")} omitted`));
  return lines;
}

/** The body: the status line alone when collapsed, the browser's full view when expanded. */
export function questionnaireBody(
  theme: Theme,
  view: QuestionnaireView,
  expanded: boolean,
): string {
  const sections = [theme.fg(STATUS_TONE[view.status], statusText(view))];
  if (expanded) {
    // A settled questionnaire lists every question in the summary, answered or not; a running
    // or failed one has nothing to say about the ones it never got to.
    const settled = view.status === "completed" || view.status === "cancelled";
    const summarized = view.questions.filter((question) => question.answer || settled);
    if (summarized.length)
      sections.push(
        summarized
          .map(
            (question) =>
              `${theme.fg("accent", theme.bold(`${question.label}:`))} ${
                question.answer
                  ? answerText(theme, question.answer)
                  : theme.fg("muted", "Not answered")
              }`,
          )
          .join("\n"),
      );
    if (view.orphanAnswers.length)
      sections.push(
        [
          theme.fg("muted", "Answers without a matching question"),
          ...view.orphanAnswers.map(
            (answer, index) =>
              `  ${theme.fg("accent", theme.bold(`${answer.id || `Answer ${index + 1}`}:`))} ${answerText(theme, answer)}`,
          ),
        ].join("\n"),
      );
    sections.push(
      view.unusable
        ? theme.fg("error", "Question details are unavailable or malformed.")
        : view.questions.flatMap((question) => questionLines(theme, question)).join("\n"),
    );
  }
  const notices = [
    view.omittedQuestions ? `${pluralize(view.omittedQuestions, "question")} omitted` : "",
    view.omittedAnswers ? `${pluralize(view.omittedAnswers, "answer")} omitted` : "",
  ].filter(Boolean);
  if (notices.length) sections.push(theme.fg("warning", notices.join(" · ")));
  if (view.truncated)
    sections.push(theme.fg("warning", "Questionnaire text was truncated for display."));
  return sections.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// slots
// ---------------------------------------------------------------------------

/**
 * The two slots Pi's own shell composes: the header names the call, the body reports the
 * questionnaire's state. Ordinary `defineRenderer` shape, because the alternative does not
 * survive every host — see the note above on `renderShell: "self"`.
 */
export const questionnaireRenderer: Renderer = defineRenderer<QuestionnaireView>({
  names: ["questionnaire"],
  // Questions come from the arguments and answers arrive with the result, so one decode reads
  // both and drives the header and the body.
  decode: (raw, result) => decodeQuestionnaireView(raw, result),
  header: (view, { theme }) => header(theme, view),
  body: (view, _result, { theme, expanded }) => questionnaireBody(theme, view, expanded),
});
