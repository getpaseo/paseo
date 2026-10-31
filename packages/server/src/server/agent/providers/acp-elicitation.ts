import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../agent-sdk-types.js";
import { splitMultiSelectAnswer } from "./question-card-answer.js";

// ACP 1.x names the request `elicitation/create`. The 0.17 SDK draft that Paseo
// builds against named it `session/elicitation` and does not dispatch either one,
// so both arrive through the client's `extMethod` hook.
export const ACP_ELICITATION_METHODS: ReadonlySet<string> = new Set([
  "elicitation/create",
  "session/elicitation",
]);

export type ACPElicitationValue = string | number | boolean | string[];

// The spec's flat result shape. The 0.17 SDK types nest `action` one level
// deeper, which Factory Droid reads as a cancellation.
export type ACPElicitationResponse =
  | { action: "accept"; content: Record<string, ACPElicitationValue> }
  | { action: "decline" }
  | { action: "cancel" };

interface ACPChoiceOption {
  value: string;
  label: string;
}

interface ACPOtherAnswer {
  value: string;
  key: string;
}

interface ACPFieldBase {
  key: string;
  header: string;
  question: string;
  required: boolean;
}

type ACPElicitationField =
  | (ACPFieldBase & { kind: "text" })
  | (ACPFieldBase & { kind: "number"; integer: boolean })
  | (ACPFieldBase & { kind: "boolean" })
  | (ACPFieldBase & {
      kind: "choice";
      multiSelect: boolean;
      options: ACPChoiceOption[];
      other: ACPOtherAnswer | null;
    });

export interface ACPFormElicitation {
  message: string;
  fields: ACPElicitationField[];
}

export type ACPElicitationParseResult =
  | { ok: true; form: ACPFormElicitation }
  | { ok: false; reason: string };

const OTHER_OPTION_VALUE = "other";
const YES_LABEL = "Yes";
const NO_LABEL = "No";

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readChoiceOptions(schema: Record<string, unknown>): ACPChoiceOption[] | null {
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.every((value): value is string => typeof value === "string")) return null;
    return schema.enum.map((value) => ({ value, label: value }));
  }
  const titled = [schema.oneOf, schema.anyOf].find(Array.isArray);
  if (!titled) return null;
  const options: ACPChoiceOption[] = [];
  for (const entry of titled) {
    const option = readRecord(entry);
    if (!option || typeof option.const !== "string") return null;
    options.push({ value: option.const, label: readText(option, "title") ?? option.const });
  }
  return options;
}

function readFieldOptions(property: Record<string, unknown>): ACPChoiceOption[] | null {
  return property.type === "array"
    ? readChoiceOptions(readRecord(property.items) ?? {})
    : readChoiceOptions(property);
}

// Factory Droid pairs an `other` option with a `<field>_other` text field.
// Folding the pair into one question gives it the shared form's free-text input.
function findOtherAnswer(
  key: string,
  options: ACPChoiceOption[],
  properties: Record<string, unknown>,
): ACPOtherAnswer | null {
  const otherKey = `${key}_other`;
  const option = options.find((candidate) => candidate.value === OTHER_OPTION_VALUE);
  if (!option || readRecord(properties[otherKey])?.type !== "string") return null;
  return { value: option.value, key: otherKey };
}

function uniqueHeader(base: string, used: Set<string>): string {
  let header = base;
  for (let suffix = 2; used.has(header); suffix += 1) {
    header = `${base} (${suffix})`;
  }
  used.add(header);
  return header;
}

function readField(input: {
  key: string;
  property: Record<string, unknown>;
  properties: Record<string, unknown>;
  base: ACPFieldBase;
}): ACPElicitationField | null {
  const { key, property, properties, base } = input;
  switch (property.type) {
    case "string":
    case "array": {
      const multiSelect = property.type === "array";
      const options = readFieldOptions(property);
      if (!options) {
        return multiSelect ? null : { ...base, kind: "text" };
      }
      const other = findOtherAnswer(key, options, properties);
      return {
        ...base,
        kind: "choice",
        multiSelect,
        options: other ? options.filter((option) => option.value !== other.value) : options,
        other,
      };
    }
    case "number":
    case "integer":
      return { ...base, kind: "number", integer: property.type === "integer" };
    case "boolean":
      return { ...base, kind: "boolean" };
    default:
      return null;
  }
}

function readRequiredKeys(schema: Record<string, unknown> | null): Set<string> {
  const required = schema?.required;
  return new Set(
    Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [],
  );
}

