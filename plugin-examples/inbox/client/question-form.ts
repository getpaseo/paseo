/**
 * Mirrors the question shape Paseo's timeline question form reads from an
 * AskUserQuestion-style permission request. Answers are keyed by question
 * header; the Claude provider remaps header keys to the full question text.
 */
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

export function parseQuestions(input: unknown): Question[] | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string") return null;
    const options: QuestionOption[] = [];
    if (Array.isArray(record.options)) {
      for (const option of record.options) {
        if (typeof option === "string") {
          options.push({ label: option });
          continue;
        }
        if (typeof option !== "object" || option === null) return null;
        const optionRecord = option as Record<string, unknown>;
        if (typeof optionRecord.label !== "string") return null;
        options.push({
          label: optionRecord.label,
          description:
            typeof optionRecord.description === "string" ? optionRecord.description : undefined,
        });
      }
    }
    questions.push({
      question: record.question,
      header: typeof record.header === "string" && record.header ? record.header : record.question,
      options,
      multiSelect: record.multiSelect === true,
      allowOther: record.allowOther === true || record.isOther === true || options.length === 0,
    });
  }
  return questions;
}

export type Selections = ReadonlyMap<number, ReadonlySet<number>>;
export type OtherTexts = ReadonlyMap<number, string>;

export function isAnswered(
  question: Question,
  selected: ReadonlySet<number> | undefined,
  other: string | undefined,
): boolean {
  if (selected && selected.size > 0) return true;
  return question.allowOther && (other?.trim().length ?? 0) > 0;
}

export function buildAnswers(
  questions: readonly Question[],
  selections: Selections,
  others: OtherTexts,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const other = others.get(index)?.trim();
    if (question.allowOther && other) {
      answers[question.header] = other;
      return;
    }
    const selected = selections.get(index);
    if (selected && selected.size > 0) {
      answers[question.header] = Array.from(selected)
        .sort((a, b) => a - b)
        .map((optionIndex) => question.options[optionIndex]?.label ?? "")
        .filter((label) => label.length > 0)
        .join(", ");
    }
  });
  return answers;
}
