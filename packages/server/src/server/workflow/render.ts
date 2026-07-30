import { canonicalJson, type JsonObject } from "./spec.js";

const EXACT_VALUE = /^\s*{{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\s*trim\s*)?}}\s*$/;
const INLINE_VALUE = /{{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\s*trim\s*)?}}/g;
const IF_BLOCK =
  /{%\s*if\s+([A-Za-z_][A-Za-z0-9_.]*)\s*==\s*(["'])(.*?)\2\s*%}([\s\S]*?){%\s*endif\s*%}/g;
const ANY_TAG = /{%\s*([^%]+?)\s*%}/;

export function renderPrompt(template: string, context: JsonObject): string {
  let rendered = template;
  let previous: string;
  do {
    previous = rendered;
    rendered = rendered.replace(
      IF_BLOCK,
      (_, path: string, _quote: string, expected: string, content: string) =>
        resolvePath(context, path) === expected ? content : "",
    );
  } while (rendered !== previous);
  const unsupported = rendered.match(ANY_TAG);
  if (unsupported) {
    throw new Error(`unsupported workflow template tag: ${unsupported[1].trim()}`);
  }
  return renderString(rendered, context);
}

export function renderValue(value: unknown, context: JsonObject): unknown {
  if (typeof value === "string") {
    const exact = value.match(EXACT_VALUE);
    if (exact) {
      return resolvePath(context, exact[1]);
    }
    return renderString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, context)]),
    );
  }
  return value;
}

function renderString(value: string, context: JsonObject): string {
  return value.replace(INLINE_VALUE, (_, path: string) => stringify(resolvePath(context, path)));
}

function resolvePath(context: JsonObject, expression: string): unknown {
  let current: unknown = context;
  for (const part of expression.split(".")) {
    if (!isObject(current) || !(part in current)) {
      throw new Error(`undefined workflow value: ${expression}`);
    }
    current = current[part];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
