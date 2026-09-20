// The questionnaire extension and the generic fallback every unrecognized tool lands on.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  decodeQuestionnaireRendererView,
  type QuestionnaireAnswerView,
  type QuestionnaireRendererView,
} from "../../wire/questionnaire.ts";
import { pluralize, redactImageResources, truncate } from "../format.ts";
import { ExpandableOutput, ImageBlock, Output, Summary } from "./shared.tsx";
import {
  defineTool,
  rawResult,
  type RegisteredTool,
  type ToolContext,
  type ToolResultView,
  type ToolStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// questionnaire
// ---------------------------------------------------------------------------

function Answer({ answer }: { answer: QuestionnaireAnswerView }) {
  return (
    <span class="questionnaire-answer">
      <span aria-hidden="true">✓ </span>
      {answer.wasCustom ? "Custom answer: " : "Selected: "}
      {answer.label || answer.value || "[answer unavailable]"}
      {answer.truncated ? " … [truncated]" : null}
    </span>
  );
}

function QuestionnaireView({
  view,
  expanded,
}: {
  view: QuestionnaireRendererView;
  expanded: boolean;
}) {
  const answered = view.questions.filter((question) => question.answer).length;
  const summaryQuestions = view.questions.filter(
    (question) => question.answer || (view.status !== "running" && view.status !== "failed"),
  );
  const stateText =
    view.status === "running"
      ? "Response is awaited in the session terminal."
      : view.status === "failed"
        ? view.error || "Questionnaire failed."
        : view.status === "cancelled"
          ? "Questionnaire was cancelled."
          : view.omittedQuestions || view.omittedAnswers
            ? `${answered} answers shown for ${view.questions.length} questions shown.`
            : `${answered} of ${view.questions.length} questions answered.`;
  const previousStatus = useRef(view.status);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement(
      previousStatus.current === "running" && view.status !== "running" ? stateText : "",
    );
    previousStatus.current = view.status;
  }, [stateText, view.status]);
  return (
    <div class="questionnaire-view">
      <div class={`questionnaire-status status-${view.status}`}>{stateText}</div>
      <span class="questionnaire-announcement" role="status" aria-live="polite">
        {announcement}
      </span>
      {!expanded ? null : summaryQuestions.length ? (
        <dl class="questionnaire-summary">
          {summaryQuestions.map((question, index) => (
            <div key={`${question.id}:${index}`} class="questionnaire-summary-row">
              <dt>{question.label || `Q${index + 1}`}</dt>
              <dd>
                {question.answer ? (
                  <Answer answer={question.answer} />
                ) : (
                  <span class="structured-muted">Not answered</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {expanded && view.orphanAnswers.length ? (
        <div class="questionnaire-orphans">
          <div class="structured-muted">Answers without a matching question</div>
          <ul>
            {view.orphanAnswers.map((answer, index) => (
              <li key={`${answer.id}:${index}`}>
                <strong>{answer.id || `Answer ${index + 1}`}</strong>: <Answer answer={answer} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!expanded ? null : view.unusable ? (
        <p class="questionnaire-degraded">Question details are unavailable or malformed.</p>
      ) : (
        <ol class="questionnaire-questions">
          {view.questions.map((question, questionIndex) => (
            <li key={`${question.id}:${questionIndex}`}>
              <div class="questionnaire-prompt">
                <strong>{question.label}</strong> — {question.prompt}
                {question.truncated ? " … [truncated]" : null}
              </div>
              {question.options.length ? (
                <ul class="questionnaire-options">
                  {question.options.map((option, optionIndex) => (
                    <li key={`${option.value}:${optionIndex}`}>
                      <span aria-hidden="true">{option.selected ? "✓" : "–"} </span>
                      <span>{option.selected ? "Selected: " : "Option: "}</span>
                      <strong>{option.label}</strong>
                      {option.description ? <span> — {option.description}</span> : null}
                      {option.truncated ? " … [truncated]" : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div class="structured-muted">No usable options.</div>
              )}
              {question.omittedOptions ? (
                <div class="questionnaire-omitted">
                  {pluralize(question.omittedOptions, "option")} omitted
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {view.omittedQuestions || view.omittedAnswers ? (
        <p class="questionnaire-omitted">
          {[
            view.omittedQuestions ? `${pluralize(view.omittedQuestions, "question")} omitted` : "",
            view.omittedAnswers ? `${pluralize(view.omittedAnswers, "answer")} omitted` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {view.truncated ? (
        <p class="questionnaire-omitted">Questionnaire text was truncated for display.</p>
      ) : null}
    </div>
  );
}

/**
 * The questionnaire is read-only here: it is answered in the session terminal, and
 * the browser reports its progress. Its own status, not the tool result, says
 * whether it is still waiting, so it overrides the box tone.
 */
const questionnaire = defineTool({
  names: ["questionnaire"],
  headerClass: "tool-header custom-tool-header",
  // Questions come from the arguments but answers only arrive with the result, so the
  // view is decoded from both at once and drives the header, the tone and the body.
  decode: (raw, result) =>
    decodeQuestionnaireRendererView(raw, result ? rawResult(result) : undefined),
  header: (view) => {
    const labels = view.questions
      .map((question) => question.label)
      .filter(Boolean)
      .join(", ");
    return (
      <>
        <span class="tool-name">questionnaire</span>
        <span class="line-count">
          {` · ${pluralize(view.questions.length, "question")}${labels ? ` (${labels})` : ""}`}
        </span>
      </>
    );
  },
  // The questionnaire tracks its own state: it is answered in the session terminal,
  // so a settled tool result does not mean the questions were answered.
  status: (view): ToolStatus =>
    view.status === "running" ? "pending" : view.status === "completed" ? "success" : "error",
  body: (view, _result, { expanded }) => <QuestionnaireView view={view} expanded={expanded} />,
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * Any tool with no dedicated renderer: an extension installed after this build, or
 * one whose result shape is unknown. The name and a one-line result preview keep the
 * row meaningful while collapsed; expanding shows the arguments and the output, both
 * bounded because an unknown payload has no size guarantee.
 */
export function fallbackRendering(
  name: string,
  raw: Readonly<Record<string, unknown>>,
  result: ToolResultView | undefined,
  ctx: ToolContext,
) {
  return {
    headerClass: "tool-header",
    header: <span class="tool-name">{name}</span>,
    body: (
      <>
        <ImageBlock list={result?.images ?? []} cls="tool-image" />
        {ctx.expanded ? (
          <>
            <Output text={JSON.stringify(redactImageResources(raw), null, 2)} />
            {result?.text ? (
              <ExpandableOutput
                text={result.text}
                maxLines={10}
                tone={result.isError ? "error-output" : ""}
                dkey={`${ctx.dkey}:out`}
              />
            ) : null}
          </>
        ) : result ? (
          <Summary
            text={truncate(result.text.replaceAll(/\s+/g, " ").trim(), 160)}
            status={result.isError ? "error" : undefined}
          />
        ) : null}
      </>
    ),
  };
}

export const OTHER_TOOLS: readonly RegisteredTool[] = [questionnaire];
