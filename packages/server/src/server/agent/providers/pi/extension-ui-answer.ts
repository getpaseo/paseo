import type {
  AgentMetadata,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "../../agent-sdk-types.js";

export const QUESTION_RESPONSE_HEADER = "Response";
// Caps on caller- and extension-supplied text echoed into a rejected-allow error.
export const MAX_ECHOED_LABELS = 20;
export const MAX_ECHOED_CHARS = 80;
const SAFE_CLI_HEADER_PATTERN = /^[A-Za-z0-9 _-]+$/;

export class PiPermissionResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiPermissionResponseError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function firstPermissionAnswer(input: AgentMetadata | undefined): string | null {
  const answers = isRecord(input?.answers) ? input.answers : null;
  if (!answers) {
    return null;
  }
  const first = Object.values(answers).find((value) => typeof value === "string");
  return typeof first === "string" ? first : null;
}

export function offeredQuestionLabels(request: AgentPermissionRequest): string[] {
  const questions = isRecord(request.input) ? request.input.questions : undefined;
  if (!Array.isArray(questions)) {
    return [];
  }
  const labels: string[] = [];
  for (const question of questions) {
    const options = isRecord(question) ? question.options : undefined;
    if (!Array.isArray(options)) continue;
    for (const option of options) {
      if (isRecord(option) && typeof option.label === "string") {
        labels.push(option.label);
      }
    }
  }
  return labels;
}

export interface ResolveAllowedExtensionUiAnswerOptions {
  answer?: string | null;
  labels?: readonly string[];
  answerHeader?: string;
}

function formatEchoedText(text: string): string {
  const truncated = text.length > MAX_ECHOED_CHARS;
  const shown = JSON.stringify(truncated ? text.slice(0, MAX_ECHOED_CHARS) : text);
  return truncated ? `${shown}...` : shown;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatAnswersHint(header: string): string {
  if (!SAFE_CLI_HEADER_PATTERN.test(header)) {
    return "updatedInput.answers";
  }
  const payload = JSON.stringify({ answers: { [header]: "<answer>" } });
  return `updatedInput.answers (CLI: --input ${shellSingleQuote(payload)})`;
}

// An allow must name the option it picks: `updatedInput.answers`, or `selectedActionId` equal to an
// offered label. Throwing (before the request is consumed) beats answering a human approval with a
// cancellation, which Pi extensions report to the agent as "the user denied this".
export function resolveAllowedExtensionUiAnswer(
  request: AgentPermissionRequest,
  response: Extract<AgentPermissionResponse, { behavior: "allow" }>,
  options?: ResolveAllowedExtensionUiAnswerOptions,
): string {
  const answer =
    options?.answer !== undefined ? options.answer : firstPermissionAnswer(response.updatedInput);
  if (answer !== null) {
    return answer;
  }
  const labels = options?.labels ?? offeredQuestionLabels(request);
  const selected = response.selectedActionId;
  if (selected !== undefined && labels.includes(selected)) {
    return selected;
  }
  const reason =
    selected !== undefined
      ? `selectedActionId ${formatEchoedText(selected)} is not an offered option`
      : "an allow response must name the option it picks";
  const header =
    options?.answerHeader ??
    optionalString(request.metadata?.answerHeader) ??
    QUESTION_RESPONSE_HEADER;
  const viaAnswers = formatAnswersHint(header);
  const shown = labels.slice(0, MAX_ECHOED_LABELS).map(formatEchoedText);
  const more = labels.length > shown.length ? ` and ${labels.length - shown.length} more` : "";
  const hint =
    labels.length > 0
      ? `set selectedActionId to one of: ${shown.join(", ")}${more}, or pass ${viaAnswers}`
      : `pass ${viaAnswers}`;
  throw new PiPermissionResponseError(`Pi permission request '${request.id}': ${reason}; ${hint}`);
}
