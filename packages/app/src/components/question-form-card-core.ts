export interface QuestionOption {
  label: string;
  description?: string;
  /** v2 form option value (opencode-v2) — used as the submitted answer value. */
  value?: string;
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
  /**
   * opencode-v2 form fields. The v2 translation carries the field `key` (the
   * answer key), the field `type`, `custom` (free-text allowed), and the field
   * constraints from the v2 FormField1 types.
   */
  key?: string;
  type?: string;
  custom?: boolean;
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: string | number | boolean | string[];
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
    const parsed = isOpenCodeV2Question(q) ? parseOpenCodeV2Question(q) : parseLegacyQuestion(q);
    if (!parsed) return null;
    questions.push(parsed);
  }
  return questions.length > 0 ? questions : null;
}

/**
 * A v2 form question is identified by its `key` (the answer key) and `type`
 * (the v2 FormField1 type). The legacy v1 question shape has no `type` and
 keys
 * answers by `header`.
 */
function isOpenCodeV2Question(q: Record<string, unknown>): boolean {
  return typeof q.key === "string" && typeof q.type === "string";
}

function parseLegacyQuestion(q: Record<string, unknown>): QuestionFormQuestion | null {
  if (typeof q.question !== "string" || typeof q.header !== "string") return null;
  if (!Array.isArray(q.options)) return null;
  const options: QuestionOption[] = [];
  for (const opt of q.options as unknown[]) {
    if (typeof opt !== "object" || opt === null) return null;
    const o = opt as Record<string, unknown>;
    if (typeof o.label !== "string") return null;
    options.push({
      label: o.label,
      description: typeof o.description === "string" ? o.description : undefined,
    });
  }
  return {
    question: q.question,
    header: q.header,
    options,
    multiSelect: q.multiSelect === true,
    allowOther: q.allowOther === true || q.isOther === true,
    allowEmpty: q.allowEmpty === true,
    placeholder: readOptionalString(q, "placeholder"),
    dismissLabel: readOptionalString(q, "dismissLabel"),
  };
}

function parseOpenCodeV2Question(q: Record<string, unknown>): QuestionFormQuestion | null {
  const key = q.key;
  const type = q.type;
  if (typeof key !== "string" || typeof type !== "string") return null;
  const title = typeof q.title === "string" && q.title.length > 0 ? q.title : key;
  const description =
    typeof q.description === "string" && q.description.length > 0 ? q.description : title;
  const options = parseOpenCodeV2QuestionOptions(q);
  if (options === null) return null;
  const custom = q.custom === true;
  const question: QuestionFormQuestion = {
    question: description,
    header: title,
    options,
    multiSelect: type === "multiselect",
    allowOther: custom,
    // A v2 field is skippable unless it is marked required.
    allowEmpty: q.required !== true,
    key,
    type,
    custom,
  };
  copyOpenCodeV2QuestionConstraints(q, question);
  return question;
}

function parseOpenCodeV2QuestionOptions(q: Record<string, unknown>): QuestionOption[] | null {
  if (!Array.isArray(q.options)) {
    return [];
  }
  const options: QuestionOption[] = [];
  for (const opt of q.options as unknown[]) {
    if (typeof opt !== "object" || opt === null) return null;
    const o = opt as Record<string, unknown>;
    if (typeof o.label !== "string") return null;
    options.push({
      label: o.label,
      value: typeof o.value === "string" ? o.value : undefined,
      description: typeof o.description === "string" ? o.description : undefined,
    });
  }
  return options;
}

function copyOpenCodeV2QuestionConstraints(
  q: Record<string, unknown>,
  question: QuestionFormQuestion,
): void {
  if (typeof q.format === "string") question.format = q.format;
  if (typeof q.minLength === "number") question.minLength = q.minLength;
  if (typeof q.maxLength === "number") question.maxLength = q.maxLength;
  if (typeof q.pattern === "string") question.pattern = q.pattern;
  if (typeof q.minimum === "number") question.minimum = q.minimum;
  if (typeof q.maximum === "number") question.maximum = q.maximum;
  if (typeof q.minItems === "number") question.minItems = q.minItems;
  if (typeof q.maxItems === "number") question.maxItems = q.maxItems;
  if (typeof q.placeholder === "string") question.placeholder = q.placeholder;
  if (q.default !== undefined) {
    const defaultValue = q.default;
    if (
      typeof defaultValue === "string" ||
      typeof defaultValue === "number" ||
      typeof defaultValue === "boolean" ||
      Array.isArray(defaultValue)
    ) {
      question.default = defaultValue;
    }
  }
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

export type QuestionFormAnswerValue = string | number | boolean | string[];

export function buildQuestionFormAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): Record<string, QuestionFormAnswerValue> {
  const answers: Record<string, QuestionFormAnswerValue> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = selections[i];
    const otherText = otherTexts[i]?.trim();
    // v2 forms answer by the field `key` (the v2 answer key); v1 answers by `header`.
    const answerKey = q.key ?? q.header;

    if (questionShowsTextInput(q)) {
      if (otherText && otherText.length > 0) {
        const answer = typedV2FormAnswer(q, otherText);
        answers[answerKey] = answer;
        continue;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answers[answerKey] = "";
        continue;
      }
    }

    if (selected && selected.size > 0) {
      const values = Array.from(selected).map((idx) => {
        const option = q.options[idx];
        return option.value ?? option.label;
      });
      if (q.multiSelect && q.key) {
        // v2 multiselect answers are arrays of option values.
        answers[answerKey] = values;
      } else {
        answers[answerKey] = values.join(", ");
      }
    }
  }
  return answers;
}

/**
 * v2 form replies carry typed values (string/number/boolean/string[]). Coerce a
 * free-text answer to the v2 field type when the field declares one; otherwise
 * keep the raw text.
 */
function typedV2FormAnswer(question: QuestionFormQuestion, text: string): QuestionFormAnswerValue {
  if (question.key) {
    if (question.type === "number" || question.type === "integer") {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (question.type === "boolean") {
      if (/^(true|1|yes)$/i.test(text)) return true;
      if (/^(false|0|no)$/i.test(text)) return false;
    }
  }
  return text;
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
