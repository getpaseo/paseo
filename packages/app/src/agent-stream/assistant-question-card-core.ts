import type { AssistantQuestion } from "@/timeline/assistant-questions";
import {
  areQuestionsAnswered,
  isQuestionAnswered,
  type QuestionFormQuestion,
  type QuestionOtherTexts,
  type QuestionSelections,
} from "@/components/question-form-card-core";

/**
 * Adapt an async question to the shape the blocking question form's helpers understand.
 * A free-text answer is always allowed, and an answer is always required.
 */
export function toQuestionFormQuestion(question: AssistantQuestion): QuestionFormQuestion {
  return {
    question: question.title,
    header: question.title,
    options: (question.options ?? []).map((label) => ({ label })),
    multiSelect: false,
    allowOther: true,
    allowEmpty: false,
  };
}

/** The first option is the recommended answer, so it starts selected. */
export function initialAssistantQuestionSelections(
  questions: AssistantQuestion[],
): QuestionSelections {
  const selections: QuestionSelections = {};
  questions.forEach((question, index) => {
    if (question.options?.length) {
      selections[index] = new Set([0]);
    }
  });
  return selections;
}

export function isAssistantQuestionAnswerable(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return areQuestionsAnswered(questions, selections, otherTexts);
}

/** One answer per question, in question order; null when any question is unanswered. */
export function resolveAssistantQuestionAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): string[] | null {
  const answers: string[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    if (!isQuestionAnswered(question, index, selections, otherTexts)) {
      return null;
    }
    const otherText = otherTexts[index]?.trim();
    if (otherText) {
      answers.push(otherText);
      continue;
    }
    const selected = selections[index];
    const optionIndex = selected ? Array.from(selected)[0] : undefined;
    const label = optionIndex === undefined ? undefined : question.options[optionIndex]?.label;
    if (!label) {
      return null;
    }
    answers.push(label);
  }
  return answers;
}

/**
 * A lone question sends the bare answer; several send one labelled line each so the agent can
 * tell them apart in the reply.
 */
export function formatAssistantQuestionMessage(
  questions: QuestionFormQuestion[],
  answers: string[],
): string {
  if (questions.length === 1) {
    return answers[0] ?? "";
  }
  return questions
    .map((question, index) => `${question.header}: ${answers[index] ?? ""}`)
    .join("\n");
}
