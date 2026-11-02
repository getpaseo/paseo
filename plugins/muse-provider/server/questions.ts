import type { ProviderEvent, ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";
import type { z } from "zod";
import { MspConnection } from "./connection.js";
import { MuseError } from "./errors.js";
import { ackSchema, questionSchema, questionAnswersSchema, settledQuestionSchema } from "./wire.js";

export class Questions {
  private readonly pending = new Map<string, z.infer<typeof questionSchema>>();
  private readonly settled = new Set<string>();
  constructor(
    private readonly host: MspConnection,
    private readonly sessionId: string,
    private readonly id: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  requested(input: unknown): void {
    const request = questionSchema.parse(input);
    if (this.settled.has(request.userInputId)) return;
    this.pending.set(request.userInputId, request);
    this.emit({
      type: "session.permission",
      sessionId: this.id,
      request: {
        id: request.userInputId,
        name: request.toolName,
        kind: "question",
        input: {
          questions: request.questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options,
            multiSelect: question.selection.mode === "multiple",
            allowOther: true,
            allowEmpty: question.selection.minSelections === 0,
          })),
        },
      },
    });
  }
  resolved(input: unknown): void {
    const { userInputId } = settledQuestionSchema.parse(input);
    this.settled.add(userInputId);
    this.pending.delete(userInputId);
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.id,
      permissionId: userInputId,
    });
  }
  async answer(id: string, response: ProviderPermissionResponse): Promise<boolean> {
    const request = this.pending.get(id);
    if (!request) return false;
    if (response.behavior === "deny") {
      await this.host.command(
        "userInput/cancel",
        { sessionId: this.sessionId, userInputId: id, reason: response.message },
        ackSchema,
      );
      return true;
    }
    const supplied = questionAnswersSchema.parse(response.updatedInput);
    const answers = request.questions.map((question) => {
      const text = supplied.answers[question.header];
      if (text === undefined) throw new MuseError("missingAnswer", `Answer ${question.header}`);
      if (question.selection.mode === "single")
        return question.options.some((option) => option.label === text)
          ? { questionId: question.id, selectedLabel: text }
          : { questionId: question.id, freeText: text };
      const labels = text
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
      if (labels.every((label) => question.options.some((option) => option.label === label)))
        return { questionId: question.id, selectedLabels: labels };
      return { questionId: question.id, freeText: text };
    });
    await this.host.command(
      "userInput/answer",
      { sessionId: this.sessionId, userInputId: id, answers },
      ackSchema,
    );
    return true;
  }
}
