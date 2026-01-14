/**
 * Question Tool - Multiple questions with options and "Type your own" support
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionResult {
	question: string;
	answer: string | null;
	wasCustom?: boolean;
	id?: string;
}

interface QuestionDetails {
	results: QuestionResult[];
}

const OptionSchema = Type.Union([
	Type.String(),
	Type.Object({
		label: Type.String({ description: "Display label for the option" }),
		description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
	}),
]);

const QuestionItemSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
	id: Type.Optional(Type.String({ description: "Optional unique ID for the question" })),
});

const QuestionParams = Type.Union([
	Type.Object({
		questions: Type.Array(QuestionItemSchema, { description: "The list of questions to ask" }),
	}),
	Type.Object({
		question: Type.String({ description: "The question to ask the user" }),
		options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
	}),
]);

function normalizeOption(opt: string | { label: string; description?: string }): OptionWithDesc {
	if (typeof opt === "string") {
		return { label: opt };
	}
	return opt;
}

type SelectableItem =
	| { type: "option"; questionIndex: number; optionIndex: number; label: string; description?: string; isOther?: boolean }
	| { type: "submit" };

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user one or more questions and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const questionsToProcess = "questions" in params ? params.questions : [{ question: params.question, options: params.options }];

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						results: questionsToProcess.map((q) => ({
							question: q.question,
							answer: null,
							id: (q as any).id,
						})),
					} as QuestionDetails,
				};
			}

			if (questionsToProcess.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { results: [] } as QuestionDetails,
				};
			}

			const normalizedQuestions = questionsToProcess.map((q) => ({
				...q,
				options: [...q.options.map(normalizeOption), { label: "Type your own answer...", isOther: true }],
			}));

			const selectableItems: SelectableItem[] = [];
			for (let qIdx = 0; qIdx < normalizedQuestions.length; qIdx++) {
				const q = normalizedQuestions[qIdx];
				for (let oIdx = 0; oIdx < q.options.length; oIdx++) {
					const opt = q.options[oIdx];
					selectableItems.push({
						type: "option",
						questionIndex: qIdx,
						optionIndex: oIdx,
						label: opt.label,
						description: opt.description,
						isOther: opt.isOther,
					});
				}
			}
			selectableItems.push({ type: "submit" });

			const result = await ctx.ui.custom<QuestionResult[] | null>((tui, theme, _kb, done) => {
				let cursorIndex = 0;
				let editMode = false;
				let editingQuestionIndex = -1;
				let cachedLines: string[] | undefined;

				const selectedOptions: (number | null)[] = new Array(normalizedQuestions.length).fill(null);
				const customAnswers: (string | null)[] = new Array(normalizedQuestions.length).fill(null);

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(editorTheme);

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (trimmed) {
						customAnswers[editingQuestionIndex] = trimmed;
						selectedOptions[editingQuestionIndex] = normalizedQuestions[editingQuestionIndex].options.length - 1;
					}
					editMode = false;
					editingQuestionIndex = -1;
					editor.setText("");
					refresh();
				};

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function handleInput(data: string) {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editingQuestionIndex = -1;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						cursorIndex = Math.max(0, cursorIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						cursorIndex = Math.min(selectableItems.length - 1, cursorIndex + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter) || matchesKey(data, " ")) {
						const item = selectableItems[cursorIndex];
						if (item.type === "submit") {
							const allAnswered = selectedOptions.every((opt) => opt !== null);
							if (allAnswered) {
								const results: QuestionResult[] = normalizedQuestions.map((q, i) => {
									const optIdx = selectedOptions[i]!;
									const opt = q.options[optIdx];
									return {
										question: q.question,
										answer: opt.isOther ? customAnswers[i] : opt.label,
										wasCustom: opt.isOther,
										id: (q as any).id,
									};
								});
								done(results);
							}
						} else {
							if (item.isOther) {
								editMode = true;
								editingQuestionIndex = item.questionIndex;
								editor.setText(customAnswers[item.questionIndex] || "");
								refresh();
							} else {
								selectedOptions[item.questionIndex] = item.optionIndex;
								refresh();
							}
						}
						return;
					}

					if (matchesKey(data, Key.escape)) {
						done(null);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));

					for (let qIdx = 0; qIdx < normalizedQuestions.length; qIdx++) {
						const q = normalizedQuestions[qIdx];
						add(theme.fg("text", ` ${q.question}`));

						for (let oIdx = 0; oIdx < q.options.length; oIdx++) {
							const opt = q.options[oIdx];
							const itemIdx = selectableItems.findIndex(
								(it) => it.type === "option" && it.questionIndex === qIdx && it.optionIndex === oIdx,
							);
							const isFocused = cursorIndex === itemIdx;
							const isSelected = selectedOptions[qIdx] === oIdx;

							const radio = isSelected ? "●" : "○";
							const prefix = isFocused ? theme.fg("accent", "> ") : "  ";
							const radioColored = isSelected ? theme.fg("accent", radio) : theme.fg("text", radio);

							let label = opt.label;
							if (opt.isOther && customAnswers[qIdx]) {
								label = `Type your own answer... (${customAnswers[qIdx]})`;
							}

							let text = `${prefix}${radioColored} ${label}`;
							if (isFocused) {
								add(theme.fg("accent", text));
							} else {
								add(theme.fg("text", text));
							}

							if (opt.description) {
								add(`      ${theme.fg("muted", opt.description)}`);
							}
						}
						lines.push("");
					}

					const submitIdx = selectableItems.findIndex((it) => it.type === "submit");
					const submitFocused = cursorIndex === submitIdx;
					const allAnswered = selectedOptions.every((opt) => opt !== null);

					const submitText = "[ Submit ]";
					if (submitFocused) {
						add(theme.fg("accent", ` > ${submitText}`));
					} else {
						add(`   ${allAnswered ? theme.fg("text", submitText) : theme.fg("muted", submitText)}`);
					}

					if (editMode) {
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
					}

					lines.push("");
					if (editMode) {
						add(theme.fg("dim", " Enter to save • Esc to cancel"));
					} else {
						add(theme.fg("dim", " ↑↓ navigate • Enter/Space to select • Esc to cancel"));
						if (!allAnswered) {
							add(theme.fg("warning", " Please answer all questions before submitting"));
						}
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: {
						results: questionsToProcess.map((q) => ({
							question: q.question,
							answer: null,
							id: (q as any).id,
						})),
					} as QuestionDetails,
				};
			}

			const contentText = result
				.map((r, i) => `Q${i + 1}: ${r.question}\nA: ${r.answer}${r.wasCustom ? " (custom)" : ""}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text: contentText }],
				details: { results: result } as QuestionDetails,
			};
		},

		renderCall(args, theme) {
			const questions = "questions" in args ? args.questions : [{ question: args.question, options: args.options }];
			let text = theme.fg("toolTitle", theme.bold("question")) + "\n";

			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				text += `${theme.fg("text", `  ${i + 1}. ${q.question}`)}\n`;
				const opts = Array.isArray(q.options) ? q.options : [];
				const labels = opts.map((o: string | { label: string }) => (typeof o === "string" ? o : o.label));
				const optionsList = [...labels, "Type your own answer..."].join(", ");
				text += `${theme.fg("dim", `     Options: ${optionsList}`)}\n`;
			}
			return new Text(text.trimEnd(), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details || !details.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.results.some((r) => r.answer === null)) {
				return new Text(theme.fg("warning", "Cancelled or incomplete"), 0, 0);
			}

			let text = "";
			for (let i = 0; i < details.results.length; i++) {
				const r = details.results[i];
				const check = theme.fg("success", "✓ ");
				const questionText = theme.fg("muted", `Q${i + 1}: ${r.question}`);
				const answerText = theme.fg("accent", r.answer || "");
				const wasCustom = r.wasCustom ? theme.fg("muted", " (custom)") : "";
				text += `${check}${questionText}\n   ${answerText}${wasCustom}\n`;
			}
			return new Text(text.trimEnd(), 0, 0);
		},
	});
}
