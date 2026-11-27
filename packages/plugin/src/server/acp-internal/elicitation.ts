import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationFormMode,
  ElicitationPropertySchema,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderPermissionRequest, ProviderPermissionResponse } from "../provider.js";

interface OptionChoice {
  constValue: string;
  label: string;
  description?: string;
}

interface ElicitationField {
  key: string;
  otherKey?: string;
  header: string;
  question: string;
  kind: "single_select" | "multi_select" | "boolean" | "number" | "integer" | "text";
  options: readonly OptionChoice[];
  required: boolean;
  allowOther: boolean;
  placeholder?: string;
}

export interface ParsedFormElicitation {
  request: Omit<ProviderPermissionRequest, "id">;
  fields: readonly ElicitationField[];
}

type JsonObject = Record<string, JsonValue>;

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isPlainStringProperty(schema: ElicitationPropertySchema | undefined): boolean {
  if (!schema || schema.type !== "string") return false;
  const candidate = schema as { enum?: unknown; oneOf?: unknown };
  return !Array.isArray(candidate.enum) && !Array.isArray(candidate.oneOf);
}

function readSingleSelectOptions(schema: ElicitationPropertySchema): OptionChoice[] | null {
  if (schema.type !== "string") return null;
  const record = schema as {
    oneOf?: Array<{ const: string; title: string; description?: string | null }> | null;
    enum?: string[] | null;
  };
  if (Array.isArray(record.oneOf) && record.oneOf.length > 0) {
    return record.oneOf.map((option) => ({
      constValue: option.const,
      label: option.title || option.const,
      description: nonEmpty(option.description),
    }));
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return record.enum.map((value) => ({ constValue: value, label: value }));
  }
  return null;
}

function readMultiSelectOptions(schema: ElicitationPropertySchema): OptionChoice[] | null {
  if (schema.type !== "array") return null;
  const items = (schema as { items?: unknown }).items;
  if (!items || typeof items !== "object") return null;
  const record = items as {
    anyOf?: Array<{ const: string; title: string; description?: string | null }>;
    oneOf?: Array<{ const: string; title: string; description?: string | null }>;
    enum?: string[];
  };
  let titled: Array<{ const: string; title: string; description?: string | null }> | null = null;
  if (Array.isArray(record.anyOf)) titled = record.anyOf;
  else if (Array.isArray(record.oneOf)) titled = record.oneOf;
  if (titled && titled.length > 0) {
    return titled.map((option) => ({
      constValue: option.const,
      label: option.title || option.const,
      description: nonEmpty(option.description),
    }));
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return record.enum.map((value) => ({ constValue: value, label: value }));
  }
  return null;
}

function buildHeaderAndQuestion(
  key: string,
  schema: ElicitationPropertySchema,
  index: number,
  total: number,
  usedHeaders: Set<string>,
): { header: string; question: string } {
  const title = nonEmpty((schema as { title?: string | null }).title);
  const description = nonEmpty((schema as { description?: string | null }).description);

  let rawHeader: string;
  let question: string;
  if (title && description && title.length <= 48) {
    rawHeader = title;
    question = description;
  } else if (title) {
    rawHeader = total === 1 ? "Question" : `Question ${index + 1}`;
    question = title;
  } else if (description) {
    rawHeader = total === 1 ? "Question" : `Question ${index + 1}`;
    question = description;
  } else {
    rawHeader = key;
    question = key;
  }

  let header = rawHeader;
  let suffix = 2;
  while (usedHeaders.has(header)) {
    header = `${rawHeader} (${suffix})`;
    suffix += 1;
  }
  usedHeaders.add(header);
  return { header, question };
}

function readRequestedSchema(request: CreateElicitationRequest): ElicitationSchema | null {
  if (request.mode !== "form") return null;
  const form = request as Partial<ElicitationFormMode>;
  const schema = form.requestedSchema;
  if (!schema || typeof schema !== "object") return null;
  return schema;
}

function pairOtherFields(
  entries: readonly [string, ElicitationPropertySchema][],
  properties: Readonly<Record<string, ElicitationPropertySchema>>,
): { absorbed: Set<string>; paired: Map<string, string> } {
  const absorbed = new Set<string>();
  const paired = new Map<string, string>();
  for (const [key, schema] of entries) {
    const isChoice =
      readSingleSelectOptions(schema) !== null || readMultiSelectOptions(schema) !== null;
    if (!isChoice) continue;
    const otherKey = `${key}_other`;
    if (otherKey in properties && isPlainStringProperty(properties[otherKey])) {
      absorbed.add(otherKey);
      paired.set(key, otherKey);
    }
  }
  return { absorbed, paired };
}

function parseField(input: {
  key: string;
  schema: ElicitationPropertySchema;
  otherKey?: string;
  otherSchema?: ElicitationPropertySchema;
  header: string;
  question: string;
  required: boolean;
}): ElicitationField | null {
  const { key, schema, otherKey, otherSchema, header, question, required } = input;
  const otherPlaceholder = nonEmpty((otherSchema as { description?: string | null })?.description);
  const ownPlaceholder = nonEmpty((schema as { description?: string | null }).description);

  const singleOptions = readSingleSelectOptions(schema);
  if (singleOptions) {
    return {
      key,
      otherKey,
      header,
      question,
      kind: "single_select",
      options: singleOptions,
      required,
      allowOther: otherKey !== undefined,
      placeholder: otherPlaceholder,
    };
  }

  const multiOptions = readMultiSelectOptions(schema);
  if (multiOptions) {
    return {
      key,
      otherKey,
      header,
      question,
      kind: "multi_select",
      options: multiOptions,
      required,
      allowOther: otherKey !== undefined,
      placeholder: otherPlaceholder,
    };
  }

  if (schema.type === "boolean") {
    return {
      key,
      header,
      question,
      kind: "boolean",
      options: [
        { constValue: "true", label: "Yes" },
        { constValue: "false", label: "No" },
      ],
      required,
      allowOther: false,
    };
  }

  if (schema.type === "integer" || schema.type === "number" || schema.type === "string") {
    return {
      key,
      header,
      question,
      kind: schema.type === "string" ? "text" : schema.type,
      options: [],
      required,
      allowOther: true,
      placeholder: ownPlaceholder,
    };
  }

  return null;
}

