import { RequestError } from "@agentclientprotocol/sdk";

export const GROK_ASK_USER_QUESTION_METHODS = [
  "_x.ai/ask_user_question",
  "x.ai/ask_user_question",
  "ask_user_question",
] as const;

export type GrokAskUserQuestionMethod = (typeof GROK_ASK_USER_QUESTION_METHODS)[number];

export interface GrokAskUserQuestionOption {
  label: string;
  description?: string;
}

export interface GrokAskUserQuestionPrompt {
  question: string;
  header: string;
  options: GrokAskUserQuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

export type GrokAskUserQuestionResult =
  | { outcome: "accepted"; answers: Record<string, string>; annotations: Record<string, unknown> }
  | { outcome: "cancelled" };

export function isGrokAskUserQuestionMethod(method: string): method is GrokAskUserQuestionMethod {
  return (GROK_ASK_USER_QUESTION_METHODS as readonly string[]).includes(method);
}

export function parseGrokAskUserQuestionParams(params: Record<string, unknown>): {
  sessionId?: string;
  toolCallId?: string;
  questions: GrokAskUserQuestionPrompt[];
} {
  const rawQuestions = params.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw RequestError.invalidParams({ reason: "questions must be a non-empty array" });
  }

  const questions = rawQuestions.map((item, index) => parseQuestion(item, index));
  return {
    sessionId: readOptionalString(params.sessionId),
    toolCallId: readOptionalString(params.toolCallId),
    questions,
  };
}

export function buildGrokAskUserQuestionAnswers(
  questions: GrokAskUserQuestionPrompt[],
  rawAnswers: unknown,
): Record<string, string> {
  const answersRecord = isRecord(rawAnswers) ? rawAnswers : {};
  const answers: Record<string, string> = {};

  for (const question of questions) {
    const raw =
      readOptionalString(answersRecord[question.header]) ??
      readOptionalString(answersRecord[question.question]);
    if (!raw) {
      continue;
    }
    answers[question.question] = raw;
  }

  return answers;
}

export function formatGrokAskUserQuestionTitle(questions: GrokAskUserQuestionPrompt[]): string {
  if (questions.length === 1) {
    return questions[0]?.question ?? "Question";
  }
  return `Ask ${questions.length} questions`;
}

export function formatGrokAskUserQuestionDetail(questions: GrokAskUserQuestionPrompt[]): string {
  return questions
    .map((question) => {
      const labels = question.options.map((option) => option.label).filter(Boolean);
      return labels.length > 0
        ? `${question.question} - ${labels.join(" / ")}`
        : question.question;
    })
    .join("\n");
}

function parseQuestion(item: unknown, index: number): GrokAskUserQuestionPrompt {
  if (!isRecord(item)) {
    throw RequestError.invalidParams({ reason: `questions[${index}] must be an object` });
  }
  const question = readOptionalString(item.question);
  if (!question) {
    throw RequestError.invalidParams({ reason: `questions[${index}].question is required` });
  }

  const options = Array.isArray(item.options)
    ? item.options
        .map((option) => parseOption(option))
        .filter((option): option is GrokAskUserQuestionOption => option !== null)
    : [];

  return {
    question,
    header: readOptionalString(item.header) ?? question,
    options,
    multiSelect: item.multiSelect === true || item.multi_select === true,
    allowOther: true,
  };
}

function parseOption(item: unknown): GrokAskUserQuestionOption | null {
  if (typeof item === "string") {
    const label = item.trim();
    return label ? { label } : null;
  }
  if (!isRecord(item)) {
    return null;
  }
  const label =
    readOptionalString(item.label) ??
    readOptionalString(item.title) ??
    readOptionalString(item.name) ??
    readOptionalString(item.text);
  if (!label) {
    return null;
  }
  const description = readOptionalString(item.description);
  return description ? { label, description } : { label };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
