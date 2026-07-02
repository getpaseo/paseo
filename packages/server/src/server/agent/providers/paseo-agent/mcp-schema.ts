import { Type, type TSchema } from "@earendil-works/pi-ai";

// JSON-Schema → TypeBox conversion for MCP tool input schemas. MCP advertises tool
// parameters as JSON Schema; Pi tool definitions expect a TypeBox `TSchema`. This
// covers the shapes common MCP servers emit (objects, primitives, arrays, enums,
// unions, required/optional, additionalProperties) and falls back to a permissive
// `Type.Unknown()` for anything it doesn't recognise, so unusual schemas degrade to
// "accept anything" rather than throwing.

type JsonSchemaRecord = Record<string, unknown>;

// Index signature lets these annotations satisfy TypeBox's option types directly.
interface SchemaAnnotations {
  [key: PropertyKey]: unknown;
  description?: string;
  default?: unknown;
  title?: string;
}

function isRecord(value: unknown): value is JsonSchemaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function annotationsOf(schema: JsonSchemaRecord): SchemaAnnotations {
  const annotations: SchemaAnnotations = {};
  if (typeof schema.description === "string") {
    annotations.description = schema.description;
  }
  if (typeof schema.title === "string") {
    annotations.title = schema.title;
  }
  if ("default" in schema) {
    annotations.default = schema.default;
  }
  return annotations;
}

function literalOf(value: unknown): TSchema {
  if (value === null) {
    return Type.Null();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Type.Literal(value);
  }
  // Non-literal enum members (objects/arrays) can't be TypeBox literals.
  return Type.Unknown();
}

function unionOf(members: TSchema[], annotations: SchemaAnnotations): TSchema {
  if (members.length === 0) {
    return Type.Unknown(annotations);
  }
  if (members.length === 1) {
    return members[0];
  }
  return Type.Union(members, annotations);
}

function convertByType(
  type: string,
  schema: JsonSchemaRecord,
  annotations: SchemaAnnotations,
): TSchema {
  switch (type) {
    case "string":
      return Type.String(annotations);
    case "number":
      return Type.Number(annotations);
    case "integer":
      return Type.Integer(annotations);
    case "boolean":
      return Type.Boolean(annotations);
    case "null":
      return Type.Null(annotations);
    case "array": {
      const items = isRecord(schema.items) ? convertSchema(schema.items) : Type.Unknown();
      return Type.Array(items, annotations);
    }
    case "object":
      return convertObject(schema, annotations);
    default:
      return Type.Unknown(annotations);
  }
}

function convertObject(schema: JsonSchemaRecord, annotations: SchemaAnnotations): TSchema {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );

  const fields: Record<string, TSchema> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    const converted = isRecord(propSchema) ? convertSchema(propSchema) : Type.Unknown();
    fields[key] = required.has(key) ? converted : Type.Optional(converted);
  }

  const objectOptions: Record<string, unknown> = { ...annotations };
  const additional = schema.additionalProperties;
  if (additional === false || additional === true) {
    objectOptions.additionalProperties = additional;
  } else if (isRecord(additional)) {
    objectOptions.additionalProperties = convertSchema(additional);
  }

  return Type.Object(fields, objectOptions);
}

function convertSchema(schema: JsonSchemaRecord): TSchema {
  const annotations = annotationsOf(schema);

  if (Array.isArray(schema.enum)) {
    return unionOf(schema.enum.map(literalOf), annotations);
  }

  const composite = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(composite)) {
    const members = composite.filter(isRecord).map(convertSchema);
    return unionOf(members, annotations);
  }

  if (Array.isArray(schema.type)) {
    const members = schema.type
      .filter((t): t is string => typeof t === "string")
      .map((t) => convertByType(t, schema, annotations));
    return unionOf(members, annotations);
  }

  if (typeof schema.type === "string") {
    return convertByType(schema.type, schema, annotations);
  }

  // No declared type: treat as an object when properties are present, else accept anything.
  if (isRecord(schema.properties)) {
    return convertObject(schema, annotations);
  }

  return Type.Unknown(annotations);
}

/**
 * Convert an MCP tool `inputSchema` (JSON Schema) into a TypeBox schema for a Pi tool
 * definition. Always returns an object schema at the top level so tool parameters are
 * a well-formed object, even when the server omits or malforms the schema.
 */
export function mcpInputSchemaToTypeBox(inputSchema: unknown): TSchema {
  if (!isRecord(inputSchema)) {
    return Type.Object({}, { additionalProperties: true });
  }
  const { type } = inputSchema;
  // MCP tool parameters are objects. Convert object schemas faithfully; for a bare
  // schema with neither a declared object type nor properties, accept any object.
  if (type === "object" || isRecord(inputSchema.properties)) {
    return convertObject(inputSchema, annotationsOf(inputSchema));
  }
  // No declared type, or a non-object top-level type (unusual for tool params):
  // accept any object so the tool stays callable.
  return Type.Object({}, { additionalProperties: true });
}
