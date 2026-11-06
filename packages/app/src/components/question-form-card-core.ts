export interface QuestionOption {
  label: string;
  /**
   * The label as the agent sent it, when folding changed it. Answers go back
   * with this text, so the card displays prose but submits the original.
   */
  rawLabel?: string;
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

/**
 * Folds soft line breaks into spaces, the way Markdown renders a wrapped
 * paragraph.
 *
 * Agents sometimes hand this card text that is hard-wrapped at some column, one
 * break per word. The app-wide markdown flags render a soft break as a hard
 * break, which stacks every token on its own line inside the option rows.
 * Form labels read as prose, so a lone break is a wrap, not a break; a blank
 * line still starts a new paragraph.
 *
 * Only prose folds. The breaks that carry Markdown structure — a blank line
 * between paragraphs, the line a list item or a heading starts on, the lines
 * inside a fenced code block — stay, because those are the document's shape
 * rather than a wrap.
 */
function normalizeQuestionText(text: string): string {
  // Fenced code blocks are content, not prose. Their lines are kept as they
  // are and only the prose around them folds.
  const fenced = /```[\s\S]*?```/g;
  const protectedBlocks: string[] = [];
  const shielded = text.replace(fenced, (block) => {
    protectedBlocks.push(block);
    return `\uE000${protectedBlocks.length - 1}\uE001`;
  });

  const folded = foldProseBreaks(shielded);

  return folded.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => {
    return protectedBlocks[Number(index)] ?? "";
  });
}

/**
 * Fold the lone breaks of a document into spaces.
 *
 * A break that ends a line of prose is a wrap. A break that starts a block —
 * a list item, a heading, a quote, a table row — is the document's shape, and
 * a blank line is a paragraph boundary.
 */
function foldProseBreaks(text: string): string {
  const lines = text.split(/\r?\n/);
  const folded: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index === 0) {
      folded.push(line);
      continue;
    }
    const previous = lines[index - 1] ?? "";
    // A blank line is a paragraph boundary and a fenced code block's own
    // lines are content; both keep their break.
    if (previous.trim() === "" || line.trim() === "" || startsBlock(line) || isFence(previous)) {
      folded.push(line);
      continue;
    }
    // The break before a block line is that line's own boundary.
    if (startsBlock(previous)) {
      folded.push(line);
      continue;
    }
    // A prose line continues the previous one, so the break becomes a space.
    folded[folded.length - 1] = `${folded[folded.length - 1] ?? ""} ${line}`;
  }
  return folded
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trimEnd();
}

/** Whether a line opens a Markdown block: a list item, a heading, a quote, a table row. */
function startsBlock(line: string): boolean {
  return /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s|\|)/.test(line);
}

/** Whether a line opens or closes a fenced code block. */
function isFence(line: string): boolean {
  return /^\s*(?:```|~~~)/.test(line);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNormalizedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = readOptionalString(record, key);
  return value === undefined ? undefined : normalizeQuestionText(value);
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
      const label = normalizeQuestionText(o.label);
      options.push({
        label,
        rawLabel: label === o.label ? undefined : o.label,
        description: readNormalizedString(o, "description"),
        preview: readOptionalString(o, "preview"),
      });
    }
    questions.push({
      question: normalizeQuestionText(q.question),
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
    const labels = selected
      ? Array.from(selected).map((idx) => q.options[idx].rawLabel ?? q.options[idx].label)
      : [];

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
