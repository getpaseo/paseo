import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../../agent-sdk-types.js";
import { splitMultiSelectAnswer } from "../question-card-answer.js";
import {
  type OmpFormChoiceField,
  type OmpFormField,
  type OmpFormOption,
  parseOmpHtmlForm,
} from "./html-form.js";
import type { OmpExtensionUiResponse, OmpFormData, OmpFormValue } from "./rpc-types.js";

const DEFAULT = "Default";
const YES = "Yes";
const NO = "No";
const CONTINUE = "Continue";
const RESPONSE_HEADER = "Response";
const SKIP = "Skip";
const NONE = "None";
const NO_SELECTION = "No selection";

interface CardOption {
  label: string;
  description?: string;
}

interface CardQuestion {
  question: string;
  header: string;
  options: CardOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

/** One form field as a card question, and how the card's answer becomes the field's value. */
interface FieldQuestion {
  name: string;
  question: CardQuestion;
  value(answer: string | undefined): OmpFormValue | undefined;
}

function cardOption(label: string, isDefault: boolean): CardOption {
  return isDefault ? { label, description: DEFAULT } : { label };
}

/**
 * Labels the card answers with must be unique within a question. The card joins
 * multi-select labels with ", ", so those labels must not contain ", " or one
 * selection could read as another ("US", "Canada" versus "US, Canada").
 */
function labelOptions(
  options: OmpFormOption[],
  multi: boolean,
): Array<OmpFormOption & { cardLabel: string }> {
  const used = new Set<string>();
  return options.map((option, index) => {
    const label = option.label || option.value;
    let cardLabel = multi ? label.replaceAll(", ", ",") : label;
    if (used.has(cardLabel)) cardLabel = `${cardLabel} (${option.value})`;
    if (used.has(cardLabel)) cardLabel = `${cardLabel} ${index + 1}`;
    used.add(cardLabel);
    return { ...option, cardLabel };
  });
}

function noneLabel(taken: Map<string, string>): string {
  return taken.has(NONE) ? NO_SELECTION : NONE;
}

/** A lone checkbox is a yes/no question: checked gives its value, unchecked omits it. */
function checkboxQuestion(field: OmpFormChoiceField, option: OmpFormOption): FieldQuestion {
  return {
    name: field.name,
    question: {
      question: [field.prompt, option.label].filter(Boolean).join("\n\n") || field.name,
      header: field.name,
      options: [cardOption(YES, option.checked), cardOption(NO, false)],
      multiSelect: false,
      allowOther: false,
      allowEmpty: option.checked,
    },
    value(answer) {
      const checked = answer === undefined ? option.checked : answer === YES;
      return checked && !option.disabled ? option.value : undefined;
    },
  };
}

function choiceQuestion(field: OmpFormChoiceField): FieldQuestion {
  const enabled = field.options.filter((option) => !option.disabled);
  if (field.control === "checkbox" && field.options.length === 1 && enabled[0]) {
    return checkboxQuestion(field, enabled[0]);
  }
  // OMP reports an array for checkbox groups and multi-selects of two or more options.
  const array = field.multi && field.options.length > 1;
  const options = labelOptions(enabled, array);
  const defaults = options.filter((option) => option.checked).map((option) => option.value);
  const valueOf = new Map(options.map((option) => [option.cardLabel, option.value]));
  // The card submits zero choices only beside a text input, so an optional
  // multi-select without Other gets an explicit None choice.
  const needsNone = array && !field.other && !field.required;
  const none = needsNone ? noneLabel(valueOf) : undefined;
  const labels = [...valueOf.keys(), ...(none ? [none] : [])];
  return {
    name: field.name,
    question: {
      question: field.prompt || field.name,
      header: field.name,
      options: [
        ...options.map((option) => cardOption(option.cardLabel, option.checked)),
        ...(none ? [{ label: none }] : []),
      ],
      multiSelect: array,
      allowOther: field.other,
      // The card honors this only beside a text input, that is when the field offers Other.
      allowEmpty: array || defaults.length > 0 || !field.required,
    },
    value(answer) {
      const typed = answer?.trim();
      if (!typed) return array ? defaults : defaults[0];
      if (!array) return valueOf.get(typed) ?? (field.other ? typed : defaults[0]);
      const { selected, custom } = splitMultiSelectAnswer(typed, labels);
      const values = selected.flatMap((label) => valueOf.get(label) ?? []);
      return field.other && custom && !values.includes(custom) ? [...values, custom] : values;
    },
  };
}

function fieldQuestion(field: OmpFormField): FieldQuestion {
  if (field.kind === "choice") return choiceQuestion(field);
  // A prefilled value is a one-tap option beside the text input.
  const prefilled = field.value !== "";
  return {
    name: field.name,
    question: {
      question: field.prompt || field.name,
      header: field.name,
      options: prefilled ? [cardOption(field.value, true)] : [],
      multiSelect: false,
      allowOther: prefilled,
      allowEmpty: prefilled || !field.required,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    },
    value(answer) {
      return answer || field.value;
    },
  };
}

/** A form without answerable fields still needs a reply: Continue submits empty data. */
function continueQuestion(text: string): FieldQuestion {
  return {
    name: "",
    question: {
      question: text || "Continue?",
      header: RESPONSE_HEADER,
      options: [{ label: CONTINUE }],
      multiSelect: false,
      allowOther: false,
      allowEmpty: false,
    },
    value: () => undefined,
  };
}

function readAnswers(response: AgentPermissionResponse): Record<string, unknown> {
  const answers = response.behavior === "allow" ? response.updatedInput?.answers : undefined;
  return typeof answers === "object" && answers !== null && !Array.isArray(answers)
    ? (answers as Record<string, unknown>)
    : {};
}

/** An OMP `form` request shown as one Paseo question per named form control. */
export class OmpFormQuestion {
  private constructor(
    readonly request: AgentPermissionRequest,
    private readonly fields: FieldQuestion[],
  ) {}

  static fromHtml(input: { id: string; html: string; provider: AgentProvider }): OmpFormQuestion {
    const form = parseOmpHtmlForm(input.html);
    const fields = form.fields.map(fieldQuestion);
    const last = fields.at(-1);
    if (!last) fields.push(continueQuestion(form.notes));
    else if (form.notes) last.question.question = `${last.question.question}\n\n${form.notes}`;
    const questions = fields.map((field) => field.question);
    // The card submits instead of cancelling when every question is optional free text;
    // name that button for what it does.
    if (questions.every((question) => question.options.length === 0 && question.allowEmpty)) {
      for (const question of questions) question.dismissLabel = SKIP;
    }
    return new OmpFormQuestion(
      {
        id: input.id,
        provider: input.provider,
        name: "OMP ask",
        kind: "question",
        title: questions[0]?.question.split("\n")[0] ?? "OMP ask",
        input: { questions },
        metadata: { extensionUiMethod: "form" },
      },
      fields,
    );
  }

  /** The reply OMP validates against its own parse of the same HTML. */
  response(response: AgentPermissionResponse): OmpExtensionUiResponse {
    if (response.behavior === "deny") return { cancelled: true };
    const answers = readAnswers(response);
    const entries = this.fields.flatMap((field): Array<[string, OmpFormValue]> => {
      const header = field.question.header;
      const answer = Object.hasOwn(answers, header) ? answers[header] : undefined;
      const value = field.value(typeof answer === "string" ? answer : undefined);
      return value === undefined ? [] : [[field.name, value]];
    });
    // fromEntries defines own keys, so a control named `__proto__` stays a field.
    const data: OmpFormData = Object.fromEntries(entries);
    return { data };
  }
}
