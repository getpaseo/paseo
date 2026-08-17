import { useState } from "react";
import { openQuestionForm, type QuestionFormQuestion } from "./question-form-model";

export function useQuestionFormModel(questions: readonly QuestionFormQuestion[]) {
  const [model] = useState(() => openQuestionForm(questions));
  return model;
}
