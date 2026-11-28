export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonSchema = JsonObject;

export type ExprPath =
  | { readonly namespace: "event"; readonly path: readonly string[] }
  | { readonly namespace: "inputs"; readonly name: string }
  | { readonly namespace: "subject"; readonly field: "key" }
  | { readonly namespace: "subject"; readonly field: "data"; readonly path: readonly string[] }
  | { readonly namespace: "steps"; readonly stepId: string; readonly field: "outcome" | "attempts" }
  | {
      readonly namespace: "steps";
      readonly stepId: string;
      readonly field: "outputs";
      readonly path: readonly string[];
    }
  | { readonly namespace: "gate"; readonly field: "choice" | "note" | "actor" }
  | { readonly namespace: "execution"; readonly field: "id" }
  | { readonly namespace: "paseo"; readonly field: "prompt" }
  | { readonly namespace: "values"; readonly name: string };

export type BinaryOperator = "==" | "!=" | "&&" | "||" | "??";

export type ExprNode =
  | { readonly kind: "literal"; readonly value: JsonValue }
  | { readonly kind: "path"; readonly path: ExprPath }
  | { readonly kind: "not"; readonly value: ExprNode }
  | {
      readonly kind: "binary";
      readonly operator: BinaryOperator;
      readonly left: ExprNode;
      readonly right: ExprNode;
    }
  | { readonly kind: "template"; readonly parts: readonly (string | ExprNode)[] };

export interface StepEvalState {
  readonly outcome: string | null;
  readonly outputs: JsonObject | null;
  readonly attempts: number;
}

export interface GateEvalState {
  readonly choice: string | null;
  readonly note: string | null;
  readonly actor: string | null;
}

export interface ExpressionContext {
  readonly event: JsonValue;
  readonly prompt: string;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly subject: {
    readonly key: string | null;
    readonly data: JsonObject;
  };
  readonly steps: Readonly<Record<string, StepEvalState>>;
  readonly gate: GateEvalState;
  readonly values: Readonly<Record<string, ExprNode>>;
  readonly executionId: string | null;
}

export class ExpressionSyntaxError extends Error {
  constructor(message: string) {
    super(`invalid workflow expression: ${message}`);
    this.name = "ExpressionSyntaxError";
  }
}

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(`workflow expression could not be evaluated: ${message}`);
    this.name = "ExpressionEvaluationError";
  }
}

type Operator = "!" | BinaryOperator;

type Token =
  | { readonly kind: "literal"; readonly value: JsonValue }
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "operator"; readonly value: Operator }
  | { readonly kind: "dot" }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "array-left" }
  | { readonly kind: "array-right" }
  | { readonly kind: "object-left" }
  | { readonly kind: "object-right" }
  | { readonly kind: "comma" }
  | { readonly kind: "colon" }
  | { readonly kind: "end" };

const TOKEN_PATTERN =
  /\s*(?:(true|false|null)\b|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([a-zA-Z_][a-zA-Z0-9_-]*)|(!=|==|&&|\|\||\?\?|!)|(\.)|(\()|(\))|(\[)|(\])|(\{)|(\})|(,)|(:)|(.))/gy;

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}

export function parseExprPath(dotted: string): ExprPath {
  const parts = dotted
    .trim()
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    throw new ExpressionSyntaxError("empty reference path");
  }
  return parsePathSegments(parts);
}

