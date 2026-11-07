import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { QuestionAnswersSchema } from "@getpaseo/protocol/question-answers";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
  AgentStreamEvent,
} from "../agent-sdk-types.js";

// Grok's ACP extension uses question text as the answer key.
const Question = z.object({
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().optional(),
        preview: z.string().nullish(),
      }),
    )
    .default([]),
  multiSelect: z.boolean().nullish(),
});
const Request = z.object({
  sessionId: z.string(),
  toolCallId: z.string().min(1),
  questions: z
    .array(Question)
    .min(1)
    .refine((rows) => new Set(rows.map((q) => q.question)).size === rows.length),
});
type Questions = z.infer<typeof Request>["questions"];
interface PendingQuestion {
  request: AgentPermissionRequest;
  questions: Questions;
  turnId: string | null;
  resolve(value: Record<string, unknown>): void;
}

function resolveSelectedOptions(question: Questions[number], ids: string[]) {
  const validSelection =
    (question.multiSelect || ids.length <= 1) && new Set(ids).size === ids.length;
  if (!validSelection) throw new Error(`Select valid options for '${question.question}'`);
  return ids.map((optionId) => {
    const option = question.options.find((_, index) => String(index) === optionId);
    if (!option) throw new Error(`Select valid options for '${question.question}'`);
    return option;
  });
}

/** Bridge the native x.ai question request to the host's existing question permissions. */
export class GrokQuestions {
  private readonly requests = new Map<string, PendingQuestion>();

  constructor(
    private readonly provider: AgentProvider,
    private readonly emit: (event: AgentStreamEvent) => void,
  ) {}

  request(
    params: Record<string, unknown>,
    sessionId: string | null,
    turnId: string | null,
  ): Promise<Record<string, unknown>> {
    const parsed = Request.safeParse(params);
    if (!parsed.success || !sessionId || parsed.data.sessionId !== sessionId) {
      throw RequestError.invalidParams();
    }
    const questions = parsed.data.questions;
    const request: AgentPermissionRequest = {
      id: randomUUID(),
      provider: this.provider,
      name: "ask_user_question",
      kind: "question",
      title: questions[0]!.question,
      input: {
        answerFormat: "structured",
        questions: questions.map((q, i) => ({
          question: q.question,
          header: `Question ${i + 1}`,
          // Grok has no option IDs; immutable request positions distinguish repeated labels.
          options: q.options.map((option, index) => ({ ...option, id: String(index) })),
          multiSelect: q.multiSelect === true,
          allowOther: true,
        })),
      },
      metadata: { toolCallId: parsed.data.toolCallId },
    };
    return new Promise((resolve) => {
      this.requests.set(request.id, { request, questions, resolve, turnId });
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
    let result: Record<string, unknown> = { outcome: "cancelled" };
    if (response.behavior === "allow") {
      const parsed = QuestionAnswersSchema.safeParse(response.updatedInput?.questionAnswers);
      if (!parsed.success) throw new Error("Update the app to submit structured question answers");
      const input = parsed.data;
      const answers: Record<string, string[]> = {};
      const annotations: Record<string, { notes?: string; preview?: string }> = {};
      for (const [index, question] of pending.questions.entries()) {
        const answer = input[`Question ${index + 1}`];
        if (!answer) throw new Error(`Answer Question ${index + 1} before submitting`);
        const selectedOptions = resolveSelectedOptions(question, answer.selectedOptionIds);
        const notes = answer.otherText?.trim();
        if (!selectedOptions.length && !notes)
          throw new Error(`Answer Question ${index + 1} before submitting`);
        answers[question.question] = selectedOptions.length
          ? selectedOptions.map((option) => option.label)
          : ["Other"];
        const preview =
          !question.multiSelect && selectedOptions.length === 1
            ? selectedOptions[0]!.preview
            : undefined;
        if (notes || preview)
          annotations[question.question] = {
            ...(notes ? { notes } : {}),
            ...(preview ? { preview } : {}),
          };
      }
      result = {
        outcome: "accepted",
        answers,
        ...(Object.keys(annotations).length ? { annotations } : {}),
      };
    }
    this.requests.delete(id);
    pending.resolve(result);
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId: id,
      resolution: response,
      turnId: pending.turnId ?? undefined,
    });
  }

  cancel(): void {
    for (const request of this.requests.values()) request.resolve({ outcome: "cancelled" });
    this.requests.clear();
  }
}
