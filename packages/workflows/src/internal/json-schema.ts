import AjvImport, { type ErrorObject, type ValidateFunction } from "ajv";
import { z } from "zod";
import { isJsonObject, isJsonValue, type JsonSchema, type JsonValue } from "./expression.js";

interface AjvInstance {
  compile(schema: JsonSchema): ValidateFunction;
}

type AjvConstructor = new (options?: {
  readonly allErrors?: boolean;
  readonly strict?: boolean;
}) => AjvInstance;

function resolveAjvConstructor(): AjvConstructor {
  const mod: unknown = AjvImport;
  if (typeof mod === "function") {
    return mod as unknown as AjvConstructor;
  }
  if (typeof mod === "object" && mod !== null && "default" in mod) {
    const inner = (mod as { readonly default: unknown }).default;
    if (typeof inner === "function") {
      return inner as unknown as AjvConstructor;
    }
  }
  throw new Error("unable to resolve Ajv constructor");
}

const AjvCtor = resolveAjvConstructor();

export interface CompiledJsonSchema {
  readonly validate: ValidateFunction;
  readonly schema: JsonSchema;
}

export function normalizeJsonSchema(schema: JsonSchema): JsonSchema {
  const cloned = structuredClone(schema) as Record<string, unknown>;
  delete cloned["$schema"];
  if (!isJsonObject(cloned)) {
    throw new Error("JSON Schema must be a plain JSON object");
  }
  return cloned;
}

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete raw["$schema"];
  if (!isJsonObject(raw)) {
    throw new Error("compiled Zod schema is not a plain JSON object");
  }
  return raw;
}

export function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

export function compileJsonSchema(schema: JsonSchema): CompiledJsonSchema {
  const normalized = normalizeJsonSchema(schema);
  const ajv = new AjvCtor({ allErrors: true, strict: true });
  return {
    schema: normalized,
    validate: ajv.compile(normalized),
  };
}

export function validateAgainstSchema(
  schema: JsonSchema | z.ZodType,
  value: unknown,
  prefix = "value",
): { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] } {
  if (isZodSchema(schema)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      return { ok: true };
    }
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? prefix : `${prefix}.${issue.path.join(".")}`;
        return `${path} ${issue.message}`;
      }),
    };
  }
  const compiled = compileJsonSchema(schema);
  if (compiled.validate(value)) {
    return { ok: true };
  }
  return {
    ok: false,
    errors: formatJsonSchemaErrors(compiled.validate.errors, prefix),
  };
}

export function formatJsonSchemaErrors(
  errors: readonly ErrorObject[] | null | undefined,
  prefix = "output",
): string[] {
  return (errors ?? []).map((error) => {
    const path = error.instancePath === "" ? prefix : `${prefix}${error.instancePath}`;
    return `${path} ${error.message ?? "is invalid"}`;
  });
}

export function finiteSchemaChoices(
  schema: JsonSchema,
  path: readonly string[],
): readonly JsonValue[] | undefined {
  const node = resolveSchemaAtPath(schema, path, schema, new Set());
  if (node === undefined) {
    return undefined;
  }
  return finiteChoices(node, schema, new Set());
}

function resolveSchemaAtPath(
  schema: unknown,
  path: readonly string[],
  root: unknown,
  seen: Set<unknown>,
): unknown {
  const resolved = resolveSchema(schema, root, seen);
  if (resolved === undefined) {
    return undefined;
  }
  if (path.length === 0) {
    return resolved;
  }
  if (!isRecord(resolved)) {
    return undefined;
  }
  const properties = resolved["properties"];
  if (!isRecord(properties)) {
    return undefined;
  }
  return resolveSchemaAtPath(properties[path[0]!], path.slice(1), root, seen);
}

function finiteChoices(
  schema: unknown,
  root: unknown,
  seen: Set<unknown>,
): readonly JsonValue[] | undefined {
  const resolved = resolveSchema(schema, root, seen);
  if (!isRecord(resolved)) {
    return undefined;
  }
  if (Array.isArray(resolved["enum"]) && resolved["enum"].length > 0) {
    return resolved["enum"].filter(isJsonValue);
  }
  if (isJsonValue(resolved["const"])) {
    return [resolved["const"]];
  }
  return undefined;
}

function resolveSchema(schema: unknown, root: unknown, seen: Set<unknown>): unknown {
  if (!isRecord(schema)) {
    return undefined;
  }
  if (typeof schema["$ref"] !== "string") {
    return schema;
  }
  if (seen.has(schema)) {
    return undefined;
  }
  seen.add(schema);
  const target = resolveLocalReference(root, schema["$ref"]);
  return target === undefined ? undefined : resolveSchema(target, root, seen);
}

function resolveLocalReference(root: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const segment of reference.slice(2).split("/")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