export function parseExpression(source: string): ExprNode {
  const text = unwrapExpression(source);
  const tokens = tokenize(text);
  let index = 0;

  const parse = (minimumPrecedence = 0): ExprNode => {
    let left = parsePrefix();
    while (true) {
      const token = tokens[index];
      if (token?.kind !== "operator" || token.value === "!") {
        break;
      }
      const operator = token.value;
      const precedence = operatorPrecedence(operator);
      if (precedence < minimumPrecedence) {
        break;
      }
      index += 1;
      const right = parse(precedence + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  };

  const parsePrefix = (): ExprNode => {
    const token = tokens[index++];
    if (token === undefined) {
      throw new ExpressionSyntaxError("expression ended unexpectedly");
    }
    if (token.kind === "literal") {
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "operator" && token.value === "!") {
      return { kind: "not", value: parsePrefix() };
    }
    if (token.kind === "left") {
      const inner = parse();
      if (tokens[index]?.kind !== "right") {
        throw new ExpressionSyntaxError("missing ')'");
      }
      index += 1;
      return inner;
    }
    if (token.kind === "array-left") {
      return parseArrayLiteral();
    }
    if (token.kind === "object-left") {
      return parseObjectLiteral();
    }
    if (token.kind !== "identifier") {
      throw new ExpressionSyntaxError("expected a value");
    }
    return parsePath(token.value);
  };

  const result = parse();
  if (tokens[index]?.kind !== "end") {
    throw new ExpressionSyntaxError("unexpected trailing token");
  }
  return result;

  function parsePath(first: string): ExprNode {
    const parts = [first];
    while (tokens[index]?.kind === "dot") {
      index += 1;
      const next = tokens[index++];
      if (next?.kind !== "identifier") {
        throw new ExpressionSyntaxError("expected path segment");
      }
      parts.push(next.value);
    }
    return { kind: "path", path: parsePathSegments(parts) };
  }

  function parseArrayLiteral(): ExprNode {
    const values: JsonValue[] = [];
    if (tokens[index]?.kind === "array-right") {
      index += 1;
      return { kind: "literal", value: values };
    }
    while (true) {
      values.push(readJsonLiteral());
      const separator = tokens[index++];
      if (separator?.kind === "array-right") {
        break;
      }
      if (separator?.kind !== "comma") {
        throw new ExpressionSyntaxError("expected ',' or ']'");
      }
      if (tokens[index]?.kind === "array-right") {
        throw new ExpressionSyntaxError("trailing comma in array literal");
      }
    }
    return { kind: "literal", value: values };
  }

  function parseObjectLiteral(): ExprNode {
    const value: Record<string, JsonValue> = {};
    if (tokens[index]?.kind === "object-right") {
      index += 1;
      return { kind: "literal", value };
    }
    while (true) {
      const key = tokens[index++];
      if (key?.kind !== "literal" || typeof key.value !== "string") {
        throw new ExpressionSyntaxError("object keys must be strings");
      }
      if (tokens[index++]?.kind !== "colon") {
        throw new ExpressionSyntaxError("expected ':'");
      }
      value[key.value] = readJsonLiteral();
      const separator = tokens[index++];
      if (separator?.kind === "object-right") {
        break;
      }
      if (separator?.kind !== "comma") {
        throw new ExpressionSyntaxError("expected ',' or '}'");
      }
      if (tokens[index]?.kind === "object-right") {
        throw new ExpressionSyntaxError("trailing comma in object literal");
      }
    }
    return { kind: "literal", value };
  }

  function readJsonLiteral(): JsonValue {
    const expression = parsePrefix();
    if (expression.kind !== "literal") {
      throw new ExpressionSyntaxError("JSON literals cannot contain paths or operators");
    }
    return expression.value;
  }
}

/**
 * Parse a string containing zero, one, or many `${{ ... }}` or `{{ ... }}` interpolations into
 * a canonical `ExprNode`.
 * - A plain string with no interpolations becomes `{ kind: "literal", value }`.
 * - A string whose entire content is a single interpolation becomes that inner `ExprNode`
 *   (preserving typed non-string values such as numbers, booleans, arrays, or objects).
 * - A mixed template becomes `{ kind: "template", parts }` with adjacent strings merged.
 */
export function parseTemplateExpression(template: string): ExprNode {
  const parts: (string | ExprNode)[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const next = findNextInterpolation(template, cursor);
    if (next === undefined) {
      parts.push(template.slice(cursor));
      break;
    }
    if (next.start > cursor) {
      parts.push(template.slice(cursor, next.start));
    }
    const end = template.indexOf("}}", next.exprStart);
    if (end < 0) {
      throw new ExpressionSyntaxError("unterminated template interpolation");
    }
    const exprText = template.slice(next.exprStart, end).trim();
    if (exprText.length === 0) {
      throw new ExpressionSyntaxError("empty template interpolation");
    }
    parts.push(parseExpression(exprText));
    cursor = end + 2;
  }

  return normalizeTemplateParts(parts);
}

/** Build a canonical `ExprNode` from template literal segments and expressions. */
export function buildTemplateExpr(parts: readonly (string | ExprNode)[]): ExprNode {
  return normalizeTemplateParts(parts);
}

function appendTemplatePart(merged: (string | ExprNode)[], part: string | ExprNode): void {
  if (typeof part === "string") {
    if (part.length === 0) {
      return;
    }
    const prev = merged[merged.length - 1];
    if (typeof prev === "string") {
      merged[merged.length - 1] = prev + part;
    } else {
      merged.push(part);
    }
    return;
  }
  if (part.kind === "template") {
    for (const nested of part.parts) {
      appendTemplatePart(merged, nested);
    }
    return;
  }
  merged.push(part);
}

export function normalizeTemplateParts(rawParts: readonly (string | ExprNode)[]): ExprNode {
  const merged: (string | ExprNode)[] = [];
  for (const part of rawParts) {
    appendTemplatePart(merged, part);
  }

  if (merged.length === 0) {
    return { kind: "literal", value: "" };
  }
  if (merged.length === 1) {
    const sole = merged[0]!;
    return typeof sole === "string" ? { kind: "literal", value: sole } : sole;
  }
  return { kind: "template", parts: merged };
}

export function collectExprPaths(expression: ExprNode): ExprPath[] {
  switch (expression.kind) {
    case "literal":
      return [];
    case "path":
      return [expression.path];
    case "not":
      return collectExprPaths(expression.value);
    case "binary":
      return [...collectExprPaths(expression.left), ...collectExprPaths(expression.right)];
    case "template": {
      const paths: ExprPath[] = [];
      for (const part of expression.parts) {
        if (typeof part !== "string") {
          paths.push(...collectExprPaths(part));
        }
      }
      return paths;
    }
  }
}

export function evaluateExpression(expression: ExprNode, context: ExpressionContext): JsonValue {
  return evaluateInternal(expression, context, new Set());
}

export function evaluateStringExpression(expression: ExprNode, context: ExpressionContext): string {
  const value = evaluateExpression(expression, context);
  return formatInterpolatedValue(value);
}

function evaluateInternal(
  expression: ExprNode,
  context: ExpressionContext,
  seenValues: Set<string>,
): JsonValue {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "path":
      return readPath(expression.path, context, seenValues);
    case "not":
      return !isTruthy(evaluateInternal(expression.value, context, seenValues));
    case "binary": {
      const left = evaluateInternal(expression.left, context, seenValues);
      if (expression.operator === "&&") {
        return isTruthy(left) ? evaluateInternal(expression.right, context, seenValues) : left;
      }
      if (expression.operator === "||") {
        return isTruthy(left) ? left : evaluateInternal(expression.right, context, seenValues);
      }
      if (expression.operator === "??") {
        return left === null ? evaluateInternal(expression.right, context, seenValues) : left;
      }
      const right = evaluateInternal(expression.right, context, seenValues);
      if (expression.operator === "==") {
        return sameJsonValue(left, right);
      }
      return !sameJsonValue(left, right);
    }
    case "template": {
      let output = "";
      for (const part of expression.parts) {
        if (typeof part === "string") {
          output += part;
        } else {
          output += formatInterpolatedValue(evaluateInternal(part, context, seenValues));
        }
      }
      return output;
    }
  }
}

function readPath(path: ExprPath, context: ExpressionContext, seenValues: Set<string>): JsonValue {
  switch (path.namespace) {
    case "event":
      return readNestedValue(context.event, path.path);
    case "inputs":
      return context.inputs[path.name] ?? null;
    case "subject":
      if (path.field === "key") {
        return context.subject.key;
      }
      return readNestedValue(context.subject.data, path.path);
    case "steps": {
      const step = context.steps[path.stepId];
      if (step === undefined) {
        return path.field === "attempts" ? 0 : null;
      }
      if (path.field === "outputs") {
        if (step.outputs === null) {
          return null;
        }
        return readNestedValue(step.outputs, path.path);
      }
      if (path.field === "outcome") {
        return step.outcome;
      }
      return step.attempts;
    }
    case "gate":
      return context.gate[path.field];
    case "execution":
      return context.executionId;
    case "paseo":
      return context.prompt;
    case "values": {
      const valueExpr = context.values[path.name];
      if (valueExpr === undefined) {
        throw new ExpressionEvaluationError(`value ${path.name} is unavailable`);
      }
      if (seenValues.has(path.name)) {
        throw new ExpressionEvaluationError(`cyclic value reference: ${path.name}`);
      }
      seenValues.add(path.name);
      try {
        return evaluateInternal(valueExpr, context, seenValues);
      } finally {
        seenValues.delete(path.name);
      }
    }
  }
}

function readNestedValue(root: JsonValue, segments: readonly string[]): JsonValue {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return null;
    }
    if (!Object.hasOwn(current, segment)) {
      return null;
    }
    current = Reflect.get(current, segment);
  }
  if (current === undefined) {
    return null;
  }
  if (!isJsonValue(current)) {
    throw new ExpressionEvaluationError("path resolved to a non-JSON value");
  }
  return current;
}

