import { z } from "zod";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentQuestionAnswer,
} from "./agent-sdk-types.js";

// Every provider publishes `question` requests in the shape the app's question form reads.
const QuestionsSchema = z.array(
  z
    .object({
      header: z.string(),
      options: z.array(z.object({ label: z.string() }).passthrough()).optional(),
      multiSelect: z.boolean().optional(),
    })
    .passthrough(),
);
type Question = z.infer<typeof QuestionsSchema>[number];

const TextAnswersSchema = z.record(z.string(), z.unknown());

// Text answers join a multi-select's labels and typed answer with this separator.
const TEXT_SEPARATOR = ", ";

/**
 * Gives an answered `question` request both answer forms before it reaches the provider:
 * `questionAnswers`, one structured answer per question, and `updatedInput.answers`, the
 * header-keyed text that Claude's AskUserQuestion and plugin providers read. Clients that
 * send only text (the CLI, MCP, and apps before structured answers) are parsed by option label.
 */
export function resolveQuestionAnswers(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): AgentPermissionResponse {
  if (request.kind !== "question" || response.behavior !== "allow") return response;
  const parsed = QuestionsSchema.safeParse(request.input?.questions);
  if (!parsed.success) return response;
  const questions = parsed.data;

  if (response.questionAnswers && response.questionAnswers.length !== questions.length) {
    throw new Error(
      `Question answers must answer all ${questions.length} questions; received ${response.questionAnswers.length}`,
    );
  }
  const textAnswers = TextAnswersSchema.safeParse(response.updatedInput?.answers).data;
  const questionAnswers =
    response.questionAnswers ??
    (textAnswers ? questions.map((question) => parseTextAnswer(question, textAnswers)) : null);
  if (!questionAnswers) return response;

  return {
    ...response,
    questionAnswers,
    updatedInput: {
      ...response.updatedInput,
      answers: textAnswers ?? formatTextAnswers(questions, questionAnswers),
    },
  };
}

/** The chosen option labels followed by the typed answer, if there is one. */
export function questionAnswerValues(answer: AgentQuestionAnswer | undefined): string[] {
  if (!answer) return [];
  const text = answer.text?.trim();
  return text ? [...answer.selected, text] : answer.selected;
}

function parseTextAnswer(
  question: Question,
  textAnswers: Record<string, unknown>,
): AgentQuestionAnswer {
  const raw = textAnswers[question.header];
  if (Array.isArray(raw)) return { selected: raw.filter((item) => typeof item === "string") };
  if (typeof raw === "number" || typeof raw === "boolean") {
    return { selected: [], text: String(raw) };
  }
  if (typeof raw !== "string") return { selected: [] };
  const text = raw.trim();
  const labels = new Set(question.options?.map((option) => option.label));
  if (!question.multiSelect) {
    return labels.has(text) ? { selected: [text] } : { selected: [], text };
  }

  // Labels can contain the separator, so match the longest run of segments that is a label.
  const segments = text.split(TEXT_SEPARATOR);
  const selected: string[] = [];
  const typed: string[] = [];
  let start = 0;
  while (start < segments.length) {
    let end = segments.length;
    while (end > start && !labels.has(segments.slice(start, end).join(TEXT_SEPARATOR))) end--;
    if (end > start) {
      selected.push(segments.slice(start, end).join(TEXT_SEPARATOR));
      start = end;
    } else {
      typed.push(segments[start]);
      start++;
    }
  }
  return typed.length > 0 ? { selected, text: typed.join(TEXT_SEPARATOR) } : { selected };
}

function formatTextAnswers(
  questions: Question[],
  questionAnswers: AgentQuestionAnswer[],
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const answer = questionAnswers[index];
    if (answer.selected.length === 0 && answer.text === undefined) return;
    answers[question.header] = questionAnswerValues(answer).join(TEXT_SEPARATOR);
  });
  return answers;
}
