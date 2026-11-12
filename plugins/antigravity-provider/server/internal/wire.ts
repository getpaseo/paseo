import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

export type JsonValue = NonNullable<ProviderPermissionRequest["input"]>[string];

export class AntigravityError extends Error {
  constructor(
    message: string,
    readonly code = "ANTIGRAVITY_ERROR",
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "AntigravityError";
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
    content: z.object({ type: z.string(), text: z.string().optional() }),
  }),
  z.object({ type: z.literal("terminal"), terminalId: z.string() }),
]);

export const acpToolCallPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  name: z.string().nullable().optional(),
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

export const acpElicitationPropertySchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  items: z.object({ type: z.string().optional(), enum: z.array(z.string()).optional() }).optional(),
});

export type AcpElicitationProperty = z.infer<typeof acpElicitationPropertySchema>;

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
  content: z.object({ type: z.string(), text: z.string().optional() }),
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
      input: z.object({ hint: z.string().nullable().optional() }).nullable().optional(),
    }),
  ),
});

const acpUsageUpdateSchema = z
  .object({
    sessionUpdate: z.literal("usage_update"),
    used: z.number().optional(),
    size: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    cachedReadTokens: z.number().optional(),
    cost: z.object({ amount: z.number(), currency: z.string().optional() }).nullable().optional(),
  })
  .transform((u) => ({
    ...u,
    cachedInputTokens: u.cachedInputTokens ?? u.cachedReadTokens,
  }));

const acpPlanUpdateSchema = z.object({
  sessionUpdate: z.literal("plan"),
  entries: z
    .array(
      z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]).optional(),
      }),
    )
    .default([]),
});

export const acpSessionUpdateSchema = z.union([
  acpTextChunkUpdateSchema,
  acpToolCallUpdateSchema,
  acpAvailableCommandsUpdateSchema,
  acpUsageUpdateSchema,
  acpPlanUpdateSchema,
  z.object({ sessionUpdate: z.string() }).transform(() => ({ sessionUpdate: "other" as const })),
]);

export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;

export const acpSessionNotificationParamsSchema = z.object({
  sessionId: z.string().min(1),
  update: acpSessionUpdateSchema,
});

const antigravityTierSchema = z.object({
  name: z.string().min(1).optional(),
  id: z.string().optional(),
  upgradeUri: z.string().optional(),
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
  _meta: z
    .object({ antigravity: z.object({ tier: antigravityTierSchema.nullish() }).nullish() })
    .nullish(),
});

export const acpSessionListResultSchema = z.object({
  sessions: z
    .array(
      z.object({
        sessionId: z.string().min(1),
        cwd: z.string(),
        title: z.string().nullable().optional(),
        updatedAt: z.string().nullable().optional(),
      }),
    )
    .default([]),
  nextCursor: z.string().nullable().optional(),
});

export const acpPromptResultSchema = z.object({
  stopReason: z.string().min(1),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      cachedReadTokens: z.number().optional(),
      totalCostUsd: z.number().optional(),
    })
    .transform((u) => ({
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedInputTokens: u.cachedInputTokens ?? u.cachedReadTokens,
      totalCostUsd: u.totalCostUsd,
    }))
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
    model: z.string().min(1).optional(),
    defaultModelId: z.string().min(1).optional(),
    accumulatedCostUsd: z.number().nonnegative().optional(),
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
  valueType: "string" | "number" | "integer" | "boolean";
  allowOther: boolean;
  allowEmpty: boolean;
  otherFieldKey?: string;
}

function resolvePropertyValueType(type?: string): "string" | "number" | "integer" | "boolean" {
  if (type === "boolean") return "boolean";
  if (type === "number") return "number";
  if (type === "integer") return "integer";
  return "string";
}