function parseSubjectPath(parts: readonly string[]): ExprPath {
  if (parts[1] === "key" && parts.length === 2) {
    return { namespace: "subject", field: "key" };
  }
  if (parts[1] === "data" && parts.length >= 3) {
    return { namespace: "subject", field: "data", path: parts.slice(2) };
  }
  throw new ExpressionSyntaxError(`unsupported path ${parts.join(".")}`);
}

function parseStepsPath(parts: readonly string[]): ExprPath {
  if (parts.length < 3) {
    throw new ExpressionSyntaxError(`unsupported path ${parts.join(".")}`);
  }
  const stepId = parts[1]!;
  const field = parts[2];
  if ((field === "outcome" || field === "attempts") && parts.length === 3) {
    return { namespace: "steps", stepId, field };
  }
  if (field === "outputs" && parts.length >= 4) {
    return { namespace: "steps", stepId, field: "outputs", path: parts.slice(3) };
  }
  throw new ExpressionSyntaxError(`unsupported path ${parts.join(".")}`);
}

function parsePaseoAliasPath(parts: readonly string[]): ExprPath {
  if (parts[1] === "prompt" && parts.length === 2) {
    return { namespace: "paseo", field: "prompt" };
  }
  if (parts[1] === "context") {
    return { namespace: "event", path: parts.slice(2) };
  }
  if (parts[1] === "inputs" && parts.length === 3) {
    return { namespace: "inputs", name: parts[2]! };
  }
  if (parts[1] === "execution" && parts[2] === "id" && parts.length === 3) {
    return { namespace: "execution", field: "id" };
  }
  throw new ExpressionSyntaxError(`unsupported path ${parts.join(".")}`);
}

