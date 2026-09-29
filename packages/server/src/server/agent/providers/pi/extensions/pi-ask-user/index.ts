import { z } from "zod";
import type {
  AgentMetadata,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "../../../../agent-sdk-types.js";
import type { PiExtension, PiExtensionDialog, PiExtensionUiReply } from "../contract.js";

const QUESTION_RESPONSE_HEADER = "Response";
const QUESTION_COMMENT_HEADER = "Comment";
const FREEFORM_SENTINEL = "✏️ Type custom response...";
const COMBINED_METADATA = "ask_user_select_optional_comment";
const Args = z
  .object({
    allowComment: z.boolean().catch(false),
    allowFreeform: z.boolean().catch(true),
    allowMultiple: z.boolean().catch(false),
  })
  .passthrough();
const Select = z
  .object({ title: z.string().optional(), options: z.array(z.string()).optional() })
  .passthrough();
const Input = z.object({ placeholder: z.string().optional() }).passthrough();

function answer(input: AgentMetadata | undefined, header: string): string | null {
  const answers = input?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const value = Reflect.get(answers, header);
  return typeof value === "string" ? value : null;
}

function optionalInput(placeholder: string | undefined): boolean {
  return /\boptional\b|\bskip\b/i.test(placeholder ?? "");
}

function combinedPermission(
  dialog: PiExtensionDialog,
  provider: string,
  options: string[],
  allowFreeform: boolean,
  question: string,
): AgentPermissionRequest {
  const visibleOptions = options.filter((option) => option !== FREEFORM_SENTINEL);
  const allowOther = allowFreeform || visibleOptions.length !== options.length;
  return {
    id: dialog.id,
    provider,
    name: "Pi ask_user",
    kind: "question",
    title: question,
    input: {
      questions: [
        {
          question,
          header: QUESTION_RESPONSE_HEADER,
          options: visibleOptions.map((label) => ({ label })),
          multiSelect: false,
          ...(allowOther ? { allowOther: true } : {}),
        },
        {
          question: "Optional comment",
          header: QUESTION_COMMENT_HEADER,
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
        },
      ],
    },
    metadata: {
      extensionUiMethod: dialog.method,
      answerHeader: QUESTION_RESPONSE_HEADER,
      commentHeader: QUESTION_COMMENT_HEADER,
      combinedAskUser: COMBINED_METADATA,
      selectOptions: visibleOptions,
      ...(allowOther ? { freeformSentinel: FREEFORM_SENTINEL } : {}),
    },
  };
}

export const piAskUser: PiExtension = {
  id: "pi-ask-user",
  createSession() {
    let active: z.infer<typeof Args> | null = null;
    let pending: { comment: string; freeform: string | null } | null = null;
    return {
      onToolStart(call) {
        active = call.toolName === "ask_user" ? (Args.safeParse(call.args).data ?? null) : null;
        return undefined;
      },
      onToolEnd(call) {
        if (call.toolName === "ask_user") {
          active = null;
          pending = null;
        }
      },
      mapDialog(dialog, provider) {
        if (pending && dialog.method === "input") {
          const input = Input.safeParse(dialog);
          const placeholder = input.success ? input.data.placeholder : undefined;
          if (pending.freeform !== null && !optionalInput(placeholder)) {
            const value = pending.freeform;
            pending = { ...pending, freeform: null };
            return { type: "response", response: { value } };
          }
          if (optionalInput(placeholder)) {
            const value = pending.comment;
            pending = null;
            return { type: "response", response: { value } };
          }
        }
        if (dialog.method !== "select" || !active?.allowComment || active.allowMultiple)
          return undefined;
        const select = Select.safeParse(dialog);
        const options = select.success ? (select.data.options ?? []) : [];
        const question = select.success
          ? (select.data.title ?? "Select an option")
          : "Select an option";
        return {
          type: "permission",
          request: combinedPermission(dialog, provider, options, active.allowFreeform, question),
        };
      },
      respondToPermission(
        request: AgentPermissionRequest,
        response: AgentPermissionResponse,
      ): PiExtensionUiReply | undefined {
        if (request.metadata?.combinedAskUser !== COMBINED_METADATA) return undefined;
        if (response.behavior === "deny") {
          pending = null;
          return { responses: [{ id: request.id, response: { cancelled: true } }] };
        }
        const selected = answer(response.updatedInput, QUESTION_RESPONSE_HEADER);
        if (selected === null) {
          pending = null;
          return { responses: [{ id: request.id, response: { cancelled: true } }] };
        }
        const selectOptions = Array.isArray(request.metadata?.selectOptions)
          ? request.metadata.selectOptions.filter(
              (item): item is string => typeof item === "string",
            )
          : [];
        const sentinel =
          typeof request.metadata?.freeformSentinel === "string"
            ? request.metadata.freeformSentinel
            : undefined;
        const isFreeform = Boolean(sentinel) && !selectOptions.includes(selected);
        pending = {
          comment: answer(response.updatedInput, QUESTION_COMMENT_HEADER) ?? "",
          freeform: isFreeform ? selected : null,
        };
        return {
          responses: [{ id: request.id, response: { value: isFreeform ? sentinel : selected } }],
        };
      },
    };
  },
};
