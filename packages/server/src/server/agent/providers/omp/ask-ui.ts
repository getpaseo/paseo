import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../../agent-sdk-types.js";
import type { OmpRuntimeEvent } from "./rpc-types.js";

type UiRequest = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;
interface UiResponse {
  value?: string;
  cancelled?: boolean;
}
type SendResponse = (id: string, response: UiResponse) => void;

const OTHER = "Other (type your own)";
const ANSWER_HEADER = "Response";

interface AskQuestion {
  title: string;
  multi: boolean;
  options: Array<{ label: string; description?: string }>;
}

interface PendingAnswer {
  question: AskQuestion;
  selected: string[];
  custom: string | null;
  next: "select" | "editor";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function questionTitle(title: string): string {
  return title.replace(/^\(\d+ selected\) /, "");
}

function matchesQuestion(title: string, question: AskQuestion): boolean {
  const plainTitle = questionTitle(title);
  if (plainTitle === question.title) return true;
  return (
    plainTitle.startsWith(question.title) &&
    /^ \(\d+\/\d+\)$/.test(plainTitle.slice(question.title.length))
  );
}

function readQuestions(args: unknown): AskQuestion[] {
  const questions = record(args)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((item) => {
    const question = record(item);
    if (typeof question?.question !== "string" || !Array.isArray(question.options)) return [];
    const options = question.options.flatMap((optionValue) => {
      const option = record(optionValue);
      if (typeof option?.label !== "string") return [];
      return [
        {
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        },
      ];
    });
    return [{ title: question.question, multi: question.multi === true, options }];
  });
}

function selectedAnswer(
  answer: string,
  labels: string[],
  multi: boolean,
): { selected: string[]; custom: string | null } {
  if (!multi)
    return labels.includes(answer)
      ? { selected: [answer], custom: null }
      : { selected: [], custom: answer };

  // The shared question UI sends a comma-joined answer in click order. Consume
  // exact option labels from the front; any remaining text is the Other answer.
  let remaining = answer;
  const selected: string[] = [];
  while (remaining.length > 0) {
    const label = labels
      .filter((candidate) => !selected.includes(candidate))
      .sort((left, right) => right.length - left.length)
      .find((candidate) => remaining === candidate || remaining.startsWith(`${candidate}, `));
    if (!label) break;
    selected.push(label);
    remaining = remaining === label ? "" : remaining.slice(label.length + 2);
  }
  return { selected, custom: remaining || null };
}

/** Owns one OMP ask tool's RPC UI sequence. OMP asks once per selected option. */
export class OmpAskUi {
  private questions: AskQuestion[] = [];
  private pending: PendingAnswer | null = null;

  start(toolName: string, args: unknown): void {
    if (toolName === "ask") {
      this.questions = readQuestions(args);
      this.pending = null;
    }
  }

  finish(toolName: string): void {
    if (toolName === "ask") {
      this.questions = [];
      this.pending = null;
    }
  }

  map(event: UiRequest, provider: AgentProvider): AgentPermissionRequest | null {
    if (event.method !== "select" || typeof event.title !== "string") return null;
    const title = event.title;
    const question = this.questions.find((item) => matchesQuestion(title, item));
    if (!question || !Array.isArray(event.options) || !event.options.includes(OTHER)) return null;

    const options = event.options.filter(
      (label) => label !== OTHER && !label.endsWith(" Done selecting"),
    );
    return {
      id: event.id,
      provider,
      name: "OMP ask",
      kind: "question",
      title: question.title,
      input: {
        questions: [
          {
            question: question.title,
            header: ANSWER_HEADER,
            options: options.map((label, index) => ({
              label,
              ...(question.options[index]?.description
                ? { description: question.options[index].description }
                : {}),
            })),
            multiSelect: question.multi,
            allowOther: true,
          },
        ],
      },
      metadata: { ompAsk: true, answerHeader: ANSWER_HEADER, optionLabels: options },
    };
  }

  respond(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
    send: SendResponse,
  ): boolean {
    if (request.metadata?.ompAsk !== true) return false;
    const question = this.questions.find((item) => item.title === request.title);
    const answers = record(
      response.behavior === "allow" ? response.updatedInput?.answers : undefined,
    );
    const answer = answers?.[ANSWER_HEADER];
    if (response.behavior === "deny" || typeof answer !== "string" || !question) {
      this.pending = null;
      send(request.id, { cancelled: true });
      return true;
    }

    const labels = Array.isArray(request.metadata.optionLabels)
      ? request.metadata.optionLabels.filter((item): item is string => typeof item === "string")
      : [];
    const { selected, custom } = selectedAnswer(answer, labels, question.multi);
    if (selected.length === 0 && custom === null) {
      this.pending = null;
      send(request.id, { cancelled: true });
      return true;
    }
    if (question.multi) {
      this.pending = { question, selected: selected.slice(1), custom, next: "select" };
      send(request.id, { value: selected[0] ?? OTHER });
      if (selected.length === 0) this.pending.next = "editor";
    } else if (custom !== null) {
      this.pending = { question, selected: [], custom, next: "editor" };
      send(request.id, { value: OTHER });
    } else {
      this.pending = null;
      send(request.id, { value: selected[0] });
    }
    return true;
  }

  consume(event: UiRequest, send: SendResponse): boolean {
    const pending = this.pending;
    if (
      !pending ||
      typeof event.title !== "string" ||
      !matchesQuestion(event.title, pending.question)
    )
      return false;
    if (pending.next === "editor" && event.method === "editor" && pending.custom !== null) {
      this.pending = null;
      send(event.id, { value: pending.custom });
      return true;
    }
    if (pending.next !== "select" || event.method !== "select" || !Array.isArray(event.options))
      return false;

    const choice = pending.selected[0];
    if (choice && event.options.includes(choice)) {
      pending.selected.shift();
      send(event.id, { value: choice });
      return true;
    }
    if (pending.custom !== null && event.options.includes(OTHER)) {
      pending.next = "editor";
      send(event.id, { value: OTHER });
      return true;
    }
    const done = event.options.find((option) => option.endsWith(" Done selecting"));
    if (!done) return false;
    this.pending = null;
    send(event.id, { value: done });
    return true;
  }
}