function parsePathSegments(parts: readonly string[]): ExprPath {
  switch (parts[0]) {
    case "event":
      return { namespace: "event", path: parts.slice(1) };
    case "inputs":
      if (parts.length === 2) return { namespace: "inputs", name: parts[1]! };
      break;
    case "subject":
      return parseSubjectPath(parts);
    case "steps":
      return parseStepsPath(parts);
    case "gate":
      if (
        parts.length === 2 &&
        (parts[1] === "choice" || parts[1] === "note" || parts[1] === "actor")
      ) {
        return { namespace: "gate", field: parts[1] };
      }
      break;
    case "execution":
      if (parts.length === 2 && parts[1] === "id") return { namespace: "execution", field: "id" };
      break;
    case "values":
      if (parts.length === 2) return { namespace: "values", name: parts[1]! };
      break;
    case "paseo":
      return parsePaseoAliasPath(parts);
  }
  throw new ExpressionSyntaxError(`unsupported path ${parts.join(".")}`);
}

function findNextInterpolation(
  template: string,
  fromIndex: number,
): { readonly start: number; readonly exprStart: number } | undefined {
  const dollarIdx = template.indexOf("${{", fromIndex);
  const bareIdx = template.indexOf("{{", fromIndex);

  if (dollarIdx < 0 && bareIdx < 0) {
    return undefined;
  }
  if (dollarIdx >= 0 && (bareIdx < 0 || dollarIdx <= bareIdx)) {
    return { start: dollarIdx, exprStart: dollarIdx + 3 };
  }
  // If bareIdx is immediately preceded by '$', it is actually a '${{' delimiter.
  if (bareIdx > 0 && template[bareIdx - 1] === "$") {
    return { start: bareIdx - 1, exprStart: bareIdx + 2 };
  }
  return { start: bareIdx, exprStart: bareIdx + 2 };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  while (TOKEN_PATTERN.lastIndex < source.length) {
    const match = TOKEN_PATTERN.exec(source);
    if (match === null) {
      throw new ExpressionSyntaxError("unexpected character");
    }
    const token = tokenFromMatch(match);
    if (token !== undefined) {
      tokens.push(token);
    }
  }
  tokens.push({ kind: "end" });
  return tokens;
}

