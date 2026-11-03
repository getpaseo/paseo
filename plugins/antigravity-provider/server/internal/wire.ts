import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

export type JsonValue = NonNullable<ProviderPermissionRequest["input"]>[string];

export class AntigravityError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly diagnostic?: string,
  ) {
    super(message);
  }
}

export const acpPermissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().default("allow_once"),
});

export const acpToolLocationSchema = z.object({
  path: z.string().min(1),
  line: z.number().nullable().optional(),
});

export const acpToolContentItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("diff"),
    path: z.string().min(1),
    oldText: z.string().nullable().optional(),
    newText: z.string(),
  }),
  z.object({
    type: z.literal("content"),
    content: z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("terminal"),
    terminalId: z.string(),
  }),
]);

export const acpToolCallPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  title: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).nullable().optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  locations: z.array(acpToolLocationSchema).nullable().optional(),
  content: z.array(acpToolContentItemSchema).nullable().optional(),
});

export type AcpToolCallPayload = z.infer<typeof acpToolCallPayloadSchema>;
export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;

export const acpRequestPermissionParamsSchema = z.object({
  sessionId: z.string().min(1),
  toolCall: acpToolCallPayloadSchema,
  options: z.array(acpPermissionOptionSchema).min(1),
});

export type AcpRequestPermissionParams = z.infer<typeof acpRequestPermissionParamsSchema>;

export const acpElicitationPropertySchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  items: z
    .object({
      type: z.string().optional(),
      enum: z.array(z.string()).optional(),
    })
    .optional(),
});

export const acpElicitationParamsSchema = z.object({
  sessionId: z.string().optional(),
  mode: z.string().optional(),
  message: z.string().optional(),
  url: z.string().optional(),
  elicitationId: z.string().optional(),
  requestedSchema: z
    .object({
      type: z.string().optional(),
      properties: z.record(z.string(), acpElicitationPropertySchema).optional(),
      required: z.array(z.string()).optional(),
    })
    .optional(),
});

export type AcpElicitationParams = z.infer<typeof acpElicitationParamsSchema>;

const acpTextChunkUpdateSchema = z.object({
  sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]),
  messageId: z.string().nullable().optional(),
  content: z.object({
    type: z.string(),
    text: z.string().optional(),
  }),
});

const acpToolCallUpdateSchema = acpToolCallPayloadSchema.extend({
  sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
});

const acpAvailableCommandsUpdateSchema = z.object({
  sessionUpdate: z.literal("available_commands_update"),
  availableCommands: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().default(""),
      input: z
        .object({
          hint: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    }),
  ),
});

const acpUsageUpdateSchema = z.object({
  sessionUpdate: z.literal("usage_update"),
  used: z.number().optional(),
  size: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  cost: z
    .object({
      amount: z.number(),
      currency: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const acpOtherUpdateSchema = z
  .object({
    sessionUpdate: z.string(),
  })
  .transform(() => ({ sessionUpdate: "other" as const }));

export const acpSessionUpdateSchema = z.union([
  acpTextChunkUpdateSchema,
  acpToolCallUpdateSchema,
  acpAvailableCommandsUpdateSchema,
  acpUsageUpdateSchema,
  acpOtherUpdateSchema,
]);

export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;

export const acpSessionNotificationParamsSchema = z.object({
  sessionId: z.string().min(1),
  update: acpSessionUpdateSchema,
});

export const acpInitializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z.record(z.string(), z.unknown()).optional(),
  agentInfo: z.record(z.string(), z.unknown()).optional(),
});

export const acpSessionResultSchema = z.object({
  sessionId: z.string().min(1).optional(),
  models: z
    .object({
      availableModels: z
        .array(
          z.object({
            modelId: z.string().min(1),
            name: z.string().min(1),
            description: z.string().optional(),
          }),
        )
        .optional(),
      currentModelId: z.string().min(1).optional(),
    })
    .nullable()
    .optional(),
  configOptions: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});

export const acpPromptResultSchema = z.object({
  stopReason: z.string().min(1),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      totalCostUsd: z.number().optional(),
    })
    .optional(),
});

export const jsonRpcErrorObjectSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const persistenceSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.conversationId || value.sessionId), {
    message: "Expected conversationId or sessionId in Antigravity persistence state",
  });

export interface ParsedElicitationQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string }>;
  rawEnum: string[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  otherFieldKey?: string;
}

