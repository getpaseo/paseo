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
  const properties =
    schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const shape = {};
  for (const [key, property] of Object.entries(properties)) {
    const parsed = jsonSchemaToZod(property);
    shape[key] = required.has(key) ? parsed : parsed.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== "object") return z.any();
  if (schema.anyOf) return unionToZod(schema.anyOf);
  if (schema.oneOf) return unionToZod(schema.oneOf);
  if (schema.const !== undefined) return z.literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
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
      result = z.array(jsonSchemaToZod(schema.items));
      break;
    case "object":
      result = z.object(jsonSchemaObjectToZodShape(schema));
      break;
    default:
      result = z.any();
  }
  if (typeof schema.description === "string") result = result.describe(schema.description);
  return nullable ? result.nullable() : result;
}

function unionToZod(items) {
  const nonNull = items.filter((item) => item?.type !== "null");
  const nullable = nonNull.length !== items.length;
  const parsed = nonNull.map(jsonSchemaToZod);
  let result;
  if (parsed.length === 0) result = z.null();
  else if (parsed.length === 1) result = parsed[0];
  else result = z.union(parsed);
  return nullable ? result.nullable() : result;
}
