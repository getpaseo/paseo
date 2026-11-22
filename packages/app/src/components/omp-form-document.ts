import { DomUtils, ElementType, parseDocument, type DomHandler } from "htmlparser2";

const tags = new Set(
  (
    "p div span h1 h2 h3 h4 h5 h6 strong b em i s code pre blockquote ul ol li dl dt dd hr br small " +
    "table thead tbody tr td th caption fieldset legend label input textarea select optgroup " +
    "option figure figcaption img"
  ).split(" "),
);
const omitted = new Set(["script", "style", "template", "iframe", "object", "embed", "button"]);
const voidTags = new Set(["br", "hr", "img", "input"]);
const inputTypes = new Set(
  (
    "text number date email url tel search password range time datetime-local month week color " +
    "radio checkbox"
  ).split(" "),
);
const attributes: Readonly<Record<string, readonly string[]>> = {
  input:
    "name type value placeholder checked disabled required min max step pattern minlength maxlength".split(
      " ",
    ),
  select: ["name", "multiple", "disabled", "required"],
  option: ["value", "label", "selected", "disabled"],
  optgroup: ["label", "disabled"],
  textarea: ["name", "placeholder", "required", "disabled", "rows", "minlength", "maxlength"],
  label: ["for"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  img: ["src", "alt", "width", "height"],
};
const svgAttributes = (
  "viewbox width height x y dx dy cx cy r rx ry x1 y1 x2 y2 points d fill stroke stroke-width " +
  "transform font-size text-anchor"
).split(" ");
const svgTags = new Set(
  "svg g path rect circle ellipse line polyline polygon text tspan".split(" "),
);
const inlineImage = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
const scriptNonce = "paseo-omp-form";

type HtmlNode = DomHandler["dom"][number];

type FormData = Record<string, string | number | string[]>;
export type OmpFormMessage = { height: number } | { data: FormData } | { cancelled: true };

interface Labels {
  submit: string;
  cancel: string;
  other: string;
  unavailable: string;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function appendAttributes(
  parts: string[],
  tag: string,
  attrs: Record<string, string>,
  type: string,
): void {
  const allowed = svgTags.has(tag) ? svgAttributes : (attributes[tag] ?? []);
  for (const key of ["id", "title", "aria-label", ...allowed]) {
    let value = attrs[key];
    if (key === "type") value = type;
    if (key === "step" && value === undefined && type === "number") value = "any";
    if (value === undefined) continue;
    if (key === "required" && tag === "input" && (type === "checkbox" || type === "radio")) {
      // OMP requires one answer from the group, not every marked checkbox.
      parts.push(" data-required");
    } else {
      parts.push(" ", key, '="', escape(value), '"');
    }
  }
}

// Rebuild the document from recognized elements. Never copy a source tag or attribute name.
function appendNode(node: HtmlNode, parts: string[], depth: number): boolean {
  if (depth > 64) return false;
  if (node.type === ElementType.Text) {
    parts.push(escape(node.data));
    return true;
  }
  if (node.type !== ElementType.Tag || omitted.has(node.name)) return true;
  const tag = node.name;
  const known = tags.has(tag) || svgTags.has(tag);
  const attrs = node.attribs;
  const type = (attrs.type ?? "text").toLowerCase();
  if (tag === "input" && (!attrs.name || !inputTypes.has(type))) return true;
  if (tag === "img" && !inlineImage.test(attrs.src ?? "")) {
    if (attrs.alt) parts.push(escape(attrs.alt));
    return true;
  }
  if (known) {
    parts.push("<", tag);
    appendAttributes(parts, tag, attrs, type);
    parts.push(">");
  }
  if (voidTags.has(tag)) return true;
  for (const child of node.children) {
    if (!appendNode(child, parts, depth + 1)) return false;
  }
  if (known) parts.push("</", tag, ">");
  return true;
}

export function buildOmpFormDocument(html: string, labels: Labels): string {
  const document = parseDocument(html);
  const form = DomUtils.findOne((node) => node.name === "form", document.children);
  const parts: string[] = [];
  if (form && !form.children.every((node) => appendNode(node, parts, 0))) parts.length = 0;
  const fields = parts.join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<style>
:root { color-scheme: light dark; font: 14px system-ui, sans-serif; }
body { margin: 0; padding: 12px; overflow-wrap: anywhere; }
form, fieldset { display: grid; gap: 8px; min-width: 0; }
p, h1, h2, h3, h4, h5, h6, ul, ol, pre { margin: 0; }
pre { white-space: pre-wrap; } img, svg { max-width: 100%; }
fieldset, td, th { border: 1px solid GrayText; } td, th { padding: 4px 8px; }
table { border-collapse: collapse; max-width: 100%; }
button, input, select, textarea { font: inherit; max-width: 100%; }
button { min-height: 30px; } footer { display: flex; justify-content: end; gap: 8px; }
</style></head><body><form autocomplete="off" data-other="${escape(labels.other)}">
${fields || `<p>${escape(labels.unavailable)}</p>`}
<footer><button type="button">${escape(labels.cancel)}</button>${fields ? `<button type="submit">${escape(labels.submit)}</button>` : ""}</footer>
</form><script nonce="${scriptNonce}">${formScript}</script></body></html>`;
}

export function parseOmpFormMessage(value: unknown): OmpFormMessage | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || !value || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.cancelled === true) return { cancelled: true };
  if (typeof message.height === "number" && Number.isFinite(message.height)) {
    return { height: Math.min(480, Math.max(80, Math.ceil(message.height))) };
  }
  const data = message.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (
    Object.values(data).every(
      (item) =>
        typeof item === "string" ||
        (typeof item === "number" && Number.isFinite(item)) ||
        (Array.isArray(item) && item.every((entry) => typeof entry === "string")),
    )
  ) {
    return { data: data as FormData };
  }
  return null;
}

// This script is Paseo's code. Model text only enters the allow-listed markup above.
const formScript = String.raw`
const otherLabel = Element.prototype.getAttribute.call(document.querySelector('form'), 'data-other');
const footer = document.querySelector('footer');
const send = (message) => {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  else window.parent.postMessage(message, '*');
};
const fields = Array.from(document.querySelectorAll('form input[name], form select[name], form textarea[name]'));
const groups = new Map();
for (const field of fields) {
  if (field.type !== 'radio' && field.type !== 'checkbox') continue;
  const key = field.type + '\0' + field.name;
  if (!groups.has(key)) groups.set(key, { name: field.name, fields: [], other: null });
  groups.get(key).fields.push(field);
}
const firstGroups = new Map();
for (const group of groups.values()) {
  const first = group.fields[0];
  const last = group.fields.at(-1);
  firstGroups.set(first, group);
  if (group.fields.length < 2 || group.fields.some((field) =>
    Array.from(field.labels).some((label) => /^\s*other\b/i.test(label.textContent))
    || (!field.labels.length && /^\s*other\b/i.test(field.value)))) continue;
  const label = document.createElement('label');
  label.textContent = otherLabel + ' ';
  const other = document.createElement('input');
  group.other = other;
  label.append(other);
  (last.labels[0] || last).after(label);
  if (first.type === 'radio') {
    other.addEventListener('input', () => {
      if (other.value.trim()) for (const field of group.fields) field.checked = false;
    });
    for (const field of group.fields) field.addEventListener('change', () => {
      if (field.checked) other.value = '';
    });
  }
}
const resize = () => send({ height: document.body.scrollHeight + 2 });
resize();
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(document.body);
footer.querySelector('button').addEventListener('click', () => send({ cancelled: true }));
let invalidField;
document.addEventListener('input', () => {
  invalidField?.setCustomValidity('');
  invalidField = undefined;
});
document.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.create(null);
  for (const field of fields) {
    if (field.type === 'radio' || field.type === 'checkbox') {
      const group = firstGroups.get(field);
      if (!group) continue;
      const values = group.fields.filter((option) => !option.disabled && option.checked).map((option) => option.value);
      const other = group.other?.value.trim();
      if (other && !values.includes(other)) values.push(other);
      if (!values.length && group.fields.some((option) => option.hasAttribute('data-required'))) {
        invalidField = group.fields.find((option) => !option.disabled) || group.other;
        if (invalidField) {
          invalidField.setCustomValidity('Select an answer.');
          invalidField.reportValidity();
        }
        return;
      }
      if (field.type === 'checkbox' && group.fields.length > 1) data[group.name] = values;
      else if (values.length) data[group.name] = values[0];
      continue;
    }
    if (field.disabled) continue;
    if (field instanceof HTMLSelectElement) {
      const selected = Array.from(field.selectedOptions).filter((option) => !option.disabled).map((option) => option.value);
      if (field.multiple && field.options.length > 1) data[field.name] = selected;
      else if (selected.length) data[field.name] = selected[0];
    } else if (field.type === 'number' || field.type === 'range') {
      data[field.name] = Number.isFinite(field.valueAsNumber) ? field.valueAsNumber : '';
    } else {
      data[field.name] = field.value;
    }
  }
  send({ data });
});
`;