function makeUniqueHeaders(entries: Array<[string, AcpElicitationProperty]>): string[] {
  const raw = entries.map(([, prop], index) => {
    return prop.title?.trim() || (entries.length === 1 ? "Question" : `Question ${index + 1}`);
  });
  const counts = new Map<string, number>();
  for (const h of raw) {
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }

  const result: string[] = [];
  const used = new Set<string>();
  const seen = new Map<string, number>();

  for (const header of raw) {
    const isDuplicate = (counts.get(header) ?? 0) > 1;
    let candidate = header;
    if (isDuplicate) {
      const occurrence = (seen.get(header) ?? 0) + 1;
      seen.set(header, occurrence);
      candidate = `${header} (${occurrence})`;
    }
    while (used.has(candidate)) {
      const occurrence = (seen.get(header) ?? 0) + 1;
      seen.set(header, occurrence);
      candidate = `${header} (${occurrence})`;
    }
    used.add(candidate);
    result.push(candidate);
  }
  return result;
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
        valueType: "string",
        allowOther: true,
        allowEmpty: false,
      },
    ];
  }

  const headers = makeUniqueHeaders(entries);
  return entries.map(([key, prop], index) => {
    const multiSelect = prop.type === "array";
    const rawEnum = multiSelect ? (prop.items?.enum ?? []) : (prop.enum ?? []);
    const otherFieldKey = `${key}_other` in properties ? `${key}_other` : undefined;
    const hasCompanionOther = Boolean(otherFieldKey);
    const options = (hasCompanionOther ? rawEnum.filter((item) => item !== "Other") : rawEnum).map(
      (label) => ({ label }),
    );
    const valueType = resolvePropertyValueType(prop.type);
    return {
      id: key,
      header: headers[index]!,
      question:
        prop.description?.trim() || prop.title?.trim() || params.message || `Question ${index + 1}`,
      options,
      rawEnum,
      multiSelect,
      valueType,
      allowOther: hasCompanionOther || options.length === 0,
      allowEmpty: !required.has(key),
      otherFieldKey,
    };
  });
}

const answerScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const suppliedAnswersSchema = z
  .object({
    answers: z
      .record(z.string(), z.union([answerScalarSchema, z.array(answerScalarSchema)]))
      .optional(),
  })
  .optional();

export function buildElicitationResponse(
  questions: ParsedElicitationQuestion[],
  response: ProviderPermissionResponse,
): { action: "accept" | "cancel"; content?: Record<string, unknown> } {
  if (response.behavior === "deny") return { action: "cancel" };
  const parsed = suppliedAnswersSchema.safeParse(response.updatedInput);
  const answers = parsed.success ? (parsed.data?.answers ?? {}) : {};
  const content: Record<string, unknown> = {};
  const allHeaders = new Set(questions.map((q) => q.header));

  for (const question of questions) {
    let rawValue = answers[question.header];
    if (rawValue === undefined && !allHeaders.has(question.id)) {
      rawValue = answers[question.id];
    }
    if (rawValue === undefined && !allHeaders.has(question.question)) {
      rawValue = answers[question.question];
    }
    if (rawValue === undefined && question.allowEmpty) continue;
    const knownLabels = new Set(question.options.map((option) => option.label));
    const values = normalizeAnswerValues(rawValue, question.multiSelect, knownLabels);
    if (values.length === 0 && question.allowEmpty) continue;
    if (question.multiSelect) {
      applyMultiSelectAnswer(content, question, values, knownLabels);
    } else {
      applySingleSelectAnswer(content, question, values[0], knownLabels);
    }
  }
  return { action: "accept", content };
}

function normalizeAnswerValues(
  rawValue: unknown,
  multiSelect: boolean,
  knownLabels?: Set<string>,
): Array<string | number | boolean> {
  if (rawValue === undefined || rawValue === null) return [];
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => (typeof item === "string" ? item.trim() : item))
      .filter((item) => item !== "" && item !== undefined && item !== null);
  }
  if (typeof rawValue === "string") {
    if (multiSelect) {
      return decodeMultiSelectString(rawValue, knownLabels);
    }
    const trimmed = rawValue.trim();
    return trimmed ? [trimmed] : [];
  }
  return [rawValue as number | boolean];
}

function decodeMultiSelectString(rawValue: string, knownLabels?: Set<string>): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed) return [];
  if (!knownLabels || knownLabels.size === 0) {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (knownLabels.has(trimmed)) {
    return [trimmed];
  }

  const sortedLabels = [...knownLabels].sort((a, b) => b.length - a.length);
  const results: string[] = [];
  let remaining = trimmed;

  while (remaining.length > 0) {
    const matched = findStartingLabel(remaining, sortedLabels);
    if (matched !== null) {
      results.push(matched);
      remaining = remaining.slice(matched.length).replace(/^,\s*/, "").trim();
      continue;
    }

    const nextKnownIdx = findNextLabelIndex(remaining, sortedLabels);
    if (nextKnownIdx !== -1) {
      const prefixPart = remaining.slice(0, nextKnownIdx).trim();
      if (prefixPart) {
        for (const part of prefixPart
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          results.push(part);
        }
      }
      remaining = remaining.slice(nextKnownIdx).replace(/^,\s*/, "").trim();
    } else {
      for (const part of remaining
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        results.push(part);
      }
      break;
    }
  }

  return results;
}