function tokenFromMatch(match: RegExpExecArray): Token | undefined {
  const [
    raw,
    word,
    numberLiteral,
    stringLiteral,
    identifier,
    operator,
    dot,
    left,
    right,
    arrayLeft,
    arrayRight,
    objectLeft,
    objectRight,
    comma,
    colon,
    other,
  ] = match;
  if (other !== undefined) {
    throw new ExpressionSyntaxError(`unexpected token ${other}`);
  }
  if (word !== undefined) {
    let value: JsonValue = null;
    if (word === "true") {
      value = true;
    } else if (word === "false") {
      value = false;
    }
    return { kind: "literal", value };
  }
  if (numberLiteral !== undefined) {
    return { kind: "literal", value: Number(numberLiteral) };
  }
  if (stringLiteral !== undefined) {
    return { kind: "literal", value: parseStringLiteral(stringLiteral) };
  }
  if (identifier !== undefined) {
    return { kind: "identifier", value: identifier };
  }
  if (operator !== undefined && isOperator(operator)) {
    return { kind: "operator", value: operator };
  }
  if (dot !== undefined) {
    return { kind: "dot" };
  }
  if (left !== undefined) {
    return { kind: "left" };
  }
  if (right !== undefined) {
    return { kind: "right" };
  }
  if (arrayLeft !== undefined) {
    return { kind: "array-left" };
  }
  if (arrayRight !== undefined) {
    return { kind: "array-right" };
  }
  if (objectLeft !== undefined) {
    return { kind: "object-left" };
  }
  if (objectRight !== undefined) {
    return { kind: "object-right" };
  }
  if (comma !== undefined) {
    return { kind: "comma" };
  }
  if (colon !== undefined) {
    return { kind: "colon" };
  }
  if (raw.trim() === "") {
    return undefined;
  }
  throw new ExpressionSyntaxError("unexpected token");
}

function parseStringLiteral(value: string): string {
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") {
      throw new ExpressionSyntaxError("invalid string literal");
    }
    return parsed;
  }
  return value.slice(1, -1).replace(/\\([\\'])/gu, "$1");
}

function isOperator(value: string): value is Operator {
  return (
    value === "!" ||
    value === "==" ||
    value === "!=" ||
    value === "&&" ||
    value === "||" ||
    value === "??"
  );
}

function unwrapExpression(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("${{")) {
    if (!trimmed.endsWith("}}")) {
      throw new ExpressionSyntaxError("unterminated expression");
    }
    return trimmed.slice(3, -2).trim();
  }
  if (trimmed.startsWith("{{")) {
    if (!trimmed.endsWith("}}")) {
      throw new ExpressionSyntaxError("unterminated expression");
    }
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function operatorPrecedence(operator: BinaryOperator): number {
  if (operator === "??") {
    return 1;
  }
  if (operator === "||") {
    return 2;
  }
  if (operator === "&&") {
    return 3;
  }
  return 4;
}

function isTruthy(value: JsonValue): boolean {
  return value !== false && value !== null && value !== 0 && value !== "";
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (typeof left !== typeof right) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatInterpolatedValue(value: JsonValue): string {
  if (value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
