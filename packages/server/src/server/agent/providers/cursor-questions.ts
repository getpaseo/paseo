import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { QuestionAnswersSchema, type QuestionAnswers } from "@getpaseo/protocol/question-answers";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
  AgentStreamEvent,
} from "../agent-sdk-types.js";

const Question = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  allowMultiple: z.boolean().optional(),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1),
});
const Request = z.object({
  toolCallId: z.string().min(1),
  title: z.string().optional(),
  questions: z.array(Question).min(1),
});
interface PendingQuestion {
  request: AgentPermissionRequest;
  questions: z.infer<typeof Request>["questions"];
  turnId: string | null;
  resolve(value: Record<string, unknown>): void;
}

function selectedIds(
  answer: QuestionAnswers[string] | undefined,
  question: z.infer<typeof Question>,
): string[] {
  if (!answer) throw new Error(`Select an option for '${question.prompt}'`);
  const ids = answer.selectedOptionIds;
  const validSelection =
    ids.length > 0 &&
    (question.allowMultiple || ids.length === 1) &&
    new Set(ids).size === ids.length &&
    ids.every((id) => question.options.some((option) => option.id === id));
  if (!validSelection || answer.otherText !== undefined) {
    throw new Error(`Select an option for '${question.prompt}'`);
  }
  return ids;
}

/** Cursor's native protocol returns option IDs and does not define free-text answers. */
export class CursorQuestions {
  private readonly requests = new Map<string, PendingQuestion>();

  constructor(
    private readonly provider: AgentProvider,
    private readonly emit: (event: AgentStreamEvent) => void,
  ) {}

  request(
    params: Record<string, unknown>,
    turnId: string | null,
  ): Promise<Record<string, unknown>> {
    const parsed = Request.safeParse(params);
    if (!parsed.success) throw RequestError.invalidParams();
    const { questions } = parsed.data;
    const request: AgentPermissionRequest = {
      id: randomUUID(),
      provider: this.provider,
      name: "AskQuestion",
      kind: "question",
      title: parsed.data.title ?? questions[0]!.prompt,
      input: {
        answerFormat: "structured",
        questions: questions.map((q, i) => ({
          id: q.id,
          question: q.prompt,
          header: `Question ${i + 1}`,
          options: q.options,
          multiSelect: q.allowMultiple === true,
          allowOther: false,
        })),
      },
      metadata: { toolCallId: parsed.data.toolCallId },
    };
    return new Promise((resolve) => {
      this.requests.set(request.id, { request, questions, turnId, resolve });
      this.emit({
        type: "permission_requested",
        provider: this.provider,
        request,
        turnId: turnId ?? undefined,
      });
    });
  }

  pending(): AgentPermissionRequest[] {
    return [...this.requests.values()].map(({ request }) => request);
  }
  has(id: string): boolean {
    return this.requests.has(id);
  }

  respond(id: string, response: AgentPermissionResponse): void {
    const pending = this.requests.get(id);
    if (!pending) throw new Error(`No pending question with id '${id}'`);
    let outcome: Record<string, unknown> = { outcome: "cancelled" };
    if (response.behavior === "allow") {
      const parsed = QuestionAnswersSchema.safeParse(response.updatedInput?.questionAnswers);
      if (!parsed.success) throw new Error("Update the app to submit structured question answers");
      const input = parsed.data;
      outcome = {
        outcome: "answered",
        answers: pending.questions.map((question, i) => ({
          questionId: question.id,
          selectedOptionIds: selectedIds(input[`Question ${i + 1}`], question),
        })),
      };
    }
    this.requests.delete(id);
    pending.resolve({ outcome });
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId: id,
      resolution: response,
      turnId: pending.turnId ?? undefined,
    });
  }

  cancel(): void {
    for (const request of this.requests.values())
      request.resolve({ outcome: { outcome: "cancelled" } });
    this.requests.clear();
  }
}