export function parseElicitationQuestions(
  params: AcpElicitationParams,
): ParsedElicitationQuestion[] {
  const properties = params.requestedSchema?.properties ?? {};
  const required = new Set(params.requestedSchema?.required ?? []);
  const entries = Object.entries(properties).filter(([key]) => !key.endsWith("_other"));

  if (entries.length === 0) {
    return [
      {
        id: "q0",
        header: "Question",
        question: params.message || "The agent has a question.",
        options: [],
        rawEnum: [],
        multiSelect: false,
        allowOther: true,
        allowEmpty: false,
      },
    ];
  }

  return entries.map(([key, prop], index) => {
    const multiSelect = prop.type === "array";
    const rawEnum = multiSelect ? (prop.items?.enum ?? []) : (prop.enum ?? []);
    const options = rawEnum.filter((item) => item !== "Other").map((label) => ({ label }));
    const otherFieldKey = `${key}_other` in properties ? `${key}_other` : undefined;
    const allowOther = Boolean(otherFieldKey) || rawEnum.includes("Other") || options.length === 0;
    const header =
      prop.title?.trim() || (entries.length === 1 ? "Question" : `Question ${index + 1}`);
    const question =
      prop.description?.trim() || prop.title?.trim() || params.message || `Question ${index + 1}`;
    return {
      id: key,
      header,
      question,
      options,
      rawEnum,
      multiSelect,
      allowOther,
      allowEmpty: !required.has(key),
      otherFieldKey,
    };
  });
}

const suppliedAnswersSchema = z
  .object({
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  })
  .optional();

export function buildElicitationResponse(
  questions: ParsedElicitationQuestion[],
  response: ProviderPermissionResponse,
): { action: "accept" | "cancel"; content?: Record<string, unknown> } {
  if (response.behavior === "deny") {
    return { action: "cancel" };
  }
  const parsed = suppliedAnswersSchema.safeParse(response.updatedInput);
  const answers = parsed.success ? (parsed.data?.answers ?? {}) : {};
  const content: Record<string, unknown> = {};

  for (const question of questions) {
    const rawValue =
      answers[question.header] ?? answers[question.id] ?? answers[question.question] ?? "";
    const values = normalizeAnswerValues(rawValue, question.multiSelect);
    const knownLabels = new Set(question.options.map((option) => option.label));

    if (question.multiSelect) {
      applyMultiSelectAnswer(content, question, values, knownLabels);
    } else {
      applySingleSelectAnswer(content, question, values[0] ?? "", knownLabels);
    }
  }

  return { action: "accept", content };
}

function normalizeAnswerValues(rawValue: string | string[], multiSelect: boolean): string[] {
  if (Array.isArray(rawValue)) {
    return rawValue.map((item) => item.trim()).filter(Boolean);
  }
  if (multiSelect) {
    return rawValue
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const trimmed = rawValue.trim();
  return trimmed ? [trimmed] : [];
}

function applyMultiSelectAnswer(
  content: Record<string, unknown>,
  question: ParsedElicitationQuestion,
  values: string[],
  knownLabels: Set<string>,
): void {
  const selected: string[] = [];
  const custom: string[] = [];
  for (const value of values) {
    if (knownLabels.has(value)) {
      selected.push(value);
    } else {
      custom.push(value);
    }
  }
  if (custom.length > 0) {
    if (question.rawEnum.includes("Other")) selected.push("Other");
    if (question.otherFieldKey) {
      content[question.otherFieldKey] = custom.join(", ");
    } else {
      selected.push(...custom);
    }
  }
  content[question.id] = selected;
}

function applySingleSelectAnswer(
  content: Record<string, unknown>,
  question: ParsedElicitationQuestion,
  single: string,
  knownLabels: Set<string>,
): void {
  if (!single) {
    content[question.id] = "";
    return;
  }
  if (knownLabels.has(single) || question.options.length === 0) {
    content[question.id] = single;
    return;
  }
  if (question.otherFieldKey) {
    content[question.id] = question.rawEnum.includes("Other") ? "Other" : single;
    content[question.otherFieldKey] = single;
    return;
  }
  content[question.id] = single;
}

export function classifyFailure(stderr: string, detail?: string): AntigravityError {
  const combined = [detail, stderr].filter(Boolean).join("\n").trim();
  if (
    /not logged in|sign in|log in|authentication required|UNAUTHENTICATED|auth_required/i.test(
      combined,
    )
  ) {
    return new AntigravityError(
      "Antigravity authentication failed. Run `agy` and sign in, then retry.",
      "AUTH_REQUIRED",
      combined || undefined,
    );
  }
  return new AntigravityError(
    detail || stderr.trim() || "Antigravity command failed",
    "PROCESS_FAILED",
    combined || undefined,
  );
}
