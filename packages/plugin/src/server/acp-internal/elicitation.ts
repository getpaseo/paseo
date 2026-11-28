import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderPermissionRequest, ProviderPermissionResponse } from "../provider.js";

const OTHER_SUFFIX = "_other";
const OTHER_SENTINEL = "other";
const YES = "Yes";
const NO = "No";
const DEFAULT = "Default";
const SKIP = "Skip";
const NONE = "None";
const NO_SELECTION = "No selection";
const MAX_HEADER_LENGTH = 48;
const MAX_TITLE_LENGTH = 120;

interface RawChoiceOption {
  value: string;
  label: string;
  description?: string;
}

interface CardOption {
  label: string;
  description?: string;
}

interface CardQuestion {
  id: string;
  header: string;
  question: string;
  options: CardOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

interface OtherPairing {
  key: string;
  schema: Record<string, unknown>;
}

interface OtherTarget {
  key: string;
  /** Present when the schema declares an explicit `"other"` sentinel option alongside `<key>_other`. */
  sentinelValue?: string;
}

type FieldOutcome = { ok: true; entries: Array<[string, ElicitationContentValue]> } | { ok: false };

interface ParsedField {
  question: CardQuestion;
  resolve(answer: string | undefined): FieldOutcome;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? text;
}

function readTitledOptions(value: unknown): RawChoiceOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: RawChoiceOption[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry) || typeof entry.const !== "string") return null;
    if (entry.title !== undefined && entry.title !== null && typeof entry.title !== "string") {
      return null;
    }
    options.push({
      value: entry.const,
      label: nonEmpty(entry.title) ?? entry.const,
      description: nonEmpty(entry.description),
    });
  }
  return options;
}

function readEnumOptions(value: unknown): RawChoiceOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry): entry is string => typeof entry === "string")) return null;
  return value.map((entry) => ({ value: entry, label: entry }));
}

type SingleSelectParse =
  | { kind: "choice"; options: RawChoiceOption[] }
  | { kind: "invalid" }
  | { kind: "plain" };

function parseStringChoice(schema: Record<string, unknown>): SingleSelectParse {
  if (schema.oneOf !== undefined && schema.oneOf !== null) {
    const options = readTitledOptions(schema.oneOf);
    return options ? { kind: "choice", options } : { kind: "invalid" };
  }
  if (schema.enum !== undefined && schema.enum !== null) {
    const options = readEnumOptions(schema.enum);
    return options ? { kind: "choice", options } : { kind: "invalid" };
  }
  if (schema.anyOf !== undefined && schema.anyOf !== null) {
    return { kind: "invalid" };
  }
  return { kind: "plain" };
}

function readMultiSelectOptions(schema: Record<string, unknown>): RawChoiceOption[] | null {
  if (!isPlainRecord(schema.items)) return null;
  const items = schema.items;
  if (items.anyOf !== undefined && items.anyOf !== null) return readTitledOptions(items.anyOf);
  if (items.oneOf !== undefined && items.oneOf !== null) return readTitledOptions(items.oneOf);
  if (items.enum !== undefined && items.enum !== null) return readEnumOptions(items.enum);
  return null;
}

function isPlainStringProperty(schema: unknown): schema is Record<string, unknown> {
  return (
    isPlainRecord(schema) &&
    schema.type === "string" &&
    schema.oneOf == null &&
    schema.enum == null &&
    schema.anyOf == null
  );
}

function readChoiceOptions(schema: unknown): RawChoiceOption[] | null {
  if (!isPlainRecord(schema)) return null;
  if (schema.type === "string") {
    const parsed = parseStringChoice(schema);
    return parsed.kind === "choice" ? parsed.options : null;
  }
  if (schema.type === "array") return readMultiSelectOptions(schema);
  return null;
}

function readMinItems(schema: Record<string, unknown>): number {
  return typeof schema.minItems === "number" &&
    Number.isFinite(schema.minItems) &&
    schema.minItems > 0
    ? schema.minItems
    : 0;
}

