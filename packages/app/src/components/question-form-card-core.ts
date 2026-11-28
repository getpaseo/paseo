import type { QuestionAnswers } from "@getpaseo/protocol/question-answers";

export interface QuestionOption {
  id?: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionFormQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

export type QuestionSelections = Record<number, ReadonlySet<number>>;
export type QuestionOtherTexts = Record<number, string>;

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function parseQuestionFormQuestions(input: unknown): QuestionFormQuestion[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as Record<string, unknown>).questions)
  ) {
    return null;
  }
  const raw = (input as Record<string, unknown>).questions as unknown[];
  const questions: QuestionFormQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.header !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options as unknown[]) {
      if (typeof opt !== "object" || opt === null) return null;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string") return null;
      options.push({
        ...(typeof o.id === "string" ? { id: o.id } : {}),
        label: o.label,
        description: typeof o.description === "string" ? o.description : undefined,
        preview: readOptionalString(o, "preview"),
      });
    }
    questions.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther === true || q.isOther === true,
      allowEmpty: q.allowEmpty === true,
      placeholder: readOptionalString(q, "placeholder"),
      dismissLabel: readOptionalString(q, "dismissLabel"),
    });
  }
  return questions.length > 0 ? questions : null;
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function isQuestionAnswered(
  question: QuestionFormQuestion,
  qIndex: number,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  const selected = selections[qIndex];
  if (selected && selected.size > 0) {
    return true;
  }

  if (!questionShowsTextInput(question)) {
    return false;
  }

  const otherText = otherTexts[qIndex]?.trim();
  if (otherText && otherText.length > 0) {
    return true;
  }

  return question.allowEmpty;
}

export function areQuestionsAnswered(
  questions: QuestionFormQuestion[] | null,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return (
    questions?.every((question, qIndex) =>
      isQuestionAnswered(question, qIndex, selections, otherTexts),
    ) ?? false
  );
}

export function buildQuestionFormAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = selections[i];
    const otherText = otherTexts[i]?.trim();
    const labels = selected ? Array.from(selected).map((idx) => q.options[idx].label) : [];

    if (questionShowsTextInput(q)) {
      if (otherText && otherText.length > 0) {
        // Multi-select keeps the checked options and appends the custom answer, the way
        // Claude Code's own AskUserQuestion UI does. Single-select replaces the option.
        answers[q.header] = q.multiSelect ? [...labels, otherText].join(", ") : otherText;
        continue;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answers[q.header] = "";
        continue;
      }
    }

    if (labels.length > 0) {
      answers[q.header] = labels.join(", ");
    }
  }
  return answers;
}

export interface QuestionFormAnswerInputOptions {
  input: Record<string, unknown> | undefined;
  questions: QuestionFormQuestion[];
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
}

export function buildQuestionFormAnswerInput({
  input,
  questions,
  selections,
  otherTexts,
}: QuestionFormAnswerInputOptions): Record<string, unknown> {
  if (input?.answerFormat !== "structured") {
    return { ...input, answers: buildQuestionFormAnswers(questions, selections, otherTexts) };
  }

  const questionAnswers: QuestionAnswers = {};
  for (const [index, question] of questions.entries()) {
    const otherText = questionShowsTextInput(question) ? otherTexts[index]?.trim() : undefined;
    const replacesSelection = !question.multiSelect && Boolean(otherText);
    const selected = replacesSelection ? [] : Array.from(selections[index] ?? []);
    const selectedOptionIds = selected.map((optionIndex) => {
      const id = question.options[optionIndex].id;
      if (!id) throw new Error("Structured question options require IDs");
      return id;
    });
    questionAnswers[question.header] = {
      selectedOptionIds,
      ...(otherText ? { otherText } : {}),
    };
  }
  return { ...input, questionAnswers };
}

export function shouldSubmitEmptyOnDismiss(questions: QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => question.allowEmpty && question.options.length === 0)
  );
}

export function resolveDismissLabel(
  questions: QuestionFormQuestion[],
  fallbackLabel = "Dismiss",
): string {
  return questions.find((question) => question.dismissLabel)?.dismissLabel ?? fallbackLabel;
}
