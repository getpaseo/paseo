import { type DefaultTreeAdapterMap, parse } from "parse5";

/**
 * Reads the HTML `<form>` OMP 19.1+ sends with `extension_ui_request` `method: "form"`.
 *
 * It follows OMP's own form parser (`tools/html-form/parse.ts` in `@oh-my-pi/pi-coding-agent`)
 * where the answer depends on it: which controls are fields, option values, defaults,
 * array-versus-single choices and the "Other" free-text answer. OMP validates the reply
 * against its parse and rejects unknown names or option values. Layout is reduced to
 * plain prompt text, because Paseo shows each field as a question-card question.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface OmpFormOption {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
}

export interface OmpFormChoiceField {
  kind: "choice";
  name: string;
  control: "radio" | "checkbox" | "select";
  /** Checkbox group or `<select multiple>`. */
  multi: boolean;
  /** OMP accepts one typed answer beside the options. */
  other: boolean;
  /** Text shown before the field plus its own label. */
  prompt: string;
  options: OmpFormOption[];
  required: boolean;
}

export interface OmpFormTextField {
  kind: "text";
  name: string;
  prompt: string;
  value: string;
  placeholder: string;
  required: boolean;
}

export type OmpFormField = OmpFormChoiceField | OmpFormTextField;

export interface OmpHtmlForm {
  /** One field per control name, in document order. */
  fields: OmpFormField[];
  /** Text after the last field. */
  notes: string;
}

const SKIPPED = new Set([
  "button",
  "head",
  "iframe",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
  "title",
]);
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "legend",
  "li",
  "main",
  "nav",
  "p",
  "section",
  "summary",
]);
const CONTROLS = new Set(["input", "select", "textarea"]);
const IGNORED_INPUTS = new Set(["button", "file", "hidden", "image", "reset", "submit"]);

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isText(node: Node): node is DefaultTreeAdapterMap["textNode"] {
  return node.nodeName === "#text";
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

function hasAttr(element: Element, name: string): boolean {
  return element.attrs.some((item) => item.name === name);
}

function children(node: Node): Node[] {
  return "childNodes" in node ? node.childNodes : [];
}

function findElement(node: Node, match: (element: Element) => boolean): Element | undefined {
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    if (match(child)) return child;
    const found = findElement(child, match);
    if (found) return found;
  }
  return undefined;
}

function collectElements(
  node: Node,
  match: (element: Element) => boolean,
  found: Element[] = [],
): Element[] {
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    if (match(child)) found.push(child);
    collectElements(child, match, found);
  }
  return found;
}

/** Source whitespace, newlines included, renders as one space; only `<br>` breaks a line. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

function normalize(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

/** Visible text of `node`, skipping controls and, inside a label, nested labels. */
function textOf(node: Node, options: { skipLabels?: boolean } = {}): string {
  const parts: string[] = [];
  const visit = (current: Node): void => {
    if (isText(current)) {
      parts.push(collapse(current.value));
      return;
    }
    if (!isElement(current)) return;
    const tag = current.tagName;
    if (SKIPPED.has(tag) || CONTROLS.has(tag)) return;
    if (options.skipLabels && tag === "label") return;
    if (tag === "br") {
      parts.push("\n");
      return;
    }
    if (tag === "img") {
      parts.push(attr(current, "alt") ?? "");
      return;
    }
    if (BLOCK.has(tag)) parts.push(" ");
    for (const child of children(current)) visit(child);
  };
  for (const child of children(node)) visit(child);
  return normalize(parts.join(""));
}

function firstNamed(fields: OmpFormField[]): OmpFormField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.name)) return false;
    seen.add(field.name);
    return true;
  });
}

class FormReader {
  private readonly fields: OmpFormField[] = [];
  private readonly groups = new Map<string, OmpFormChoiceField>();
  private readonly labelFor = new Map<string, Element>();
  private context: string[] = [];
  private inline: string[] = [];

  constructor(private readonly root: Node) {
    const ids = new Set(
      collectElements(root, (element) => CONTROLS.has(element.tagName)).flatMap((control) => {
        const id = attr(control, "id");
        return id ? [id] : [];
      }),
    );
    for (const label of collectElements(root, (element) => element.tagName === "label")) {
      const target = attr(label, "for");
      if (target && ids.has(target) && !this.labelFor.has(target)) {
        this.labelFor.set(target, label);
      }
    }
  }

  read(): OmpHtmlForm {
    this.walk(this.root, undefined);
    this.flush();
    for (const field of this.fields) {
      if (field.kind !== "choice" || field.control === "select" || field.options.length < 2) {
        continue;
      }
      field.other = !field.options.some((option) => /^\s*other\b/i.test(option.label));
    }
    return {
      fields: firstNamed(this.fields.filter((field) => field.name)),
      notes: this.takeContext(),
    };
  }

  private walk(node: Node, label: string | undefined): void {
    for (const child of children(node)) this.visit(child, label);
  }

  private visit(node: Node, label: string | undefined): void {
    if (isText(node)) {
      if (label === undefined) this.inline.push(collapse(node.value));
      return;
    }
    if (!isElement(node)) return;
    const tag = node.tagName;
    if (SKIPPED.has(tag)) return;
    if (CONTROLS.has(tag)) {
      this.control(node, label);
      return;
    }
    if (label !== undefined) {
      if (tag === "label") this.label(node);
      else this.walk(node, label);
      return;
    }
    switch (tag) {
      case "br":
        this.inline.push("\n");
        return;
      case "img":
        this.inline.push(attr(node, "alt") ?? "");
        return;
      case "label":
        this.label(node);
        return;
      case "ul":
      case "ol":
        this.list(node, tag === "ol");
        return;
      case "pre":
        this.flush();
        this.context.push(`\`\`\`\n${rawText(node).replace(/^\n/, "").trimEnd()}\n\`\`\``);
        return;
      case "table":
        this.table(node);
        return;
    }
    if (BLOCK.has(tag)) {
      this.flush();
      this.walk(node, undefined);
      this.flush();
      return;
    }
    this.walk(node, undefined);
  }