function pairOtherFields(
  entries: readonly [string, unknown][],
  properties: Record<string, unknown>,
  requiredSet: ReadonlySet<string>,
): { absorbed: Set<string>; paired: Map<string, OtherPairing> } {
  const absorbed = new Set<string>();
  const paired = new Map<string, OtherPairing>();
  for (const [key, schema] of entries) {
    const options = readChoiceOptions(schema);
    if (!options || !isPlainRecord(schema)) continue;
    const otherKey = `${key}${OTHER_SUFFIX}`;
    if (!Object.hasOwn(properties, otherKey) || requiredSet.has(otherKey)) continue;
    const otherSchema = properties[otherKey];
    if (!isPlainStringProperty(otherSchema)) continue;
    // Only fold `<key>_other` as a replacement Other input when the primary field can be
    // omitted or declares an explicit `"other"` sentinel; otherwise keep `_other` as its own
    // optional follow-up field so `required` / `minItems` on `<key>` are always satisfied.
    const mustSelectPrimary =
      requiredSet.has(key) || (schema.type === "array" && readMinItems(schema) > 0);
    const hasSentinel = options.some((option) => option.value === OTHER_SENTINEL);
    if (mustSelectPrimary && !hasSentinel) continue;
    absorbed.add(otherKey);
    paired.set(key, { key: otherKey, schema: otherSchema });
  }
  return { absorbed, paired };
}

function sanitizeMultiLabel(text: string): string {
  return text.replace(/,\s+/g, ",");
}

function formatOptionDescription(
  description: string | undefined,
  isDefault: boolean,
): string | undefined {
  if (!isDefault) return description;
  return description ? `${description} (${DEFAULT})` : DEFAULT;
}

/**
 * Labels the card answers with must be unique within a question. The card joins
 * multi-select labels with ", ", so those labels must not contain ", " or one
 * selection could read as another ("A", "B" versus "A, B").
 */
function buildCardOptions(
  options: readonly RawChoiceOption[],
  multiSelect: boolean,
  defaults: ReadonlySet<string>,
): Array<{ value: string; card: CardOption }> {
  const used = new Set<string>();
  return options.map((option, index) => {
    const rawLabel = option.label || option.value;
    let cardLabel = multiSelect ? sanitizeMultiLabel(rawLabel) : rawLabel;
    if (used.has(cardLabel)) {
      const valueTag = multiSelect ? sanitizeMultiLabel(option.value) : option.value;
      cardLabel = `${cardLabel} (${valueTag})`;
    }
    let suffix = index + 1;
    while (used.has(cardLabel)) {
      cardLabel = `${cardLabel} ${suffix}`;
      suffix += 1;
    }
    used.add(cardLabel);
    const description = formatOptionDescription(option.description, defaults.has(option.value));
    return {
      value: option.value,
      card: description ? { label: cardLabel, description } : { label: cardLabel },
    };
  });
}

