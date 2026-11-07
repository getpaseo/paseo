import { z } from "zod";
import type { AgentPermissionRequest } from "../../../../agent-sdk-types.js";
import type { PiExtension, PiExtensionDialog, PiExtensionUiResponse } from "../contract.js";

const Params = z
  .object({
    questions: z
      .array(
        z.object({
          question: z.string(),
          header: z.string(),
          options: z
            .array(
              z.object({
                label: z.string(),
                description: z.string(),
                preview: z.string().optional(),
              }),
            )
            .min(2)
            .max(4),
          multiSelect: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(4),
  })
  .refine(({ questions }) => {
    const texts = questions.map((question) => question.question);
    return (
      new Set(texts).size === texts.length &&
      questions.every((question) => {
        const labels = question.options.map((option) => option.label);
        return (
          new Set(labels).size === labels.length &&
          labels.every(
            (label) => label !== "Other" && label !== "Type something." && label !== "Next",
          )
        );
      })
    );
  });
const Result = z.object({
  answers: z.array(
    z.object({
      question: z.string(),
      kind: z.enum(["option", "custom", "multi"]),
      answer: z.string().nullable(),
      selected: z.array(z.string()).optional(),
    }),
  ),
  cancelled: z.boolean(),
  error: z.string().optional(),
});
type Question = z.infer<typeof Params>["questions"][number];
const PERMISSION_PREFIX = "rpiv-question:";

function answerFor(answers: Record<string, unknown>, question: Question): string | null {
  const answer = answers[question.header];
  return typeof answer === "string" ? answer : null;
}

function replyToDialog(
  dialog: PiExtensionDialog,
  question: Question,
  answer: string,
  customInput: boolean,
): { response: PiExtensionUiResponse; customInput: boolean } {
  const options = z.array(z.string()).safeParse(dialog.options).data;
  if (customInput) return { response: { value: answer }, customInput: false };
  if (question.multiSelect) {
    const labels = answer.split(", ");
    const indices = labels.map((label) =>
      question.options.findIndex((option) => option.label === label),
    );
    if (indices.every((index) => index >= 0)) {
      return {
        response: { value: indices.map((index) => index + 1).join(",") },
        customInput: false,
      };
    }
    return { response: { value: answer }, customInput: false };
  }
  const index = question.options.findIndex((option) => option.label === answer);
  if (index >= 0) {
    return {
      response: {
        value:
          options?.[index] ?? `${index + 1}. ${answer} — ${question.options[index].description}`,
      },
      customInput: false,
    };
  }
  return {
    response: {
      value:
        options?.[question.options.length] ?? `${question.options.length + 1}. Type something.`,
    },
    customInput: true,
  };
}

export const rpivAskUserQuestion: PiExtension = {
  id: "rpiv-ask-user-question",
  createSession() {
    let active: {
      callId: string;
      questions: Question[];
      answers: Record<string, unknown> | null;
      cancelled: boolean;
      index: number;
      customInput: boolean;
      deferred: PiExtensionDialog | null;
    } | null = null;

    function answerDialog(dialog: PiExtensionDialog): PiExtensionUiResponse {
      if (!active || active.cancelled) return { cancelled: true };
      const question = active.questions[active.index];
      if (!question || !active.answers) return { cancelled: true };
      const answer = answerFor(active.answers, question);
      if (answer === null) return { cancelled: true };
      const mapped = replyToDialog(dialog, question, answer, active.customInput);
      active.customInput = mapped.customInput;
      if (!active.customInput) active.index++;
      return mapped.response;
    }

    return {
      onToolStart(call, provider): AgentPermissionRequest | undefined {
        if (call.toolName !== "ask_user_question") return undefined;
        const parsed = Params.safeParse(call.args);
        if (!parsed.success) return undefined;
        active = {
          callId: call.callId,
          questions: parsed.data.questions,
          answers: null,
          cancelled: false,
          index: 0,
          customInput: false,
          deferred: null,
        };
        return {
          id: `${PERMISSION_PREFIX}${call.callId}`,
          provider,
          name: "Pi ask_user_question",
          kind: "question",
          title: parsed.data.questions[0].question,
          input: {
            questions: parsed.data.questions.map((question) => ({
              question: question.question,
              header: question.header,
              options: question.options,
              multiSelect: question.multiSelect ?? false,
              allowOther: true,
            })),
          },
        };
      },
      onToolEnd(call) {
        if (active?.callId === call.callId) active = null;
      },
      mapDialog(dialog) {
        if (!active || (dialog.method !== "select" && dialog.method !== "input")) return undefined;
        if (!active.answers && !active.cancelled) {
          active.deferred = dialog;
          return { type: "deferred" };
        }
        return { type: "response", response: answerDialog(dialog) };
      },
      respondToPermission(request, response) {
        if (!active || request.id !== `${PERMISSION_PREFIX}${active.callId}`) return undefined;
        const answers = response.behavior === "allow" ? response.updatedInput?.answers : undefined;
        active.answers =
          answers && typeof answers === "object" && !Array.isArray(answers)
            ? (answers as Record<string, unknown>)
            : null;
        active.cancelled = response.behavior === "deny" || !active.answers;
        const deferred = active.deferred;
        active.deferred = null;
        return {
          responses: deferred ? [{ id: deferred.id, response: answerDialog(deferred) }] : [],
        };
      },
      mapToolCall(call) {
        if (
          call.toolName !== "ask_user_question" ||
          !call.result ||
          typeof call.result === "string"
        )
          return undefined;
        const result = Result.safeParse(call.result.details);
        if (!result.success) return undefined;
        return {
          detail: {
            type: "plain_text",
            label: "Questions",
            text:
              result.data.error ??
              (result.data.cancelled
                ? "Cancelled"
                : result.data.answers
                    .map(
                      (answer) =>
                        `${answer.question}: ${answer.kind === "multi" ? (answer.selected ?? []).join(", ") : (answer.answer ?? "")}`,
                    )
                    .join("\n")),
          },
        };
      },
    };
  },
};
