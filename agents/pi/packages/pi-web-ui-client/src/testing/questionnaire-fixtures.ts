import { QUESTIONNAIRE_LIMITS } from "../wire/questionnaire.ts";

const selectedQuestions = [
  {
    id: "scope",
    label: "Scope",
    prompt: "Which scope should be changed?",
    options: [
      { value: "small", label: "Small", description: "Only the affected module" },
      { value: "all", label: "All", description: "Every related module" },
    ],
  },
  {
    id: "notes",
    prompt: "Anything else?",
    options: [{ value: "none", label: "Nothing else" }],
  },
];

export const QUESTIONNAIRE_HOSTILE_TEXT =
  "<img src=x onerror=alert(1)><script>alert(2)</script> [link](javascript:alert(3)) https://example.invalid";

/** Shared opaque payload fixtures for decoder, mock transport, and standalone bundle tests. */
export function questionnaireDecoderFixtures() {
  const oversizedQuestions = Array.from(
    { length: QUESTIONNAIRE_LIMITS.maxQuestions + 1 },
    (_, questionIndex) => ({
      id: `bounded-${questionIndex}`,
      prompt: `Bounded question ${questionIndex}`,
      options: Array.from(
        { length: QUESTIONNAIRE_LIMITS.maxOptionsPerQuestion + 1 },
        (_, optionIndex) => ({ value: `v-${optionIndex}`, label: `Option ${optionIndex}` }),
      ),
    }),
  );
  const oversizedAnswers = Array.from(
    { length: QUESTIONNAIRE_LIMITS.maxAnswers + 1 },
    (_, index) => ({
      id: index < oversizedQuestions.length ? oversizedQuestions[index].id : `orphan-${index}`,
      value: "v-0",
      label: `Option ${index}`,
      wasCustom: false,
      index: 1,
    }),
  );
  const selectedResult = {
    content: [{ type: "text", text: "Questionnaire completed" }],
    details: {
      questions: selectedQuestions.map((question, index) => ({
        ...question,
        label: question.label || `Q${index + 1}`,
        allowOther: true,
      })),
      answers: [
        { id: "scope", value: "all", label: "All", wasCustom: false, index: 2 },
        {
          id: "notes",
          value: "Ship it <b>literally</b>",
          label: "Ship it <b>literally</b>",
          wasCustom: true,
        },
      ],
      cancelled: false,
    },
    isError: false,
  };
  return {
    selected: { args: { questions: selectedQuestions }, result: selectedResult },
    custom: { args: { questions: selectedQuestions }, result: selectedResult },
    running: { args: { questions: selectedQuestions }, result: undefined },
    partial: {
      args: { questions: selectedQuestions },
      result: {
        isPartial: true,
        details: { questions: selectedQuestions, answers: [selectedResult.details.answers[0]] },
      },
    },
    cancelled: {
      args: { questions: selectedQuestions },
      result: {
        content: [{ type: "text", text: "Questionnaire cancelled" }],
        details: { questions: selectedQuestions, answers: [], cancelled: true },
      },
    },
    legacyErrorResult: {
      args: { questions: selectedQuestions },
      result: {
        content: [{ type: "text", text: "Error: Questionnaire requires interactive TUI mode" }],
        details: { questions: selectedQuestions, answers: [], cancelled: true },
      },
    },
    isError: {
      args: { questions: selectedQuestions },
      result: {
        content: [{ type: "text", text: "Explicit failure" }],
        details: { questions: selectedQuestions, answers: [], cancelled: false },
        isError: true,
      },
    },
    orphan: {
      args: { questions: selectedQuestions },
      result: {
        details: {
          questions: selectedQuestions,
          answers: [{ id: "removed", value: "safe", label: "Orphan label", wasCustom: false }],
          cancelled: false,
        },
      },
    },
    malformed: { args: { questions: [null, 42, {}] }, result: { details: "bad" } },
    hostile: {
      args: {
        questions: [
          {
            id: QUESTIONNAIRE_HOSTILE_TEXT,
            label: QUESTIONNAIRE_HOSTILE_TEXT,
            prompt: QUESTIONNAIRE_HOSTILE_TEXT,
            options: [
              {
                value: QUESTIONNAIRE_HOSTILE_TEXT,
                label: QUESTIONNAIRE_HOSTILE_TEXT,
                description: QUESTIONNAIRE_HOSTILE_TEXT,
              },
            ],
          },
        ],
      },
      result: undefined,
    },
    overlong: {
      args: {
        questions: [
          {
            id: "i".repeat(QUESTIONNAIRE_LIMITS.maxIdChars + 10),
            label: "l".repeat(QUESTIONNAIRE_LIMITS.maxLabelChars + 10),
            prompt: "p".repeat(QUESTIONNAIRE_LIMITS.maxPromptChars + 10),
            options: [
              {
                value: "v".repeat(QUESTIONNAIRE_LIMITS.maxValueChars + 10),
                label: "o".repeat(QUESTIONNAIRE_LIMITS.maxLabelChars + 10),
                description: "d".repeat(QUESTIONNAIRE_LIMITS.maxDescriptionChars + 10),
              },
            ],
          },
        ],
      },
      result: undefined,
    },
    bounded: {
      args: { questions: oversizedQuestions },
      result: {
        details: { questions: oversizedQuestions, answers: oversizedAnswers, cancelled: false },
      },
    },
    overlongFailedWithOmissions: {
      args: { questions: oversizedQuestions },
      result: {
        content: [
          {
            type: "text",
            text: `Failure: ${"x".repeat(QUESTIONNAIRE_LIMITS.maxErrorChars + 10)}`,
          },
        ],
        details: { questions: oversizedQuestions, answers: oversizedAnswers, cancelled: false },
        isError: true,
      },
    },
  };
}

/** A selected/custom pair in normal transcript entry form. */
export function questionnaireFixtureEntries() {
  const fixture = questionnaireDecoderFixtures().selected;
  return [
    {
      id: "fx-questionnaire-call",
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-questionnaire",
            name: "questionnaire",
            arguments: fixture.args,
          },
        ],
      },
    },
    {
      id: "fx-questionnaire-result",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-questionnaire",
        toolName: "questionnaire",
        ...fixture.result,
      },
    },
  ];
}