function toQuestionEntry(field: ElicitationField): JsonObject {
  const entry: JsonObject = {
    id: field.key,
    header: field.header,
    question: field.question,
    options: field.options.map((option) => {
      const mapped: JsonObject = { label: option.label };
      if (option.description) mapped.description = option.description;
      return mapped;
    }),
    multiSelect: field.kind === "multi_select",
    allowOther: field.allowOther,
    allowEmpty: !field.required && field.options.length === 0,
  };
  if (field.placeholder) entry.placeholder = field.placeholder;
  return entry;
}

export function parseFormElicitation(
  request: CreateElicitationRequest,
  toolName?: string,
): ParsedFormElicitation | null {
  const requestedSchema = readRequestedSchema(request);
  const properties = requestedSchema?.properties;
  if (!requestedSchema || !properties || typeof properties !== "object") return null;

  const entries = Object.entries(properties);
  if (entries.length === 0) return null;

  const requiredSet = new Set(requestedSchema.required ?? []);
  const { absorbed, paired } = pairOtherFields(entries, properties);
  const primaryEntries = entries.filter(([key]) => !absorbed.has(key));
  if (primaryEntries.length === 0) return null;

  const usedHeaders = new Set<string>();
  const fields: ElicitationField[] = [];
  for (let index = 0; index < primaryEntries.length; index += 1) {
    const [key, schema] = primaryEntries[index]!;
    const { header, question } = buildHeaderAndQuestion(
      key,
      schema,
      index,
      primaryEntries.length,
      usedHeaders,
    );
    const otherKey = paired.get(key);
    const field = parseField({
      key,
      schema,
      otherKey,
      otherSchema: otherKey ? properties[otherKey] : undefined,
      header,
      question,
      required: requiredSet.has(key),
    });
    if (!field) return null;
    fields.push(field);
  }

  const title =
    nonEmpty(requestedSchema.title) ??
    (fields.length === 1 ? fields[0]!.question.slice(0, 120) : `Questions (${fields.length})`);

  return {
    fields,
    request: {
      name: toolName ?? "elicitation",
      kind: "question",
      title,
      description: nonEmpty(request.message),
      input: { questions: fields.map(toQuestionEntry) },
    },
  };
}

function splitMultiSelectAnswer(
  answer: string,
  labels: readonly string[],
): { selected: string[]; custom: string | null } {
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

function readAnswer(answers: Record<string, unknown>, field: ElicitationField): string | undefined {
  for (const key of [field.header, field.question, field.key]) {
    const value = answers[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function applySingleSelectAnswer(
  field: ElicitationField,
  trimmed: string,
  content: Record<string, ElicitationContentValue>,
): void {
  if (!trimmed) return;
  const matched = field.options.find(
    (option) => option.label === trimmed || option.constValue === trimmed,
  );
  if (matched) content[field.key] = matched.constValue;
  else if (field.otherKey) content[field.otherKey] = trimmed;
  else content[field.key] = trimmed;
}

function applyMultiSelectAnswer(
  field: ElicitationField,
  trimmed: string,
  content: Record<string, ElicitationContentValue>,
): void {
  if (!trimmed) return;
  const labels = field.options.map((option) => option.label);
  const { selected, custom } = splitMultiSelectAnswer(trimmed, labels);
  const selectedConsts = selected.map(
    (label) => field.options.find((option) => option.label === label)!.constValue,
  );
  if (selectedConsts.length > 0) content[field.key] = selectedConsts;
  if (!custom) return;
  if (field.otherKey) content[field.otherKey] = custom;
  else content[field.key] = [...selectedConsts, custom];
}

function applyFieldAnswer(
  field: ElicitationField,
  answer: string,
  content: Record<string, ElicitationContentValue>,
): void {
  const trimmed = answer.trim();
  if (field.kind === "single_select") {
    applySingleSelectAnswer(field, trimmed, content);
    return;
  }
  if (field.kind === "multi_select") {
    applyMultiSelectAnswer(field, trimmed, content);
    return;
  }
  if (field.kind === "boolean") {
    const lower = trimmed.toLowerCase();
    if (lower === "yes" || lower === "true") content[field.key] = true;
    else if (lower === "no" || lower === "false") content[field.key] = false;
    return;
  }
  if (field.kind === "number" || field.kind === "integer") {
    if (!trimmed) return;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || (field.kind === "integer" && !Number.isInteger(numeric))) {
      throw new Error(`Invalid ${field.kind} value for '${field.header}': ${trimmed}`);
    }
    content[field.key] = numeric;
    return;
  }
  if (trimmed.length > 0 || field.required) {
    content[field.key] = answer;
  }
}

export function buildElicitationResponse(
  parsed: ParsedFormElicitation,
  response: ProviderPermissionResponse,
): CreateElicitationResponse {
  if (response.behavior === "deny") {
    return { action: "decline" };
  }

  const rawAnswers = response.updatedInput?.answers;
  const answers =
    rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)
      ? (rawAnswers as Record<string, unknown>)
      : {};

  const content: Record<string, ElicitationContentValue> = {};
  for (const field of parsed.fields) {
    const answer = readAnswer(answers, field);
    if (answer !== undefined) applyFieldAnswer(field, answer, content);
  }
  return { action: "accept", content };
}
