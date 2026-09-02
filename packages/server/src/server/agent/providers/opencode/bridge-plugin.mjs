import { z } from "zod";

const INTERNAL_PREFIX = "/_internal/opencode";

export default async function paseoPlugin(input, options) {
  const request = async (pathname, init) => {
    const response = await fetch(new URL(pathname, options.baseUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...init?.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error ?? `Paseo OpenCode bridge failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  let manifest;
  try {
    manifest = await request(`${INTERNAL_PREFIX}/tools`);
  } catch (error) {
    logPluginError("manifest", {}, error);
    throw error;
  }
  const tools = {};
  for (const definition of manifest.tools ?? []) {
    tools[`paseo_${definition.name}`] = {
      description: definition.description,
      args: jsonSchemaObjectToZodShape(definition.inputSchema),
      execute: async (args, context) => {
        let result;
        try {
          result = await request(
            `${INTERNAL_PREFIX}/sessions/${encodeURIComponent(context.sessionID)}/tools/${encodeURIComponent(definition.name)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(args),
            },
          );
        } catch (error) {
          logPluginError("tool", { sessionID: context.sessionID, tool: definition.name }, error);
          throw error;
        }
        return {
          title: definition.title,
          output: formatToolResult(result),
          metadata: { paseoTool: definition.name },
        };
      },
    };
  }

  return {
    tool: tools,
    "shell.env": async ({ cwd, sessionID }, output) => {
      if (!sessionID) return;
      let context;
      try {
        context = await resolveSessionContext(input.client, request, sessionID, cwd);
      } catch (error) {
        logPluginError("shell.env", { sessionID }, error);
        throw error;
      }
      Object.assign(output.env, context.env);
    },
  };
}

function logPluginError(stage, context, error) {
  console.error(`[paseo-opencode-plugin] ${stage} failed`, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
}

async function resolveSessionContext(client, request, sessionID, cwd, visited = new Set()) {
  if (visited.has(sessionID)) throw new Error("OpenCode session parent cycle");
  visited.add(sessionID);
  try {
    return await request(`${INTERNAL_PREFIX}/sessions/${encodeURIComponent(sessionID)}/context`);
  } catch (error) {
    if (error.status !== 404) throw error;
    const response = await client.session.get({
      path: { id: sessionID },
      query: { directory: cwd },
    });
    const parentID = response?.data?.parentID;
    if (!parentID) throw error;
    return resolveSessionContext(client, request, parentID, cwd, visited);
  }
}

function formatToolResult(result) {
  if (!Array.isArray(result.content)) return JSON.stringify(result, null, 2);
  const text = result.content
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : null))
    .filter((part) => part !== null)
    .join("\n");
  return text || JSON.stringify(result.structuredContent ?? result.content, null, 2);
}

function jsonSchemaObjectToZodShape(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") {
    throw new Error("Paseo OpenCode tool input schema must have an object root");
  }
  const properties = schema.properties ?? {};
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Paseo OpenCode tool input schema has invalid properties");
  }
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const shape = {};
  for (const [key, property] of Object.entries(properties)) {
    const parsed = jsonSchemaToZod(property);
    shape[key] = required.has(key) ? parsed : parsed.optional();
  }
  return shape;
}

// oxlint-disable-next-line complexity -- every supported JSON Schema branch must fail closed.
function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Paseo OpenCode tool schema is invalid");
  }
  if (schema.anyOf) return applySchemaLimits(unionToZod(schema.anyOf), schema);
  if (schema.oneOf) return applySchemaLimits(unionToZod(schema.oneOf), schema);
  if (Object.hasOwn(schema, "const")) return applySchemaLimits(z.literal(schema.const), schema);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) throw new Error("Paseo OpenCode tool schema has an empty enum");
    if (schema.enum.length === 1) return z.literal(schema.enum[0]);
    if (schema.enum.every((item) => typeof item === "string")) return z.enum(schema.enum);
    return z.union(schema.enum.map((item) => z.literal(item)));
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes("null");
  const type = types.find((item) => item !== "null");
  let result;
  switch (type) {
    case "string":
      result = z.string();
      break;
    case "integer":
      result = z.number().int();
      break;
    case "number":
      result = z.number();
      break;
    case "boolean":
      result = z.boolean();
      break;
    case "array":
      if (!schema.items) throw new Error("Paseo OpenCode array schema is missing items");
      result = z.array(jsonSchemaToZod(schema.items));
      break;
    case "object": {
      let object = z.object(jsonSchemaObjectToZodShape(schema));
      if (schema.additionalProperties === false) object = object.strict();
      else if (schema.additionalProperties === true || schema.additionalProperties === undefined) {
        object = object.passthrough();
      } else {
        object = object.catchall(jsonSchemaToZod(schema.additionalProperties));
      }
      result = object;
      break;
    }
    case "null":
      result = z.null();
      break;
    default:
      throw new Error("Paseo OpenCode tool schema has an unsupported type");
  }
  result = applySchemaLimits(result, schema);
  if (typeof schema.description === "string") result = result.describe(schema.description);
  return nullable && type !== "null" ? result.nullable() : result;
}

function unionToZod(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Paseo OpenCode tool schema has an empty union");
  }
  const nonNull = items.filter((item) => !isNullSchema(item));
  const nullable = nonNull.length !== items.length;
  const parsed = nonNull.map(jsonSchemaToZod);
  let result;
  if (parsed.length === 0) result = z.null();
  else if (parsed.length === 1) result = parsed[0];
  else result = z.union(parsed);
  return nullable ? result.nullable() : result;
}

function isNullSchema(schema) {
  return (
    schema?.type === "null" ||
    (Array.isArray(schema?.type) && schema.type.length === 1 && schema.type[0] === "null")
  );
}

function applySchemaLimits(result, schema) {
  if (typeof schema.minLength === "number") result = result.min(schema.minLength);
  if (typeof schema.maxLength === "number") result = result.max(schema.maxLength);
  if (typeof schema.pattern === "string") result = result.regex(new RegExp(schema.pattern, "u"));
  if (typeof schema.minimum === "number") result = result.min(schema.minimum);
  if (typeof schema.maximum === "number") result = result.max(schema.maximum);
  if (typeof schema.exclusiveMinimum === "number") result = result.gt(schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === "number") result = result.lt(schema.exclusiveMaximum);
  if (typeof schema.multipleOf === "number") {
    result = result.refine((value) => Number.isInteger(value / schema.multipleOf), {
      message: `must be a multiple of ${schema.multipleOf}`,
    });
  }
  if (typeof schema.minItems === "number") result = result.min(schema.minItems);
  if (typeof schema.maxItems === "number") result = result.max(schema.maxItems);
  if (schema.uniqueItems === true) {
    result = result.refine(
      (value) => new Set(value.map((item) => JSON.stringify(item))).size === value.length,
      {
        message: "must contain unique items",
      },
    );
  }
  if (typeof schema.minProperties === "number") {
    result = result.refine((value) => Object.keys(value).length >= schema.minProperties, {
      message: `must have at least ${schema.minProperties} properties`,
    });
  }
  if (typeof schema.maxProperties === "number") {
    result = result.refine((value) => Object.keys(value).length <= schema.maxProperties, {
      message: `must have at most ${schema.maxProperties} properties`,
    });
  }
  return result;
}
