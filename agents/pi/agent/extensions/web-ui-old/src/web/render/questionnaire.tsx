import { asArray, asRecord, num, str } from "../lib/tool-model.js";
import { pluralize } from "../lib/text.js";
import type { ToolAdapter } from "./types.js";

export const questionnaireAdapter: ToolAdapter = {
  glyph: "?",
  label: "questionnaire",
  title: (view) => {
    const detailQuestions = asArray(view.details.questions);
    const questions = detailQuestions.length > 0 ? detailQuestions : asArray(view.args.questions);
    const labels = questions
      .map((question) => str(asRecord(question).label) ?? str(asRecord(question).id))
      .filter(Boolean)
      .join(", ");
    return (
      <span class="tool__command">
        {pluralize(questions.length, "question")}
        {labels ? <span class="tool__hint"> ({labels})</span> : null}
      </span>
    );
  },
  summary: (view) => {
    if (view.isPartial) return "waiting for response…";
    if (view.isError) return view.text.split("\n")[0] || "questionnaire failed";
    if (view.details.cancelled === true) return "cancelled";
    const answers = asArray(view.details.answers);
    return `${pluralize(answers.length, "answer")}`;
  },
  detail: (view) => {
    if (view.isError) return <p class="answer answer--error">{view.text}</p>;
    if (view.details.cancelled === true)
      return <p class="answer answer--cancelled">{view.text || "Cancelled"}</p>;
    const answers = asArray(view.details.answers).map(asRecord);
    if (answers.length === 0) return undefined;
    return (
      <ul class="answers">
        {answers.map((answer, index) => {
          const id = str(answer.id) ?? `q${index + 1}`;
          const label = str(answer.label) ?? "";
          const wrote = answer.wasCustom === true;
          const position = num(answer.index);
          return (
            <li key={id} class="answer">
              <span class="answer__mark" aria-hidden="true">
                ✓
              </span>
              <span class="answer__id">{id}</span>
              <span class="answer__value">
                {wrote ? <span class="answer__wrote">(wrote) </span> : null}
                {!wrote && position !== undefined ? `${position}. ` : ""}
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    );
  },
};
