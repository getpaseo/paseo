import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";

/**
 * Pure helpers that turn an ACP form elicitation (`elicitation/create`, mode "form") into
 * Paseo question-card input and map the user's answers back to the form's `content`.
 * Unsupported schema shapes parse to `null` so the caller can decline instead of hanging.
 */

export type ElicitationContent = Record<string, string | number | boolean | string[]>;

interface ChoiceOption {
  label: string;
  value: string;
}

interface ElicitationField {
  key: string;
  header: string;
  question: string;
  kind: "choice" | "multi" | "boolean" | "text";
  options: ChoiceOption[];
  /** Sibling free-text property (`<key>_other`) that receives an answer outside the options. */
  otherKey?: string;
}

export interface ParsedElicitation {
  fields: ElicitationField[];
}

export interface ElicitationQuestionInput {
  // Index signature so the card input stays assignable to the plugin protocol's JSON values.
  [key: string]: string | boolean | Array<{ label: string; description: string }>;
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
  allowOther: boolean;
}

const OTHER_SUFFIX = "_other";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readTitledOptions(value: unknown): ChoiceOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: ChoiceOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.const !== "string") return null;
    options.push({ label: readString(entry.title) ?? entry.const, value: entry.const });
  }
  return options;
}

function readEnumOptions(value: unknown): ChoiceOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry) => typeof entry === "string")) return null;
  return value.map((entry: string) => ({ label: entry, value: entry }));
}

function readChoiceOptions(schema: Record<string, unknown>): ChoiceOption[] | null {
  return readTitledOptions(schema.oneOf) ?? readEnumOptions(schema.enum);
}

function readMultiOptions(schema: Record<string, unknown>): ChoiceOption[] | null {
  if (!isRecord(schema.items)) return null;
  return readTitledOptions(schema.items.anyOf) ?? readEnumOptions(schema.items.enum);
}

function parseField(
  key: string,
  schema: Record<string, unknown>,
  otherKey: string | undefined,
): ElicitationField | null {
  const title = readString(schema.title) ?? key;
  const base = { key, header: title, question: readString(schema.description) ?? title };
  if (schema.type === "string") {
    const options = readChoiceOptions(schema);
    if (options) return { ...base, kind: "choice", options, otherKey };
    // A string with a closed-but-unreadable choice list is not free text.
    if (schema.oneOf !== undefined && schema.oneOf !== null) return null;
    if (schema.enum !== undefined && schema.enum !== null) return null;
    return { ...base, kind: "text", options: [] };
  }
  if (schema.type === "boolean") {
    return {
      ...base,
      kind: "boolean",
      options: [
        { label: "Yes", value: "true" },
        { label: "No", value: "false" },
      ],
    };
  }
  if (schema.type === "array") {
    const options = readMultiOptions(schema);
    return options ? { ...base, kind: "multi", options, otherKey } : null;
  }
  return null;
}

export function parseElicitationForm(params: CreateElicitationRequest): ParsedElicitation | null {
  if (params.mode !== "form") return null;
  const schema: unknown = (params as { requestedSchema?: unknown }).requestedSchema;
  if (!isRecord(schema) || !isRecord(schema.properties)) return null;
  const properties = schema.properties;
  // A `<key>_other` string property next to a string or array property is that field's "Other".
  const otherKeys = new Set<string>();
  for (const key of Object.keys(properties)) {
    const other = properties[`${key}${OTHER_SUFFIX}`];
    if (isRecord(other) && other.type === "string" && !readChoiceOptions(other)) {
      otherKeys.add(`${key}${OTHER_SUFFIX}`);
    }
  }
  const fields: ElicitationField[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) return null;
    if (otherKeys.has(key)) {
      const owner = properties[key.slice(0, -OTHER_SUFFIX.length)];
      if (isRecord(owner) && (readChoiceOptions(owner) || readMultiOptions(owner))) continue;
    }
    const otherKey = otherKeys.has(`${key}${OTHER_SUFFIX}`) ? `${key}${OTHER_SUFFIX}` : undefined;
    const field = parseField(key, property, otherKey);
    if (!field) return null;
    fields.push(field);
  }
  if (fields.length === 0) return null;
  // Answers are keyed by header, so headers must be unique.
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.header)) field.header = `${field.header} (${field.key})`;
    seen.add(field.header);
  }
  return { fields };
}

export function buildQuestionInputs(parsed: ParsedElicitation): ElicitationQuestionInput[] {
  return parsed.fields.map((field) => ({
    id: field.key,
    header: field.header,
    question: field.question,
    options: field.options.map((option) => ({ label: option.label, description: "" })),
    multiSelect: field.kind === "multi",
    allowOther: field.kind === "text" || field.otherKey !== undefined,
  }));
}

function readAnswer(field: ElicitationField, answers: Record<string, unknown>): string | undefined {
  return readString(answers[field.header]) ?? readString(answers[field.question]);
}

function matchOption(field: ElicitationField, label: string): ChoiceOption | undefined {
  return field.options.find((option) => option.label === label);
}

const SEPARATOR = ", ";

/**
 * The card joins ticked labels and Other text with ", ", and a label may contain a comma, so
 * split against the known labels (longest first) instead of on every comma.
 */
function splitMultiAnswer(
  field: ElicitationField,
  answer: string,
): { matched: string[]; rest: string[] } {
  const options = [...field.options].sort((a, b) => b.label.length - a.label.length);
  const matched: string[] = [];
  const rest: string[] = [];
  let remaining = answer.trim();
  while (remaining.length > 0) {
    const option = options.find(
      (candidate) =>
        remaining === candidate.label || remaining.startsWith(candidate.label + SEPARATOR),
    );
    const separatorAt = remaining.indexOf(SEPARATOR);
    const unmatchedLength = separatorAt === -1 ? remaining.length : separatorAt;
    const length = option ? option.label.length : unmatchedLength;
    const token = remaining.slice(0, length);
    if (option) matched.push(option.value);
    else if (token.trim() !== "") rest.push(token.trim());
    remaining = remaining.slice(length).replace(/^,\s*/, "");
  }
  return { matched, rest };
}

/** Maps the card's answers (keyed by header) to the `content` of an `accept` response. */
export function buildElicitationContent(
  parsed: ParsedElicitation,
  answers: Record<string, unknown>,
): ElicitationContent {
  const content: ElicitationContent = {};
  for (const field of parsed.fields) {
    const answer = readAnswer(field, answers);
    if (answer === undefined) continue;
    if (field.kind === "text") {
      content[field.key] = answer;
    } else if (field.kind === "boolean") {
      const match = matchOption(field, answer);
      if (match) content[field.key] = match.value === "true";
    } else if (field.kind === "choice") {
      const match = matchOption(field, answer);
      if (match) content[field.key] = match.value;
      else if (field.otherKey) content[field.otherKey] = answer;
    } else {
      const { matched, rest } = splitMultiAnswer(field, answer);
      if (matched.length > 0) content[field.key] = matched;
      if (rest.length > 0 && field.otherKey) content[field.otherKey] = rest.join(SEPARATOR);
    }
  }
  return content;
}
