export interface QuestionFormOption {
  value: string;
  label: string;
  description?: string;
}

export type QuestionFormQuestionKind = "single-select" | "multi-select" | "text";

export interface QuestionFormQuestion {
  key: string;
  question: string;
  header: string;
  options: readonly QuestionFormOption[];
  kind: QuestionFormQuestionKind;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

export type QuestionFormAnswer = string | string[];
export type QuestionFormAnswers = Record<string, QuestionFormAnswer>;

export interface QuestionFormState {
  questions: readonly QuestionFormQuestion[];
  activeQuestionIndex: number;
  selectedOptionValues: ReadonlyMap<string, ReadonlySet<string>>;
  textAnswers: ReadonlyMap<string, string>;
  answeredQuestionKeys: ReadonlySet<string>;
  canSubmit: boolean;
}

export interface QuestionFormModel {
  getState: () => QuestionFormState;
  subscribe: (listener: () => void) => () => void;
  toggleOption: (questionKey: string, optionValue: string) => void;
  setTextAnswer: (questionKey: string, text: string) => void;
  setActiveQuestion: (index: number) => void;
  advance: () => void;
  getAnswers: () => QuestionFormAnswers;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readMachineString(
  record: Record<string, unknown>,
  explicitKeys: readonly string[],
  legacyKey: string,
): string | null {
  for (const key of explicitKeys) {
    if (!(key in record)) {
      continue;
    }
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  const legacyValue = record[legacyKey];
  return typeof legacyValue === "string" && legacyValue.length > 0 ? legacyValue : null;
}

function resolveQuestionKind(options: readonly QuestionFormOption[], multiSelect: boolean) {
  if (options.length === 0) {
    return "text" as const;
  }
  return multiSelect ? ("multi-select" as const) : ("single-select" as const);
}

function parseQuestionFormOptions(input: unknown[]): QuestionFormOption[] | null {
  const options: QuestionFormOption[] = [];
  const optionValues = new Set<string>();
  for (const item of input) {
    if (typeof item !== "object" || item === null) return null;
    const rawOption = item as Record<string, unknown>;
    if (typeof rawOption.label !== "string") return null;

    // `value` is the reusable form contract; `label` adapts existing payloads.
    const value = readMachineString(rawOption, ["value"], "label");
    if (!value || optionValues.has(value)) return null;
    optionValues.add(value);
    options.push({
      value,
      label: rawOption.label,
      description: typeof rawOption.description === "string" ? rawOption.description : undefined,
    });
  }
  return options;
}

function parseQuestionFormQuestion(input: unknown): QuestionFormQuestion | null {
  if (typeof input !== "object" || input === null) return null;
  const rawQuestion = input as Record<string, unknown>;
  if (typeof rawQuestion.question !== "string" || typeof rawQuestion.header !== "string") {
    return null;
  }
  if (!Array.isArray(rawQuestion.options)) return null;

  // `key` is the reusable form contract. `id`, then `header`, normalize the
  // existing provider payloads at this single boundary.
  const key = readMachineString(rawQuestion, ["key", "id"], "header");
  const options = parseQuestionFormOptions(rawQuestion.options);
  if (!key || !options) return null;

  return {
    key,
    question: rawQuestion.question,
    header: rawQuestion.header,
    options,
    kind: resolveQuestionKind(options, rawQuestion.multiSelect === true),
    allowOther: rawQuestion.allowOther === true || rawQuestion.isOther === true,
    allowEmpty: rawQuestion.allowEmpty === true,
    placeholder: readOptionalString(rawQuestion, "placeholder"),
    dismissLabel: readOptionalString(rawQuestion, "dismissLabel"),
  };
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

  const rawQuestions = (input as Record<string, unknown>).questions as unknown[];
  const questions: QuestionFormQuestion[] = [];
  const questionKeys = new Set<string>();
  for (const item of rawQuestions) {
    const question = parseQuestionFormQuestion(item);
    if (!question || questionKeys.has(question.key)) return null;
    questionKeys.add(question.key);
    questions.push(question);
  }

  return questions.length > 0 ? questions : null;
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.kind === "text" || question.allowOther;
}

function isQuestionAnswered(
  question: QuestionFormQuestion,
  selectedOptionValues: QuestionFormState["selectedOptionValues"],
  textAnswers: QuestionFormState["textAnswers"],
): boolean {
  const selected = selectedOptionValues.get(question.key);
  if (selected && selected.size > 0) {
    return true;
  }

  if (!questionShowsTextInput(question)) {
    return false;
  }

  const text = textAnswers.get(question.key)?.trim();
  return Boolean(text && text.length > 0) || question.allowEmpty;
}

function buildAnswers(state: QuestionFormState): QuestionFormAnswers {
  const entries: [string, QuestionFormAnswer][] = [];
  for (const question of state.questions) {
    const text = state.textAnswers.get(question.key)?.trim();
    if (questionShowsTextInput(question) && text) {
      entries.push([question.key, question.kind === "multi-select" ? [text] : text]);
      continue;
    }

    const selected = state.selectedOptionValues.get(question.key);
    if (selected && selected.size > 0) {
      const values = question.options
        .filter((option) => selected.has(option.value))
        .map((option) => option.value);
      entries.push([question.key, question.kind === "multi-select" ? values : values[0]]);
      continue;
    }

    if (questionShowsTextInput(question) && question.allowEmpty) {
      entries.push([question.key, question.kind === "multi-select" ? [] : ""]);
    }
  }
  return Object.fromEntries(entries);
}

function deriveState(state: QuestionFormState): QuestionFormState {
  const answeredQuestionKeys = new Set(
    state.questions
      .filter((question) =>
        isQuestionAnswered(question, state.selectedOptionValues, state.textAnswers),
      )
      .map((question) => question.key),
  );
  return {
    ...state,
    answeredQuestionKeys,
    canSubmit: answeredQuestionKeys.size === state.questions.length,
  };
}

export function openQuestionForm(questions: readonly QuestionFormQuestion[]): QuestionFormModel {
  const listeners = new Set<() => void>();
  let state = deriveState({
    questions: [...questions],
    activeQuestionIndex: 0,
    selectedOptionValues: new Map(),
    textAnswers: new Map(),
    answeredQuestionKeys: new Set(),
    canSubmit: false,
  });

  function publish(nextState: QuestionFormState): void {
    state = deriveState(nextState);
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggleOption(questionKey, optionValue) {
      const question = state.questions.find((item) => item.key === questionKey);
      if (!question || question.kind === "text") return;
      if (!question.options.some((option) => option.value === optionValue)) return;

      const selected = new Set(state.selectedOptionValues.get(questionKey) ?? []);
      if (question.kind === "multi-select") {
        if (selected.has(optionValue)) {
          selected.delete(optionValue);
        } else {
          selected.add(optionValue);
        }
      } else if (selected.has(optionValue)) {
        selected.clear();
      } else {
        selected.clear();
        selected.add(optionValue);
      }

      const textAnswers = new Map(state.textAnswers);
      textAnswers.delete(questionKey);
      const selectedOptionValues = new Map(state.selectedOptionValues);
      selectedOptionValues.set(questionKey, selected);
      const questionIndex = state.questions.indexOf(question);
      const shouldAdvance =
        question.kind === "single-select" &&
        selected.size > 0 &&
        questionIndex === state.activeQuestionIndex;
      publish({
        ...state,
        selectedOptionValues,
        textAnswers,
        activeQuestionIndex: shouldAdvance
          ? Math.min(questionIndex + 1, state.questions.length - 1)
          : state.activeQuestionIndex,
      });
    },
    setTextAnswer(questionKey, text) {
      const question = state.questions.find((item) => item.key === questionKey);
      if (!question || !questionShowsTextInput(question)) return;

      const selectedOptionValues = new Map(state.selectedOptionValues);
      if (text.length > 0) {
        selectedOptionValues.set(questionKey, new Set());
      }
      const textAnswers = new Map(state.textAnswers);
      textAnswers.set(questionKey, text);
      publish({
        ...state,
        selectedOptionValues,
        textAnswers,
      });
    },
    setActiveQuestion(index) {
      if (!Number.isInteger(index) || index < 0 || index >= state.questions.length) return;
      publish({ ...state, activeQuestionIndex: index });
    },
    advance() {
      const question = state.questions[state.activeQuestionIndex];
      if (!question || !state.answeredQuestionKeys.has(question.key)) return;
      publish({
        ...state,
        activeQuestionIndex: Math.min(state.activeQuestionIndex + 1, state.questions.length - 1),
      });
    },
    getAnswers: () => buildAnswers(state),
  };
}

export function shouldSubmitEmptyOnDismiss(questions: readonly QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => question.allowEmpty && question.kind === "text")
  );
}

export function resolveDismissLabel(
  questions: readonly QuestionFormQuestion[],
  fallbackLabel = "Dismiss",
): string {
  return questions.find((question) => question.dismissLabel)?.dismissLabel ?? fallbackLabel;
}
