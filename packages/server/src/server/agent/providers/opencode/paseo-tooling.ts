import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentLaunchContext } from "../../agent-sdk-types.js";

const PASEO_OPENCODE_PLUGIN_FILENAME = "paseo-tooling-plugin.mjs";

export interface OpenCodePaseoToolingRuntime {
  pluginPath: string;
}

function resolvePaseoHome(): string {
  return process.env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
}

function resolveRuntimeDirectory(): string {
  return path.join(resolvePaseoHome(), "opencode");
}

export function ensureOpenCodePaseoToolingRuntime(): OpenCodePaseoToolingRuntime {
  const dir = resolveRuntimeDirectory();
  mkdirSync(dir, { recursive: true });
  const pluginPath = path.join(dir, PASEO_OPENCODE_PLUGIN_FILENAME);
  const require = createRequire(import.meta.url);
  const zodImportUrl = pathToFileURL(require.resolve("zod")).href;
  writeFileSync(pluginPath, createOpenCodePaseoToolingPluginSource(zodImportUrl), "utf8");
  return { pluginPath };
}

export function withOpenCodePaseoToolingEnv(params: {
  env?: Record<string, string>;
  launchContext?: AgentLaunchContext;
  runtime: OpenCodePaseoToolingRuntime;
}): Record<string, string> | undefined {
  const tooling = params.launchContext?.paseoTooling;
  if (!tooling?.httpBaseUrl) {
    return params.env;
  }

  const pluginSpec = [
    pathToFileURL(params.runtime.pluginPath).href,
    {
      baseUrl: tooling.httpBaseUrl,
      token: tooling.token,
    },
  ];
  return {
    ...params.env,
    OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContent(
      params.env?.OPENCODE_CONFIG_CONTENT,
      pluginSpec,
    ),
  };
}

export function bindOpenCodePaseoToolingSession(params: {
  launchContext?: AgentLaunchContext;
  sessionId: string;
}): (() => void) | undefined {
  return params.launchContext?.paseoTooling?.bindProviderSession({
    provider: "opencode",
    sessionId: params.sessionId,
  });
}

function mergeOpenCodeConfigContent(existing: string | undefined, pluginSpec: unknown[]): string {
  const base = parseConfigContent(existing);
  const existingPlugins = Array.isArray(base.plugin) ? base.plugin : [];
  const pluginUrl = pluginSpec[0];
  const withoutExistingPaseoPlugin = existingPlugins.filter((entry) => {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    return spec !== pluginUrl;
  });
  return JSON.stringify({
    ...base,
    plugin: [...withoutExistingPaseoPlugin, pluginSpec],
  });
}

function parseConfigContent(existing: string | undefined): Record<string, unknown> {
  if (!existing?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(existing) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function createOpenCodePaseoToolingPluginSource(zodImportUrl: string): string {
  return `
import { z } from ${JSON.stringify(zodImportUrl)};

export async function server(_input, options) {
  const manifestResponse = await fetch(new URL("/api/paseo-tooling/manifest", options.baseUrl), {
    headers: { authorization: "Bearer " + options.token },
  });
  if (!manifestResponse.ok) {
    throw new Error("Failed to load Paseo tooling manifest: " + manifestResponse.status);
  }
  const manifest = await manifestResponse.json();
  const tools = {};
  for (const item of manifest.tools ?? []) {
    const id = "paseo_" + item.name;
    tools[id] = {
      description: item.description,
      args: jsonSchemaObjectToZodShape(item.inputJsonSchema),
      execute: async (args, context) => {
        const input = normalizeJsonSchemaInput(args, item.inputJsonSchema);
        const response = await fetch(new URL("/api/paseo-tooling/execute", options.baseUrl), {
          method: "POST",
          headers: {
            authorization: "Bearer " + options.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            provider: "opencode",
            sessionId: context.sessionID,
            tool: item.name,
            input,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "Paseo tool failed: " + response.status);
        }
        return typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? payload, null, 2);
      },
    };
  }

  return { tool: tools };
}

function jsonSchemaObjectToZodShape(schema) {
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const shape = {};
  for (const [key, value] of Object.entries(properties)) {
    let parsed = jsonSchemaToZod(value);
    if (!required.has(key)) parsed = parsed.optional();
    shape[key] = parsed;
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
      if (typeof schema.minLength === "number") result = result.min(schema.minLength);
      if (typeof schema.maxLength === "number") result = result.max(schema.maxLength);
      break;
    case "integer":
      result = z.number().int();
      if (typeof schema.minimum === "number") result = result.min(schema.minimum);
      if (typeof schema.maximum === "number") result = result.max(schema.maximum);
      break;
    case "number":
      result = z.number();
      if (typeof schema.minimum === "number") result = result.min(schema.minimum);
      if (typeof schema.maximum === "number") result = result.max(schema.maximum);
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
      break;
  }
  if (schema.description && typeof result.describe === "function") result = result.describe(schema.description);
  return nullable ? result.nullable() : result;
}

function normalizeJsonSchemaInput(input, schema) {
  if (!schema || typeof schema !== "object") return input;

  if (schema.anyOf) return normalizeUnionInput(input, schema.anyOf);
  if (schema.oneOf) return normalizeUnionInput(input, schema.oneOf);

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((item) => item !== "null");

  if (typeof input === "string" && !types.includes("string")) {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "undefined" || trimmed === "null") return undefined;
  }

  switch (type) {
    case "boolean":
      if (typeof input === "string") {
        const normalized = input.trim().toLowerCase();
        if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
        if (normalized === "false" || normalized === "no" || normalized === "0") return false;
      }
      return input;
    case "integer":
    case "number":
      if (typeof input === "string" && input.trim() !== "" && /^-?\\d+(\\.\\d+)?$/.test(input.trim())) {
        return Number(input);
      }
      return input;
    case "array": {
      const value = parseJsonString(input);
      if (!Array.isArray(value)) return value;
      return value.map((item) => normalizeJsonSchemaInput(item, schema.items)).filter((item) => item !== undefined);
    }
    case "object": {
      const value = parseJsonString(input);
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const normalized = {};
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in value)) continue;
        const next = normalizeJsonSchemaInput(value[key], propertySchema);
        if (next !== undefined || required.has(key)) normalized[key] = next;
      }
      return normalized;
    }
    default:
      return input;
  }
}

function normalizeUnionInput(input, schemas) {
  const preferred = schemas.find((item) => item?.type && item.type !== "null") ?? schemas[0];
  return normalizeJsonSchemaInput(input, preferred);
}

function parseJsonString(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function unionToZod(items) {
  const nonNull = items.filter((item) => item?.type !== "null");
  const nullable = nonNull.length !== items.length;
  const parsed = nonNull.map(jsonSchemaToZod);
  const result = parsed.length === 0 ? z.null() : parsed.length === 1 ? parsed[0] : z.union(parsed);
  return nullable ? result.nullable() : result;
}
`;
}