export function parseACPFormElicitation(
  params: Record<string, unknown>,
): ACPElicitationParseResult {
  if (params.mode !== undefined && params.mode !== "form") {
    return { ok: false, reason: `unsupported elicitation mode '${String(params.mode)}'` };
  }
  const schema = readRecord(params.requestedSchema);
  const properties = readRecord(schema?.properties);
  if (!properties || Object.keys(properties).length === 0) {
    return { ok: false, reason: "elicitation form has no fields" };
  }
  const required = readRequiredKeys(schema);

  const entries: Array<{ key: string; property: Record<string, unknown> }> = [];
  const pairedOtherKeys = new Set<string>();
  for (const [key, value] of Object.entries(properties)) {
    const property = readRecord(value);
    if (!property) return { ok: false, reason: `field '${key}' has no schema` };
    entries.push({ key, property });
    const options = readFieldOptions(property);
    const other = options ? findOtherAnswer(key, options, properties) : null;
    if (other) pairedOtherKeys.add(other.key);
  }

  const fields: ACPElicitationField[] = [];
  const headers = new Set<string>();
  for (const { key, property } of entries) {
    if (pairedOtherKeys.has(key)) continue;
    const title = readText(property, "title");
    const field = readField({
      key,
      property,
      properties,
      base: {
        key,
        header: uniqueHeader(title ?? key, headers),
        question: readText(property, "description") ?? title ?? key,
        required: required.has(key),
      },
    });
    if (!field) return { ok: false, reason: `field '${key}' has an unsupported schema` };
    fields.push(field);
  }

  const message = typeof params.message === "string" ? params.message : "";
  return { ok: true, form: { message, fields } };
}
function toQuestion(field: ACPElicitationField): Record<string, unknown> {
  const question = {
    question: field.question,
    header: field.header,
    allowEmpty: !field.required,
  };
  switch (field.kind) {
    case "text":
    case "number":
      return { ...question, options: [], multiSelect: false };
    case "boolean":
      return {
        ...question,
        options: [{ label: YES_LABEL }, { label: NO_LABEL }],
        multiSelect: false,
      };
    case "choice":
      return {
        ...question,
        options: field.options.map((option) => ({ label: option.label })),
        multiSelect: field.multiSelect,
        allowOther: field.other !== null,
      };
  }
}

export function mapACPElicitationRequest(input: {
  provider: AgentProvider;
  requestId: string;
  form: ACPFormElicitation;
  params: Record<string, unknown>;
}): AgentPermissionRequest {
  const { provider, requestId, form, params } = input;
  return {
    id: requestId,
    provider,
    name: "elicitation",
    kind: "question",
    title: form.message || "Input requested",
    input: { questions: form.fields.map(toQuestion) },
    metadata: { rawRequest: params },
  };
}

function splitChoiceAnswer(
  answer: string,
  labels: string[],
  multiSelect: boolean,
): { selected: string[]; custom: string | null } {
  if (multiSelect) return splitMultiSelectAnswer(answer, labels);
  return labels.includes(answer)
    ? { selected: [answer], custom: null }
    : { selected: [], custom: answer };
}

function readFieldValue(
  field: ACPElicitationField,
  answer: string,
): Record<string, ACPElicitationValue> {
  switch (field.kind) {
    case "text":
      return { [field.key]: answer };
    case "number": {
      const value = Number(answer);
      if (!Number.isFinite(value) || (field.integer && !Number.isInteger(value))) {
        throw new Error(
          `"${field.header}" needs ${field.integer ? "a whole number" : "a number"}, got '${answer}'`,
        );
      }
      return { [field.key]: value };
    }
    case "boolean":
      if (answer === YES_LABEL) return { [field.key]: true };
      if (answer === NO_LABEL) return { [field.key]: false };
      throw new Error(`"${field.header}" needs ${YES_LABEL} or ${NO_LABEL}, got '${answer}'`);
    case "choice": {
      const valuesByLabel = new Map(field.options.map((option) => [option.label, option.value]));
      const labels = Array.from(valuesByLabel.keys());
      const { selected, custom } = splitChoiceAnswer(answer, labels, field.multiSelect);
      const values = selected.flatMap((label) => valuesByLabel.get(label) ?? []);
      if (custom === null) {
        return { [field.key]: field.multiSelect ? values : values[0] };
      }
      if (!field.other) {
        throw new Error(`"${field.header}" has no option '${custom}'`);
      }
      return field.multiSelect
        ? { [field.key]: [...values, field.other.value], [field.other.key]: custom }
        : { [field.key]: field.other.value, [field.other.key]: custom };
    }
  }
}

export function buildACPElicitationResponse(
  form: ACPFormElicitation,
  response: AgentPermissionResponse,
): ACPElicitationResponse {
  if (response.behavior === "deny") {
    return { action: "decline" };
  }
  const answers = readRecord(response.updatedInput?.answers) ?? {};
  const content: Record<string, ACPElicitationValue> = {};
  for (const field of form.fields) {
    const raw = answers[field.header];
    const answer = typeof raw === "string" ? raw.trim() : "";
    if (!answer) {
      if (field.required) throw new Error(`"${field.header}" needs an answer`);
      continue;
    }
    Object.assign(content, readFieldValue(field, answer));
  }
  return { action: "accept", content };
}