function buildHeaderAndQuestion(
  key: string,
  schema: Record<string, unknown>,
  index: number,
  total: number,
  usedHeaders: Set<string>,
): { header: string; question: string } {
  const title = nonEmpty(schema.title);
  const description = nonEmpty(schema.description);
  const fallbackHeader = total === 1 ? "Question" : `Question ${index + 1}`;

  let rawHeader: string;
  let question: string;
  if (title && description) {
    if (title === description) {
      rawHeader = fallbackHeader;
      question = title;
    } else if (title.length <= MAX_HEADER_LENGTH && !title.includes("\n")) {
      rawHeader = title;
      question = description;
    } else {
      rawHeader = fallbackHeader;
      question = `${title}\n\n${description}`;
    }
  } else if (title) {
    rawHeader = fallbackHeader;
    question = title;
  } else if (description) {
    rawHeader = fallbackHeader;
    question = description;
  } else {
    rawHeader = key.length <= MAX_HEADER_LENGTH && !key.includes("\n") ? key : fallbackHeader;
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

/**
 * The shared question card sends a multi-select answer as one string: the checked option
 * labels in click order, then any typed answer, joined with ", ". Consume exact option
 * labels from the front, longest first; any remaining text is the typed answer.
 */
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

function splitSentinelOptions(
  rawOptions: readonly RawChoiceOption[],
  otherPairing: OtherPairing | undefined,
): { options: RawChoiceOption[]; other: OtherTarget | undefined } {
  if (!otherPairing) return { options: [...rawOptions], other: undefined };
  const sentinel = rawOptions.find((option) => option.value === OTHER_SENTINEL);
  if (!sentinel) {
    return { options: [...rawOptions], other: { key: otherPairing.key } };
  }
  return {
    options: rawOptions.filter((option) => option.value !== OTHER_SENTINEL),
    other: { key: otherPairing.key, sentinelValue: sentinel.value },
  };
}

function buildSingleSelectField(input: {
  key: string;
  header: string;
  question: string;
  rawOptions: readonly RawChoiceOption[];
  schema: Record<string, unknown>;
  required: boolean;
  otherPairing?: OtherPairing;
}): ParsedField {
  const { key, header, question, rawOptions, schema, required, otherPairing } = input;
  const { options: selectableOptions, other } = splitSentinelOptions(rawOptions, otherPairing);
  const rawDefault = typeof schema.default === "string" ? schema.default : undefined;
  const defaultValue =
    rawDefault !== undefined && selectableOptions.some((option) => option.value === rawDefault)
      ? rawDefault
      : undefined;
  const defaults = new Set(defaultValue !== undefined ? [defaultValue] : []);
  const built = buildCardOptions(selectableOptions, false, defaults);
  const valueByLabel = new Map(built.map((item) => [item.card.label, item.value]));
  const placeholder = nonEmpty(otherPairing?.schema.description);

  return {
    question: {
      id: key,
      header,
      question,
      options: built.map((item) => item.card),
      multiSelect: false,
      allowOther: other !== undefined,
      allowEmpty: defaultValue !== undefined,
      ...(placeholder ? { placeholder } : {}),
    },
    resolve(answer) {
      const trimmed = answer?.trim();
      if (!trimmed) {
        if (defaultValue !== undefined) return { ok: true, entries: [[key, defaultValue]] };
        return required ? { ok: false } : { ok: true, entries: [] };
      }
      const matched = valueByLabel.get(trimmed);
      if (matched !== undefined) return { ok: true, entries: [[key, matched]] };
      if (!other) return { ok: false };
      if (other.sentinelValue !== undefined) {
        return {
          ok: true,
          entries: [
            [key, other.sentinelValue],
            [other.key, trimmed],
          ],
        };
      }
      return { ok: true, entries: [[other.key, trimmed]] };
    },
  };
}

function buildMultiSelectField(input: {
  key: string;
  header: string;
  question: string;
  rawOptions: readonly RawChoiceOption[];
  schema: Record<string, unknown>;
  required: boolean;
  otherPairing?: OtherPairing;
}): ParsedField {
  const { key, header, question, rawOptions, schema, required, otherPairing } = input;
  const { options: selectableOptions, other } = splitSentinelOptions(rawOptions, otherPairing);
  const selectableValues = new Set(selectableOptions.map((option) => option.value));
  const rawDefaults = Array.isArray(schema.default)
    ? [
        ...new Set(
          schema.default.filter(
            (value): value is string => typeof value === "string" && selectableValues.has(value),
          ),
        ),
      ]
    : [];
  const defaultValues = rawDefaults.length > 0 ? rawDefaults : undefined;
  const built = buildCardOptions(selectableOptions, true, new Set(rawDefaults));
  const valueByLabel = new Map(built.map((item) => [item.card.label, item.value]));

  const minItems = readMinItems(schema);
  const effectiveRequired = required || minItems > 0;
  // The card submits zero choices only beside a text input, so an optional
  // multi-select without Other gets an explicit None choice.
  const needsNone = !other && !effectiveRequired;
  let noneLabel: string | undefined;
  if (needsNone) {
    noneLabel = valueByLabel.has(NONE) ? NO_SELECTION : NONE;
  }
  const allLabels = [...valueByLabel.keys(), ...(noneLabel ? [noneLabel] : [])];
  const cardOptions = [
    ...built.map((item) => item.card),
    ...(noneLabel ? [{ label: noneLabel }] : []),
  ];
  const placeholder = nonEmpty(otherPairing?.schema.description);

  return {
    question: {
      id: key,
      header,
      question,
      options: cardOptions,
      multiSelect: true,
      allowOther: other !== undefined,
      allowEmpty: defaultValues !== undefined,
      ...(placeholder ? { placeholder } : {}),
    },
    resolve(answer) {
      const trimmed = answer?.trim();
      if (!trimmed) {
        if (defaultValues !== undefined) return { ok: true, entries: [[key, defaultValues]] };
        return effectiveRequired ? { ok: false } : { ok: true, entries: [] };
      }
      const { selected, custom } = splitMultiSelectAnswer(trimmed, allLabels);
      const values = selected.flatMap((label) => {
        const value = valueByLabel.get(label);
        return value !== undefined ? [value] : [];
      });
      if (custom !== null) {
        if (!other) return { ok: false };
        if (other.sentinelValue !== undefined) {
          const withSentinel = [...values, other.sentinelValue];
          if (withSentinel.length < minItems) return { ok: false };
          return {
            ok: true,
            entries: [
              [key, withSentinel],
              [other.key, custom],
            ],
          };
        }
        const entries: Array<[string, ElicitationContentValue]> = [];
        if (values.length > 0) entries.push([key, values]);
        entries.push([other.key, custom]);
        return { ok: true, entries };
      }
      if (values.length < minItems) return { ok: false };
      if (values.length === 0 && required) return { ok: false };
      if (values.length > 0 || noneLabel !== undefined) {
        return { ok: true, entries: [[key, values]] };
      }
      return { ok: true, entries: [] };
    },
  };
}

function buildBooleanField(input: {
  key: string;
  header: string;
  question: string;
  schema: Record<string, unknown>;
  required: boolean;
}): ParsedField {
  const { key, header, question, schema, required } = input;
  const defaultValue = typeof schema.default === "boolean" ? schema.default : undefined;
  const options: CardOption[] = [
    defaultValue === true ? { label: YES, description: DEFAULT } : { label: YES },
    defaultValue === false ? { label: NO, description: DEFAULT } : { label: NO },
  ];

  return {
    question: {
      id: key,
      header,
      question,
      options,
      multiSelect: false,
      allowOther: false,
      allowEmpty: false,
    },
    resolve(answer) {
      const trimmed = answer?.trim();
      if (!trimmed) {
        if (defaultValue !== undefined) return { ok: true, entries: [[key, defaultValue]] };
        return required ? { ok: false } : { ok: true, entries: [] };
      }
      if (trimmed === YES) return { ok: true, entries: [[key, true]] };
      if (trimmed === NO) return { ok: true, entries: [[key, false]] };
      return { ok: false };
    },
  };
}

function buildTextField(input: {
  key: string;
  header: string;
  question: string;
  schema: Record<string, unknown>;
  required: boolean;
}): ParsedField {
  const { key, header, question, schema, required } = input;
  const defaultValue = typeof schema.default === "string" ? schema.default : undefined;
  const prefilled = defaultValue !== undefined && defaultValue.length > 0;

  return {
    question: {
      id: key,
      header,
      question,
      options: prefilled ? [{ label: defaultValue, description: DEFAULT }] : [],
      multiSelect: false,
      allowOther: true,
      allowEmpty: prefilled || !required,
    },
    resolve(answer) {
      if (answer !== undefined && answer.trim().length > 0) {
        return { ok: true, entries: [[key, answer]] };
      }
      if (defaultValue !== undefined) return { ok: true, entries: [[key, defaultValue]] };
      return required ? { ok: false } : { ok: true, entries: [] };
    },
  };
}

function parseField(input: {
  key: string;
  schema: Record<string, unknown>;
  otherPairing?: OtherPairing;
  header: string;
  question: string;
  required: boolean;
}): ParsedField | null {
  const { key, schema, otherPairing, header, question, required } = input;
  if (schema.type === "string") {
    const choice = parseStringChoice(schema);
    if (choice.kind === "invalid") return null;
    if (choice.kind === "choice") {
      return buildSingleSelectField({
        key,
        header,
        question,
        rawOptions: choice.options,
        schema,
        required,
        otherPairing,
      });
    }
    return buildTextField({ key, header, question, schema, required });
  }
  if (schema.type === "array") {
    const options = readMultiSelectOptions(schema);
    if (!options) return null;
    return buildMultiSelectField({
      key,
      header,
      question,
      rawOptions: options,
      schema,
      required,
      otherPairing,
    });
  }
  if (schema.type === "boolean") {
    return buildBooleanField({ key, header, question, schema, required });
  }
  return null;
}

function toJsonQuestion(question: CardQuestion): Record<string, JsonValue> {
  const record: Record<string, JsonValue> = {
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map((option): Record<string, JsonValue> => {
      const item: Record<string, JsonValue> = { label: option.label };
      if (option.description) item.description = option.description;
      return item;
    }),
    multiSelect: question.multiSelect,
    allowOther: question.allowOther,
    allowEmpty: question.allowEmpty,
  };
  if (question.placeholder) record.placeholder = question.placeholder;
  if (question.dismissLabel) record.dismissLabel = question.dismissLabel;
  return record;
}

function readAnswers(response: ProviderPermissionResponse): Record<string, unknown> {
  if (response.behavior !== "allow") return {};
  const answers = response.updatedInput?.answers;
  return isPlainRecord(answers) ? answers : {};
}

function readFormSchema(
  request: CreateElicitationRequest,
): { schema: Record<string, unknown>; properties: Record<string, unknown> } | null {
  if (request.mode !== "form") return null;
  const requestedSchema: unknown = (request as { requestedSchema?: unknown }).requestedSchema;
  if (!isPlainRecord(requestedSchema)) return null;
  if (requestedSchema.type !== undefined && requestedSchema.type !== "object") return null;
  if (!isPlainRecord(requestedSchema.properties)) return null;
  return { schema: requestedSchema, properties: requestedSchema.properties };
}

function resolveFormTitle(
  schemaTitle: unknown,
  message: string | undefined,
  questions: readonly CardQuestion[],
): string {
  const explicit = nonEmpty(schemaTitle);
  if (explicit) return explicit.slice(0, MAX_TITLE_LENGTH);
  if (questions.length === 1) return firstLine(questions[0]!.question).slice(0, MAX_TITLE_LENGTH);
  return message?.slice(0, MAX_TITLE_LENGTH) ?? `Questions (${questions.length})`;
}

/**
 * Translates an ACP 1.x form elicitation request (`elicitation/create`, mode `"form"`)
 * into a Paseo `kind: "question"` permission request and maps the user's answer back to
 * an ACP `CreateElicitationResponse` without throwing.
 */
export class AcpFormElicitation {
  private constructor(
    readonly request: Omit<ProviderPermissionRequest, "id">,
    private readonly fields: readonly ParsedField[],
  ) {}

  static parse(
    request: CreateElicitationRequest,
    options?: { toolName?: string },
  ): AcpFormElicitation | null {
    const formSchema = readFormSchema(request);
    if (!formSchema) return null;
    const { schema: requestedSchema, properties } = formSchema;

    const entries = Object.entries(properties);
    if (entries.length === 0) return null;

    const requiredSet = new Set(
      Array.isArray(requestedSchema.required)
        ? requestedSchema.required.filter((key): key is string => typeof key === "string")
        : [],
    );

    const { absorbed, paired } = pairOtherFields(entries, properties, requiredSet);
    const primaryEntries = entries.filter(([key]) => !absorbed.has(key));
    if (primaryEntries.length === 0) return null;

    const usedHeaders = new Set<string>();
    const fields: ParsedField[] = [];
    for (let index = 0; index < primaryEntries.length; index += 1) {
      const [key, rawSchema] = primaryEntries[index]!;
      if (!isPlainRecord(rawSchema)) return null;
      const { header, question } = buildHeaderAndQuestion(
        key,
        rawSchema,
        index,
        primaryEntries.length,
        usedHeaders,
      );
      const parsed = parseField({
        key,
        schema: rawSchema,
        otherPairing: paired.get(key),
        header,
        question,
        required: requiredSet.has(key),
      });
      if (!parsed) return null;
      fields.push(parsed);
    }

    const questions = fields.map((field) => field.question);
    // The card submits instead of cancelling when every question is optional free text;
    // name that button for what it does.
    if (questions.every((question) => question.options.length === 0 && question.allowEmpty)) {
      for (const question of questions) question.dismissLabel = SKIP;
    }

    const message = nonEmpty(request.message);
    const title = resolveFormTitle(requestedSchema.title, message, questions);

    return new AcpFormElicitation(
      {
        name: options?.toolName ?? "Question",
        kind: "question",
        title,
        ...(message ? { description: message } : {}),
        input: { questions: questions.map(toJsonQuestion) },
      },
      fields,
    );
  }

  respond(response: ProviderPermissionResponse): CreateElicitationResponse {
    if (response.behavior === "deny") return { action: "decline" };
    const answers = readAnswers(response);
    const entries: Array<[string, ElicitationContentValue]> = [];
    for (const field of this.fields) {
      const header = field.question.header;
      const raw = Object.hasOwn(answers, header) ? answers[header] : undefined;
      const outcome = field.resolve(typeof raw === "string" ? raw : undefined);
      if (!outcome.ok) return { action: "decline" };
      entries.push(...outcome.entries);
    }
    // Object.fromEntries defines own data properties, keeping keys like "__proto__" safe.
    const content: Record<string, ElicitationContentValue> = Object.fromEntries(entries);
    return { action: "accept", content };
  }
}
