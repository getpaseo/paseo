import { z } from "zod";
import type { AgentPermissionRequest } from "../../../../agent-sdk-types.js";
import type { PiExtension, PiExtensionDialog, PiExtensionUiResponse } from "../contract.js";

// Caps mirrored from pi's own ask_user_question schema
// (@juicesharp/rpiv-ask-user-question tool/types.ts: MAX_HEADER_LENGTH 16,
// MAX_LABEL_LENGTH 60). pi rejects an over-limit call before the tool runs, so a
// looser schema here renders a form for a questionnaire that no tool will ever
// answer: the user sees a second, identical card with nothing behind it, and any
// interaction with it lands on the live questionnaire instead.
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;

const Params = z
  .object({
    questions: z
      .array(
        z.object({
          question: z.string(),
          header: z.string().max(MAX_HEADER_LENGTH),
          options: z
            .array(
              z.object({
                label: z.string().max(MAX_LABEL_LENGTH),
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

interface QuestionForm {
  callId: string;
  questions: Question[];
  answers: Record<string, unknown> | null;
  cancelled: boolean;
  index: number;
  customInput: boolean;
  deferred: PiExtensionDialog | null;
}

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
    // One entry per live ask_user_question tool call. A single slot shared by
    // every call lets a second questionnaire overwrite the first, and lets a
    // stale form's dismissal cancel a questionnaire it never belonged to.
    const forms: QuestionForm[] = [];

    function dialogTitle(dialog: PiExtensionDialog): string {
      return typeof dialog.title === "string" ? dialog.title : "";
    }

    // The provider dialog titles are `[Header] question…`, so a dialog can be
    // attributed to the form whose current question it asks. When titles cannot
    // decide (older provider format), the form still waiting for its form wins.
    function formForDialog(dialog: PiExtensionDialog): QuestionForm | undefined {
      const title = dialogTitle(dialog);
      const asked = forms.find((form) => {
        const question = form.questions[form.index];
        return (
          !!question &&
          (title.startsWith(`[${question.header}] `) || title.startsWith(question.question))
        );
      });
      if (asked) return asked;
      const waiting = forms.find((form) => !form.answers && !form.cancelled);
      return waiting ?? forms.find((form) => form.cancelled);
    }

    function formCard(form: QuestionForm, provider: string): AgentPermissionRequest {
      return {
        id: `${PERMISSION_PREFIX}${form.callId}`,
        provider,
        name: "Pi ask_user_question",
        kind: "question",
        title: form.questions[0].question,
        input: {
          questions: form.questions.map((question) => ({
            question: question.question,
            header: question.header,
            options: question.options,
            multiSelect: question.multiSelect ?? false,
            allowOther: true,
          })),
        },
      };
    }

    function answerDialog(form: QuestionForm, dialog: PiExtensionDialog): PiExtensionUiResponse {
      if (form.cancelled) return { cancelled: true };
      const question = form.questions[form.index];
      if (!question || !form.answers) return { cancelled: true };
      const answer = answerFor(form.answers, question);
      if (answer === null) return { cancelled: true };
      const mapped = replyToDialog(dialog, question, answer, form.customInput);
      form.customInput = mapped.customInput;
      if (!form.customInput) form.index++;
      return mapped.response;
    }

    return {
      onToolStart(call) {
        if (call.toolName !== "ask_user_question") return undefined;
        const parsed = Params.safeParse(call.args);
        if (!parsed.success) return undefined;
        const existing = forms.findIndex((form) => form.callId === call.callId);
        if (existing >= 0) forms.splice(existing, 1); // replayed tool start
        forms.push({
          callId: call.callId,
          questions: parsed.data.questions,
          answers: null,
          cancelled: false,
          index: 0,
          customInput: false,
          deferred: null,
        });
        // The card appears when the tool actually asks (its first dialog), not
        // at tool start: a call pi rejects, interrupts, or finishes without
        // ever asking then leaves no unanswered card behind.
        return undefined;
      },
      onToolEnd(call) {
        const index = forms.findIndex((form) => form.callId === call.callId);
        if (index >= 0) forms.splice(index, 1);
      },
      mapDialog(dialog, provider) {
        if (dialog.method !== "select" && dialog.method !== "input") return undefined;
        const form = formForDialog(dialog);
        if (!form) return undefined;
        if (form.cancelled) return { type: "response", response: { cancelled: true } };
        if (!form.answers) {
          form.deferred = dialog;
          return { type: "permission", request: formCard(form, provider) };
        }
        return { type: "response", response: answerDialog(form, dialog) };
      },
      respondToPermission(request, response) {
        if (!request.id.startsWith(PERMISSION_PREFIX)) return undefined;
        const callId = request.id.slice(PERMISSION_PREFIX.length);
        const form = forms.find((candidate) => candidate.callId === callId);
        if (!form) return { responses: [] }; // its tool already ended: nothing to corrupt
        const answers = response.behavior === "allow" ? response.updatedInput?.answers : undefined;
        form.answers =
          answers && typeof answers === "object" && !Array.isArray(answers)
            ? (answers as Record<string, unknown>)
            : null;
        form.cancelled = response.behavior === "deny" || !form.answers;
        const deferred = form.deferred;
        form.deferred = null;
        return {
          responses: deferred ? [{ id: deferred.id, response: answerDialog(form, deferred) }] : [],
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
