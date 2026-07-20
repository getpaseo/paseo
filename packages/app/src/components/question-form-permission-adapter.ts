import type {
  QuestionFormAnswer,
  QuestionFormAnswers,
  QuestionFormQuestion,
  QuestionFormState,
} from "./question-form-model";

function getSelectedOptionLabel(question: QuestionFormQuestion, value: string): string {
  const option = question.options.find((item) => item.value === value);
  if (option) {
    return option.label;
  }
  throw new Error(`Unknown option value ${value} for question ${question.key}`);
}

function serializeUnselectedAnswer(
  question: QuestionFormQuestion,
  answer: QuestionFormAnswer,
): string {
  if (question.kind === "multi-select") {
    if (!Array.isArray(answer)) {
      throw new Error(`Expected an array answer for multi-select question ${question.key}`);
    }
    return answer.join(", ");
  }

  if (Array.isArray(answer)) {
    throw new Error(`Expected a string answer for ${question.kind} question ${question.key}`);
  }
  return answer;
}

function shouldOmitEmptyOtherFromPermissionWire(
  question: QuestionFormQuestion,
  answer: QuestionFormAnswer,
): boolean {
  if (!question.allowEmpty || question.options.length === 0) {
    return false;
  }
  return answer.length === 0;
}

/**
 * Adapts typed form answers to the existing question permission response shape.
 * The reusable form model stays independent from provider display labels, while
 * the established permission flow continues to submit header-keyed strings.
 * Multi-select answers remain in definition order in `getAnswers()`, but this
 * legacy wire adapter emits selected labels in selection order to preserve the
 * existing question flow.
 */
export function buildQuestionPermissionAnswers(
  state: QuestionFormState,
  answers: QuestionFormAnswers,
): Record<string, string> {
  return Object.fromEntries(
    state.questions.flatMap((question) => {
      if (!Object.hasOwn(answers, question.key)) {
        return [];
      }

      const selected = state.selectedOptionValues.get(question.key);
      const typedAnswer = answers[question.key];
      if (
        (!selected || selected.size === 0) &&
        shouldOmitEmptyOtherFromPermissionWire(question, typedAnswer)
      ) {
        return [];
      }
      const answer =
        selected && selected.size > 0
          ? Array.from(selected, (value) => getSelectedOptionLabel(question, value)).join(", ")
          : serializeUnselectedAnswer(question, typedAnswer);
      return [[question.header, answer] as const];
    }),
  );
}