  private label(label: Element): void {
    const target = attr(label, "for");
    if (target && this.labelFor.get(target) === label) return;
    if (!findElement(label, (element) => CONTROLS.has(element.tagName))) {
      this.walk(label, undefined);
      return;
    }
    this.flush();
    this.walk(label, textOf(label, { skipLabels: true }));
  }

  private list(list: Element, ordered: boolean): void {
    this.flush();
    if (findElement(list, (element) => CONTROLS.has(element.tagName))) {
      this.walk(list, undefined);
      this.flush();
      return;
    }
    const items = children(list)
      .filter((child): child is Element => isElement(child) && child.tagName === "li")
      .map((item) => textOf(item))
      .filter(Boolean);
    const lines = items.map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${item}`);
    if (lines.length > 0) this.context.push(lines.join("\n"));
  }

  private table(table: Element): void {
    this.flush();
    if (findElement(table, (element) => CONTROLS.has(element.tagName))) {
      // A table of controls is layout: each cell reads as its own block.
      for (const cell of collectElements(table, (element) => /^t[dh]$/.test(element.tagName))) {
        this.walk(cell, undefined);
        this.flush();
      }
      return;
    }
    const rows = collectElements(table, (element) => element.tagName === "tr")
      .map((row) =>
        children(row)
          .filter((cell): cell is Element => isElement(cell) && /^t[dh]$/.test(cell.tagName))
          .map((cell) => textOf(cell))
          .join(" | "),
      )
      .filter(Boolean);
    if (rows.length > 0) this.context.push(rows.join("\n"));
  }

  private control(control: Element, wrapping: string | undefined): void {
    this.flush();
    const label = wrapping || this.detachedLabel(control);
    const name = attr(control, "name") ?? "";
    const required = hasAttr(control, "required");
    const tag = control.tagName;
    if (tag === "select") {
      const multi = hasAttr(control, "multiple");
      const options = collectElements(control, (element) => element.tagName === "option").map(
        (option) => {
          // Same text OMP derives an option's value from when `value` is absent.
          const text = rawText(option).replace(/\s+/g, " ").trim();
          return {
            value: attr(option, "value") ?? text,
            label: text,
            checked: hasAttr(option, "selected"),
            disabled: hasAttr(option, "disabled"),
          };
        },
      );
      // A single select always has a selection: the first enabled option unless one is marked.
      if (!multi && !options.some((option) => option.checked)) {
        const first = options.find((option) => !option.disabled);
        if (first) first.checked = true;
      }
      this.addField({
        kind: "choice",
        name,
        control: "select",
        multi,
        other: false,
        prompt: this.prompt(label),
        options,
        required,
      });
      return;
    }
    if (tag === "textarea") {
      this.addField({
        kind: "text",
        name,
        prompt: this.prompt(label),
        value: rawText(control).replace(/^\r?\n/, ""),
        placeholder: attr(control, "placeholder") ?? "",
        required,
      });
      return;
    }
    const type = (attr(control, "type") ?? "text").toLowerCase();
    if (IGNORED_INPUTS.has(type)) return;
    const value = attr(control, "value");
    if (type === "radio" || type === "checkbox") {
      const option = {
        value: value ?? "on",
        label: label || value || name,
        checked: hasAttr(control, "checked"),
        disabled: hasAttr(control, "disabled"),
      };
      const key = `${type}\0${name}`;
      const group = this.groups.get(key);
      if (group) {
        group.options.push(option);
        group.required ||= required;
        return;
      }
      const field: OmpFormChoiceField = {
        kind: "choice",
        name,
        control: type,
        multi: type === "checkbox",
        other: false,
        prompt: this.prompt(""),
        options: [option],
        required,
      };
      this.groups.set(key, field);
      this.addField(field);
      return;
    }
    this.addField({
      kind: "text",
      name,
      prompt: this.prompt(label),
      value: value ?? "",
      placeholder: attr(control, "placeholder") ?? "",
      required,
    });
  }

  /** Label of a control outside any wrapping `<label>`: `<label for>`, then `aria-label`, `title`. */
  private detachedLabel(control: Element): string {
    const id = attr(control, "id");
    const label = id ? this.labelFor.get(id) : undefined;
    if (label) return textOf(label, { skipLabels: true });
    return normalize(attr(control, "aria-label") ?? attr(control, "title") ?? "");
  }

  private prompt(label: string): string {
    return [this.takeContext(), label].filter(Boolean).join("\n\n");
  }

  private takeContext(): string {
    const text = this.context.join("\n\n");
    this.context = [];
    return text;
  }

  private flush(): void {
    const text = normalize(this.inline.join(""));
    this.inline = [];
    if (text) this.context.push(text);
  }

  private addField(field: OmpFormField): void {
    this.fields.push(field);
  }
}

function rawText(node: Node): string {
  return children(node)
    .map((child) => (isText(child) ? child.value : rawText(child)))
    .join("");
}

/** Parse agent-written form HTML; content outside the first `<form>` is ignored when one exists. */
export function parseOmpHtmlForm(html: string): OmpHtmlForm {
  const document = parse(html);
  const root = findElement(document, (element) => element.tagName === "form") ?? document;
  return new FormReader(root).read();
}
