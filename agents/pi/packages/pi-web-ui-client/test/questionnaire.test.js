import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  decodeQuestionnaireRendererView,
  QUESTIONNAIRE_LIMITS,
  QuestionnaireRendererViewSchema,
} from "../src/wire/index.ts";
import { questionnaireDecoderFixtures } from "../src/testing/index.ts";

const fixtures = questionnaireDecoderFixtures();

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`questionnaire decoder is total and schema-valid: ${name}`, () => {
    const view = decodeQuestionnaireRendererView(fixture.args, fixture.result);
    assert.equal(Check(QuestionnaireRendererViewSchema, view), true);
  });
}

test("selected and custom answers join to normalized detail questions", () => {
  const view = decodeQuestionnaireRendererView(fixtures.selected.args, fixtures.selected.result);
  assert.equal(view.status, "completed");
  assert.equal(view.questions[0].label, "Scope");
  assert.equal(view.questions[1].label, "Q2");
  assert.equal(view.questions[0].answer.wasCustom, false);
  assert.equal(view.questions[0].options[1].selected, true);
  assert.equal(view.questions[1].answer.wasCustom, true);
  assert.equal(view.questions[1].answer.label, "Ship it <b>literally</b>");
});

test("running, partial, cancelled, explicit and legacy errors derive deterministic states", () => {
  assert.equal(decodeQuestionnaireRendererView(fixtures.running.args).status, "running");
  assert.equal(
    decodeQuestionnaireRendererView(fixtures.partial.args, fixtures.partial.result).status,
    "running",
  );
  assert.equal(
    decodeQuestionnaireRendererView(fixtures.cancelled.args, fixtures.cancelled.result).status,
    "cancelled",
  );
  const legacy = decodeQuestionnaireRendererView(
    fixtures.legacyErrorResult.args,
    fixtures.legacyErrorResult.result,
  );
  assert.equal(legacy.status, "failed");
  assert.match(legacy.error, /^Error:/);
  assert.equal(
    decodeQuestionnaireRendererView(fixtures.isError.args, fixtures.isError.result).status,
    "failed",
  );
  const notLegacy = structuredClone(fixtures.legacyErrorResult.result);
  notLegacy.content[0].text = " Error: leading whitespace is not the legacy marker";
  assert.equal(
    decodeQuestionnaireRendererView(fixtures.legacyErrorResult.args, notLegacy).status,
    "cancelled",
  );
});

test("opaque payload normalization prefers details, falls back to args, and retains orphans", () => {
  const preferred = decodeQuestionnaireRendererView(
    { questions: [{ id: "arg", prompt: "Arg prompt", options: [] }] },
    {
      details: {
        questions: [{ id: "detail", label: "Detail", prompt: "Detail prompt", options: [] }],
        answers: [],
        cancelled: false,
      },
    },
  );
  assert.equal(preferred.questions[0].id, "detail");
  const fallback = decodeQuestionnaireRendererView(fixtures.selected.args, {
    details: { questions: "bad", answers: [], cancelled: false },
  });
  assert.equal(fallback.questions[0].id, "scope");
  const orphan = decodeQuestionnaireRendererView(fixtures.orphan.args, fixtures.orphan.result);
  assert.equal(orphan.orphanAnswers[0].id, "removed");
  assert.equal(orphan.orphanAnswers[0].label, "Orphan label");
});

test("malformed, throwing, hostile, and overlong payloads remain safe and bounded", () => {
  const malformed = decodeQuestionnaireRendererView(
    fixtures.malformed.args,
    fixtures.malformed.result,
  );
  assert.equal(malformed.questions.length, 1);
  assert.equal(malformed.questions[0].prompt, "[question unavailable]");

  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("hostile getter");
      },
    },
  );
  assert.doesNotThrow(() => decodeQuestionnaireRendererView(throwing, throwing));
  assert.equal(decodeQuestionnaireRendererView(throwing, throwing).unusable, true);

  const hostile = decodeQuestionnaireRendererView(fixtures.hostile.args);
  assert.match(hostile.questions[0].prompt, /<script>/);
  assert.equal(hostile.questions.length, 1);

  const overlong = decodeQuestionnaireRendererView(fixtures.overlong.args);
  assert.equal(overlong.questions[0].id.length, QUESTIONNAIRE_LIMITS.maxIdChars);
  assert.equal(overlong.questions[0].label.length, QUESTIONNAIRE_LIMITS.maxLabelChars);
  assert.equal(overlong.questions[0].prompt.length, QUESTIONNAIRE_LIMITS.maxPromptChars);
  assert.equal(
    overlong.questions[0].options[0].description.length,
    QUESTIONNAIRE_LIMITS.maxDescriptionChars,
  );
  assert.equal(overlong.truncated, true);
});

test("raw IDs remain exact for joins even when exported IDs collide after truncation", () => {
  const prefix = "i".repeat(QUESTIONNAIRE_LIMITS.maxIdChars);
  const args = {
    questions: [
      { id: `${prefix}-first`, prompt: "First", options: [] },
      { id: `${prefix}-second`, prompt: "Second", options: [] },
    ],
  };
  const result = {
    details: {
      questions: args.questions,
      answers: [
        { id: `${prefix}-second`, value: "answer", label: "Second answer", wasCustom: true },
      ],
      cancelled: false,
    },
  };
  const view = decodeQuestionnaireRendererView(args, result);
  assert.equal(view.questions[0].id, view.questions[1].id);
  assert.equal(view.questions[0].answer, undefined);
  assert.equal(view.questions[1].answer.label, "Second answer");
  assert.equal(view.orphanAnswers.length, 0);
});

