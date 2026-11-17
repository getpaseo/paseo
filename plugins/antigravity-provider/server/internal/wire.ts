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
    readonly rpcCode?: number,
  ) {
    super(message);
  }
}

export function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof AntigravityError && error.rpcCode === -32601;
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

export const acpElicitationChoiceSchema = z.object({
  const: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

export type AcpElicitationChoice = z.infer<typeof acpElicitationChoiceSchema>;

export const acpElicitationPropertySchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  enumNames: z.array(z.string()).optional(),
  oneOf: z.array(acpElicitationChoiceSchema).optional(),
  anyOf: z.array(acpElicitationChoiceSchema).optional(),
  items: z
    .object({
      type: z.string().optional(),
      enum: z.array(z.string()).optional(),
      enumNames: z.array(z.string()).optional(),
      oneOf: z.array(acpElicitationChoiceSchema).optional(),
      anyOf: z.array(acpElicitationChoiceSchema).optional(),
    })
    .optional(),
});

export type AcpElicitationProperty = z.infer<typeof acpElicitationPropertySchema>;

export const acpElicitationParamsSchema = z.object({
  sessionId: z.string().optional(),
  toolCallId: z.string().optional(),
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
  cachedReadTokens: z.number().optional(),
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
  _meta: z
    .object({
      antigravity: z
        .object({
          tier: z
            .object({
              id: z.string().optional(),
              name: z.string().optional(),
              upgradeUri: z.string().optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export const acpPromptResultSchema = z.object({
  stopReason: z.string().min(1),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      cachedReadTokens: z.number().optional(),
      cachedWriteTokens: z.number().optional(),
      thoughtTokens: z.number().optional(),
      totalTokens: z.number().optional(),
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

export interface ParsedElicitationOption {
  label: string;
  value: string;
  description?: string;
}

export interface ParsedElicitationQuestion {
  id: string;
  header: string;
  question: string;
  options: ParsedElicitationOption[];
  rawEnum: string[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  otherFieldKey?: string;
}

const GENERIC_APPROVAL_OPTION_RE = /^(?:always\s+)?allow(?:\s+once)?$/i;
const ASK_QUESTION_TOOL_NAME_RE = /^ask[_-]?(?:user[_-]?)?question$/i;

export function parseToolPermissionQuestions(
  toolCall: AcpToolCallPayload,
  name: string,
  options: AcpPermissionOption[],
): ParsedElicitationQuestion[] | null {
  const rawInput = asPlainRecord(toolCall.rawInput);
  const rawQuestions = Array.isArray(rawInput?.questions) ? rawInput.questions : null;
  if (rawQuestions && rawQuestions.length > 0) {
    const parsed = parseRawQuestionEntries(rawQuestions);
    if (parsed.length > 0) return parsed;
  }
  if (!ASK_QUESTION_TOOL_NAME_RE.test(name)) {
    return null;
  }
  return [buildFallbackToolQuestion(toolCall, options)];
}

function parseRawQuestionEntries(rawQuestions: unknown[]): ParsedElicitationQuestion[] {
  const records = rawQuestions
    .map((entry) => asPlainRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const usedHeaders = new Set<string>();
  return records.map((entry, index) =>
    parseSingleQuestionRecord(entry, index, records.length, usedHeaders),
  );
}

function parseSingleQuestionRecord(
  entry: Record<string, unknown>,
  index: number,
  total: number,
  usedHeaders: Set<string>,
): ParsedElicitationQuestion {
  const id = nonEmptyString(entry.id) ?? `q${index}`;
  const baseHeader =
    nonEmptyString(entry.header) ??
    nonEmptyString(entry.title) ??
    (total === 1 ? "Question" : `Question ${index + 1}`);
  const header = allocateUniqueHeader(baseHeader, usedHeaders, index);
  const question =
    nonEmptyString(entry.question) ??
    nonEmptyString(entry.description) ??
    nonEmptyString(entry.title) ??
    `Question ${index + 1}`;
  const multiSelect = Boolean(entry.multiSelect ?? entry.is_multi_select);
  const { options, rawEnum } = parseRawQuestionOptions(entry.options);
  const allowOther = typeof entry.allowOther === "boolean" ? entry.allowOther : true;
  const allowEmpty = typeof entry.allowEmpty === "boolean" ? entry.allowEmpty : false;
  return {
    id,
    header,
    question,
    options,
    rawEnum,
    multiSelect,
    allowOther,
    allowEmpty,
  };
}

function parseRawQuestionOptions(rawOptions: unknown): {
  options: ParsedElicitationOption[];
  rawEnum: string[];
} {
  if (!Array.isArray(rawOptions)) {
    return { options: [], rawEnum: [] };
  }
  const options: ParsedElicitationOption[] = [];
  const rawEnum: string[] = [];
  for (const item of rawOptions) {
    if (typeof item === "string" && item.trim()) {
      const label = item.trim();
      rawEnum.push(label);
      if (label !== "Other") options.push({ label, value: label });
      continue;
    }
    const obj = asPlainRecord(item);
    const label = obj ? nonEmptyString(obj.label) : undefined;
    if (!label) continue;
    const value = (obj ? nonEmptyString(obj.value) : undefined) ?? label;
    rawEnum.push(value);
    if (label === "Other" || value === "Other") continue;
    const description = obj ? nonEmptyString(obj.description) : undefined;
    options.push(description ? { label, value, description } : { label, value });
  }
  return { options, rawEnum };
}

function buildFallbackToolQuestion(
  toolCall: AcpToolCallPayload,
  permissionOptions: AcpPermissionOption[],
): ParsedElicitationQuestion {
  const contentQuestion = extractToolCallContentText(toolCall);
  const titleText =
    toolCall.title && !ASK_QUESTION_TOOL_NAME_RE.test(toolCall.title.trim())
      ? toolCall.title.trim()
      : undefined;
  const allowOptions = permissionOptions.filter((option) => option.kind.startsWith("allow"));
  const hasChooserOptions =
    allowOptions.length > 1 ||
    allowOptions.some((option) => !GENERIC_APPROVAL_OPTION_RE.test(option.name.trim()));
  const options: ParsedElicitationOption[] = hasChooserOptions
    ? allowOptions.map((option) => ({ label: option.name, value: option.name }))
    : [];
  return {
    id: "q0",
    header: "Question",
    question: contentQuestion ?? titleText ?? "The agent has a question.",
    options,
    rawEnum: options.map((option) => option.value),
    multiSelect: false,
    allowOther: options.length === 0,
    allowEmpty: false,
  };
}

function extractToolCallContentText(toolCall: AcpToolCallPayload): string | undefined {
  for (const block of toolCall.content ?? []) {
    if (block.type === "content" && block.content.text?.trim()) {
      return block.content.text.trim();
    }
  }
  return undefined;
}

export function selectPermissionOption(
  options: AcpPermissionOption[],
  response: ProviderPermissionResponse,
): AcpPermissionOption | undefined {
  if (response.selectedActionId) {
    const exact = options.find((option) => option.optionId === response.selectedActionId);
    if (exact) return exact;
  }
  if (response.behavior === "allow") {
    return (
      options.find((option) => option.kind === "allow_once") ??
      options.find((option) => option.kind.startsWith("allow")) ??
      options.find((option) => /allow/i.test(option.optionId))
    );
  }
  return (
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind.startsWith("reject")) ??
    options.find((option) => /deny|reject/i.test(option.optionId))
  );
}

export function buildToolPermissionQuestionResponse(
  questions: ParsedElicitationQuestion[],
  rawInput: Readonly<Record<string, JsonValue>> | undefined,
  options: AcpPermissionOption[],
  response: ProviderPermissionResponse,
): Record<string, unknown> {
  if (response.behavior === "deny") {
    const rejectOption = response.selectedActionId
      ? selectPermissionOption(options, response)
      : undefined;
    return rejectOption
      ? { outcome: { outcome: "selected", optionId: rejectOption.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  const supplied = extractSuppliedAnswers(response.updatedInput);
  const answersByQuestion: Record<string, string | string[]> = {};

  for (const question of questions) {
    const rawValue = lookupQuestionRawAnswer(supplied, question);
    const values = normalizeAnswerValues(rawValue, question.multiSelect, question.options);
    answersByQuestion[question.question] = question.multiSelect ? values : (values[0] ?? "");
  }

  const firstAnswer =
    questions.length === 1 && !questions[0]!.multiSelect
      ? String(answersByQuestion[questions[0]!.question] ?? "")
      : "";
  const selectedOption =
    matchChooserPermissionOption(options, firstAnswer) ?? selectPermissionOption(options, response);
  if (!selectedOption) {
    return { outcome: { outcome: "cancelled" } };
  }

  const updatedInput: Record<string, unknown> = {
    ...rawInput,
    answers: answersByQuestion,
  };
  const elicitation = buildElicitationResponse(questions, response);
  return {
    outcome: {
      outcome: "selected",
      optionId: selectedOption.optionId,
      updatedInput,
    },
    updatedInput,
    ...(elicitation.content
      ? { _meta: { antigravity: { answers: answersByQuestion, content: elicitation.content } } }
      : {}),
  };
}

function matchChooserPermissionOption(
  options: AcpPermissionOption[],
  answer: string,
): AcpPermissionOption | undefined {
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  return options.find(
    (option) =>
      option.kind.startsWith("allow") &&
      (option.optionId === trimmed || option.name.trim() === trimmed),
  );
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function allocateUniqueHeader(base: string, used: Set<string>, index: number): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const disambiguated = `${base} (${index + 1})`;
  used.add(disambiguated);
  return disambiguated;
}

function parseElicitationPropertyOptions(
  prop: AcpElicitationProperty,
  multiSelect: boolean,
): { options: ParsedElicitationOption[]; rawEnum: string[] } {
  const choices = multiSelect
    ? (prop.items?.anyOf ?? prop.items?.oneOf)
    : (prop.oneOf ?? prop.anyOf);
  if (choices && choices.length > 0) {
    return parseElicitationChoiceOptions(choices);
  }
  const enumValues = multiSelect ? (prop.items?.enum ?? []) : (prop.enum ?? []);
  const enumNames = multiSelect ? prop.items?.enumNames : prop.enumNames;
  return parseElicitationStringEnumOptions(enumValues, enumNames);
}

function parseElicitationChoiceOptions(choices: AcpElicitationChoice[]): {
  options: ParsedElicitationOption[];
  rawEnum: string[];
} {
  const options: ParsedElicitationOption[] = [];
  const rawEnum: string[] = [];
  for (const choice of choices) {
    const value = choice.const.trim();
    if (!value) continue;
    const label = choice.title?.trim() || value;
    rawEnum.push(value);
    if (value === "Other" || label === "Other") continue;
    const description = choice.description?.trim();
    options.push(description ? { label, value, description } : { label, value });
  }
  return { options, rawEnum };
}

function parseElicitationStringEnumOptions(
  enumValues: string[],
  enumNames: string[] | undefined,
): { options: ParsedElicitationOption[]; rawEnum: string[] } {
  const options: ParsedElicitationOption[] = [];
  const rawEnum: string[] = [];
  for (let i = 0; i < enumValues.length; i++) {
    const value = enumValues[i]!.trim();
    if (!value) continue;
    const label = enumNames?.[i]?.trim() || value;
    rawEnum.push(value);
    if (value === "Other" || label === "Other") continue;
    options.push({ label, value });
  }
  return { options, rawEnum };
}

export function parseElicitationQuestions(
  params: AcpElicitationParams,
): ParsedElicitationQuestion[] {
  const properties = params.requestedSchema?.properties ?? {};
  const hasExplicitRequired = Array.isArray(params.requestedSchema?.required);
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

  const usedHeaders = new Set<string>();
  return entries.map(([key, prop], index) => {
    const multiSelect = prop.type === "array";
    const { options, rawEnum } = parseElicitationPropertyOptions(prop, multiSelect);
    const otherFieldKey = `${key}_other` in properties ? `${key}_other` : undefined;
    const allowOther = Boolean(otherFieldKey) || rawEnum.includes("Other") || options.length === 0;
    const explicitDescription = prop.description?.trim();
    const explicitTitle = prop.title?.trim();
    const baseHeader =
      (explicitDescription ? explicitTitle : undefined) ||
      (entries.length === 1 ? "Question" : `Question ${index + 1}`);
    const header = allocateUniqueHeader(baseHeader, usedHeaders, index);
    const question =
      explicitDescription || explicitTitle || params.message || `Question ${index + 1}`;
    return {
      id: key,
      header,
      question,
      options,
      rawEnum,
      multiSelect,
      allowOther,
      allowEmpty: hasExplicitRequired && !otherFieldKey ? !required.has(key) : false,
      otherFieldKey,
    };
  });
}

const suppliedAnswersSchema = z
  .object({
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  })
  .optional();

function extractSuppliedAnswers(updatedInput: unknown): Record<string, string | string[]> {
  const parsed = suppliedAnswersSchema.safeParse(updatedInput);
  return parsed.success ? (parsed.data?.answers ?? {}) : {};
}

function lookupQuestionRawAnswer(
  answers: Record<string, string | string[]>,
  question: ParsedElicitationQuestion,
): string | string[] {
  return answers[question.header] ?? answers[question.id] ?? answers[question.question] ?? "";
}

export function buildElicitationResponse(
  questions: ParsedElicitationQuestion[],
  response: ProviderPermissionResponse,
): { action: "accept" | "cancel"; content?: Record<string, unknown> } {
  if (response.behavior === "deny") {
    return { action: "cancel" };
  }
  const answers = extractSuppliedAnswers(response.updatedInput);
  const content: Record<string, unknown> = {};

  for (const question of questions) {
    const rawValue = lookupQuestionRawAnswer(answers, question);
    const values = normalizeAnswerValues(rawValue, question.multiSelect, question.options);

    if (question.multiSelect) {
      applyMultiSelectAnswer(content, question, values);
    } else {
      applySingleSelectAnswer(content, question, values[0] ?? "");
    }
  }

  return { action: "accept", content };
}

export function summarizeQuestionPermissionOutcome(
  questions: ParsedElicitationQuestion[],
  response: ProviderPermissionResponse,
): string {
  if (response.behavior === "deny") {
    return "Dismissed";
  }
  const answers = extractSuppliedAnswers(response.updatedInput);
  return questions
    .map((question, index) => {
      const rawValue = lookupQuestionRawAnswer(answers, question);
      const values = normalizeAnswerValues(rawValue, question.multiSelect, question.options);
      const displayValues = values.map((val) => {
        const matched = findMatchingElicitationOption(question.options, val);
        return matched ? matched.label : val;
      });
      const rendered = displayValues.length > 0 ? displayValues.join(", ") : "Skipped";
      const prefix = questions.length > 1 ? `Q${index + 1}: ` : "Q: ";
      const ansPrefix = questions.length > 1 ? `A${index + 1}: ` : "A: ";
      return `${prefix}${question.question}\n${ansPrefix}${rendered}`;
    })
    .join("\n\n");
}

function findMatchingElicitationOption(
  options: readonly ParsedElicitationOption[],
  candidate: string,
): ParsedElicitationOption | undefined {
  return options.find((option) => option.label === candidate || option.value === candidate);
}

function normalizeAnswerValues(
  rawValue: string | string[],
  multiSelect: boolean,
  options: readonly ParsedElicitationOption[],
): string[] {
  if (Array.isArray(rawValue)) {
    return rawValue.map((item) => item.trim()).filter(Boolean);
  }
  if (multiSelect) {
    return splitMultiSelectString(rawValue, options);
  }
  const trimmed = rawValue.trim();
  return trimmed ? [trimmed] : [];
}

function splitMultiSelectString(
  rawValue: string,
  options: readonly ParsedElicitationOption[],
): string[] {
  const candidates = [...options]
    .flatMap((opt) => (opt.label === opt.value ? [opt.label] : [opt.label, opt.value]))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  const tokens: string[] = [];
  let remaining = rawValue.trim();
  while (remaining.length > 0) {
    const matched = matchLeadingMultiSelectToken(remaining, candidates);
    if (matched) {
      tokens.push(matched.token);
      remaining = matched.rest;
      continue;
    }
    const commaIdx = remaining.indexOf(",");
    if (commaIdx < 0) {
      tokens.push(remaining);
      break;
    }
    const head = remaining.slice(0, commaIdx).trim();
    if (head) tokens.push(head);
    remaining = remaining.slice(commaIdx + 1).trim();
  }
  return tokens;
}

function matchLeadingMultiSelectToken(
  remaining: string,
  candidates: readonly string[],
): { token: string; rest: string } | null {
  for (const candidate of candidates) {
    if (remaining === candidate) {
      return { token: candidate, rest: "" };
    }
    if (remaining.startsWith(`${candidate},`)) {
      return { token: candidate, rest: remaining.slice(candidate.length + 1).trim() };
    }
  }
  return null;
}

function applyMultiSelectAnswer(
  content: Record<string, unknown>,
  question: ParsedElicitationQuestion,
  values: string[],
): void {
  const selected: string[] = [];
  const custom: string[] = [];
  for (const value of values) {
    const matched = findMatchingElicitationOption(question.options, value);
    if (matched) {
      selected.push(matched.value);
    } else {
      custom.push(value);
    }
  }
  if (custom.length > 0) {
    if (question.rawEnum.includes("Other")) selected.push("Other");
    if (question.otherFieldKey) {
      content[question.otherFieldKey] = custom.join(", ");
    } else if (!question.rawEnum.includes("Other")) {
      selected.push(...custom);
    }
  }
  content[question.id] = selected;
}

function applySingleSelectAnswer(
  content: Record<string, unknown>,
  question: ParsedElicitationQuestion,
  single: string,
): void {
  if (!single) {
    if (question.options.length === 0 && !question.otherFieldKey) {
      content[question.id] = "";
    }
    return;
  }
  const matched = findMatchingElicitationOption(question.options, single);
  if (matched) {
    content[question.id] = matched.value;
    return;
  }
  if (question.otherFieldKey) {
    if (question.rawEnum.includes("Other")) {
      content[question.id] = "Other";
    }
    content[question.otherFieldKey] = single;
    return;
  }
  content[question.id] = single;
}

export function classifyFailure(
  stderr: string,
  detail?: string,
  rpcCode?: number,
): AntigravityError {
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
      rpcCode,
    );
  }
  return new AntigravityError(
    detail || stderr.trim() || "Antigravity command failed",
    "PROCESS_FAILED",
    combined || undefined,
    rpcCode,
  );
}