function findStartingLabel(remaining: string, sortedLabels: string[]): string | null {
  for (const label of sortedLabels) {
    if (
      remaining === label ||
      remaining.startsWith(label + ",") ||
      remaining.startsWith(label + ", ")
    ) {
      return label;
    }
  }
  return null;
}

function findNextLabelIndex(remaining: string, sortedLabels: string[]): number {
  let nextKnownIdx = -1;
  for (const label of sortedLabels) {
    const idxCommaSpace = remaining.indexOf(", " + label);
    const idxComma = remaining.indexOf("," + label);
    let candidateIdx = -1;
    let sepLen = 1;
    if (idxCommaSpace !== -1 && (idxComma === -1 || idxCommaSpace <= idxComma)) {
      candidateIdx = idxCommaSpace;
      sepLen = 2;
    } else if (idxComma !== -1) {
      candidateIdx = idxComma;
      sepLen = 1;
    }
    if (candidateIdx !== -1 && (nextKnownIdx === -1 || candidateIdx < nextKnownIdx)) {
      const after = remaining.slice(candidateIdx + sepLen + label.length);
      if (after.length === 0 || after.startsWith(",") || after.startsWith(", ")) {
        nextKnownIdx = candidateIdx;
      }
    }
  }
  return nextKnownIdx;
}

function applyMultiSelectAnswer(
  content: Record<string, unknown>,
  question: ParsedElicitationQuestion,
  values: Array<string | number | boolean>,
  knownLabels: Set<string>,
): void {
  const strValues = values.map(String);
  const selected = strValues.filter((v) => knownLabels.has(v));
  const custom = strValues.filter((v) => !knownLabels.has(v));
  if (custom.length > 0) {
    if (question.otherFieldKey) {
      if (question.rawEnum.includes("Other")) selected.push("Other");
      content[question.otherFieldKey] = custom.join(", ");
    } else if (question.rawEnum.length === 0) {
      selected.push(...custom);
    }
  }
  content[question.id] = selected;
}

function convertSingleValue(
  raw: string | number | boolean,
  type: "string" | "number" | "integer" | "boolean",
): string | number | boolean | null {
  if (typeof raw === type) return raw;
  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const str = String(raw).trim().toLowerCase();
    if (str === "true" || str === "yes" || str === "1") return true;
    if (str === "false" || str === "no" || str === "0") return false;
    return null;
  }
  if (type === "number" || type === "integer") {
    if (typeof raw === "number") return type === "integer" ? Math.round(raw) : raw;
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return type === "integer" ? Math.round(parsed) : parsed;
    return null;
  }
  return String(raw);
}

function applySingleSelectAnswer(
  content: Record<string, unknown>,
  question: ParsedElicitationQuestion,
  single: string | number | boolean | undefined,
  knownLabels: Set<string>,
): void {
  if (single === undefined || single === null || single === "") {
    if (question.allowEmpty) return;
    content[question.id] = question.valueType === "string" ? "" : null;
    return;
  }
  const converted = convertSingleValue(single, question.valueType);
  if (converted === null) return;
  if (question.valueType !== "string") {
    content[question.id] = converted;
    return;
  }
  const strVal = String(converted);
  if (knownLabels.has(strVal) || question.options.length === 0) {
    content[question.id] = strVal;
    return;
  }
  if (question.otherFieldKey) {
    content[question.id] = question.rawEnum.includes("Other") ? "Other" : strVal;
    content[question.otherFieldKey] = strVal;
    return;
  }
  if (question.rawEnum.length === 0) {
    content[question.id] = strVal;
  }
}

export function classifyFailure(stderr: string, detail?: string): AntigravityError {
  const combined = [detail, stderr].filter(Boolean).join("\n").trim();
  if (/trajectory.*not found/i.test(combined)) {
    return new AntigravityError(
      "Antigravity session trajectory has expired upstream. Start a new conversation to continue.",
      "PROCESS_FAILED",
      combined || undefined,
    );
  }
  if (
    /not logged in|sign[\s._-]*in|log[\s._-]*in|authentication required|authentication failed|UNAUTHENTICATED|auth_required/i.test(
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