test("option selection chooses one raw position or one exact untruncated fallback", () => {
  const prefix = "v".repeat(QUESTIONNAIRE_LIMITS.maxValueChars);
  const questions = [
    {
      id: "indexed",
      prompt: "Indexed duplicates",
      options: [
        { value: "duplicate", label: "Same" },
        { value: "duplicate", label: "Same" },
      ],
    },
    {
      id: "truncated",
      prompt: "Truncated collision",
      options: [
        { value: `${prefix}-first`, label: "First" },
        { value: `${prefix}-second`, label: "Second" },
      ],
    },
    {
      id: "label",
      prompt: "Label duplicate",
      options: [
        { value: "first", label: "Repeated" },
        { value: "second", label: "Repeated" },
      ],
    },
  ];
  const view = decodeQuestionnaireRendererView(
    { questions },
    {
      details: {
        questions,
        answers: [
          { id: "indexed", value: "duplicate", label: "Same", wasCustom: false, index: 2 },
          { id: "truncated", value: `${prefix}-second`, label: "Second", wasCustom: false },
          { id: "label", value: "missing", label: "Repeated", wasCustom: false, index: 0 },
        ],
        cancelled: false,
      },
    },
  );
  assert.deepEqual(
    view.questions.map((question) => question.options.map((option) => option.selected)),
    [
      [false, true],
      [false, true],
      [true, false],
    ],
  );
});

test("out-of-view option indices never select a retained duplicate", () => {
  const options = Array.from({ length: 129 }, (_, index) => ({
    value: index === 0 || index === 128 ? "duplicate" : `value-${index}`,
    label: `Option ${index + 1}`,
  }));
  const view = decodeQuestionnaireRendererView(
    { questions: [{ id: "choice", prompt: "Choose", options }] },
    {
      details: {
        questions: [{ id: "choice", prompt: "Choose", options }],
        answers: [
          {
            id: "choice",
            value: "duplicate",
            label: "Option 129",
            wasCustom: false,
            index: 129,
          },
        ],
        cancelled: false,
      },
    },
  );
  assert.equal(
    view.questions[0].options.some((option) => option.selected),
    false,
  );
});

test("missing answer labels fall back to values and unused result text does not truncate", () => {
  const args = { questions: [{ id: "q", prompt: "Question", options: [] }] };
  const view = decodeQuestionnaireRendererView(args, {
    content: [{ type: "text", text: "x".repeat(QUESTIONNAIRE_LIMITS.maxErrorChars + 1) }],
    details: {
      questions: args.questions,
      answers: [{ id: "q", value: "usable value", wasCustom: true }],
      cancelled: false,
    },
  });
  assert.equal(view.questions[0].answer.label, "usable value");
  assert.equal(view.questions[0].answer.value, "usable value");
  assert.equal(view.truncated, false);
});

test("failed result text is character- and candidate-bounded with explicit truncation", () => {
  const args = { questions: [{ id: "q", prompt: "Question", options: [] }] };
  const content = Array.from(
    { length: QUESTIONNAIRE_LIMITS.maxContentCandidates + 1 },
    (_, index) => ({ type: "text", text: index === 0 ? "Error: " + "x".repeat(2_000) : "later" }),
  );
  const view = decodeQuestionnaireRendererView(args, {
    isError: true,
    content,
    details: { questions: args.questions, answers: [], cancelled: true },
  });
  assert.equal(view.status, "failed");
  assert.equal(view.error.length, QUESTIONNAIRE_LIMITS.maxErrorChars);
  assert.equal(view.truncated, true);
});

test("question, option, and answer limits account for every omitted candidate", () => {
  const view = decodeQuestionnaireRendererView(fixtures.bounded.args, fixtures.bounded.result);
  assert.equal(view.questions.length, QUESTIONNAIRE_LIMITS.maxQuestions);
  assert.equal(
    view.questions.every(
      (question) => question.options.length === QUESTIONNAIRE_LIMITS.maxOptionsPerQuestion,
    ),
    true,
  );
  assert.equal(
    view.questions.every((question) => question.omittedOptions === 1),
    true,
  );
  assert.equal(view.omittedQuestions, 1);
  assert.equal(view.omittedAnswers, 1);
  assert.equal(view.truncated, false, "omission metadata is separate from string truncation");
});

test("failed error truncation remains independent from omission metadata", () => {
  const view = decodeQuestionnaireRendererView(
    fixtures.overlongFailedWithOmissions.args,
    fixtures.overlongFailedWithOmissions.result,
  );
  assert.equal(view.status, "failed");
  assert.equal(view.error.length, QUESTIONNAIRE_LIMITS.maxErrorChars);
  assert.equal(view.omittedQuestions, 1);
  assert.equal(view.omittedAnswers, 1);
  assert.equal(view.truncated, true);
});
