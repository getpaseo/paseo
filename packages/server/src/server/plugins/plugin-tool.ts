import {
  normalizeObjectSchema,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { z } from "zod";

export const PLUGIN_TOOL_NAME_PATTERN = /^[a-z][a-z0-9._-]*$/u;
export const PLUGIN_TOOL_DEFAULT_TIMEOUT_MS = 30_000;
export const PLUGIN_TOOL_MAX_TIMEOUT_MS = 120_000;
export const PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN = 8;
export const PLUGIN_TOOL_MAX_CONCURRENT_GLOBAL = 32;
export const PLUGIN_TOOL_CANCEL_GRACE_MS = 2_000;
export const PLUGIN_TOOL_MAX_UPDATE_COUNT = 32;
export const PLUGIN_TOOL_MAX_UPDATE_BYTES = 16 * 1024;
export const PLUGIN_TOOL_MAX_ERROR_BYTES = 16 * 1024;
export const PLUGIN_TOOL_MAX_RESULT_BYTES = 256 * 1024;
export const PLUGIN_TOOL_MAX_SCHEMA_BYTES = 96 * 1024;
export const PLUGIN_TOOL_MAX_CATALOG_TOOLS = 256;
export const PLUGIN_TOOL_MAX_CATALOG_SCHEMA_BYTES = 512 * 1024;
export const PLUGIN_TOOL_MAX_JSON_DEPTH = 32;
export const PLUGIN_TOOL_MAX_JSON_NODES = 20_000;

// These names are intentionally centralized. PluginRuntime uses this set before
// publishing a child catalog, while the normal catalog still rejects duplicates
// if a future built-in is added without updating this list.
export const BUILTIN_PASEO_TOOL_NAMES = new Set([
  "archive_agent",
  "archive_workspace",
  "browser_back",
  "browser_click",
  "browser_close_tab",
  "browser_drag",
  "browser_evaluate",
  "browser_fill",
  "browser_forward",
  "browser_hover",
  "browser_keypress",
  "browser_list_tabs",
  "browser_logs",
  "browser_navigate",
  "browser_new_tab",
  "browser_reload",
  "browser_resize",
  "browser_screenshot",
  "browser_select",
  "browser_scroll",
  "browser_snapshot",
  "browser_type",
  "browser_upload",
  "browser_wait",
  "cancel_agent",
  "capture_terminal",
  "create_agent",
  "create_heartbeat",
  "create_schedule",
  "create_terminal",
  "create_workspace",
  "delete_heartbeat",
  "delete_schedule",
  "get_agent_activity",
  "get_agent_status",
  "inspect_provider",
  "inspect_schedule",
  "kill_agent",
  "kill_terminal",
  "list_agents",
  "list_models",
  "list_pending_permissions",
  "list_profiles",
  "list_providers",
  "list_schedules",
  "list_terminals",
  "list_workspace_scripts",
  "list_workspaces",
  "pause_schedule",
  "rename_workspace",
  "respond_to_permission",
  "resume_schedule",
  "run_schedule_once",
  "schedule_logs",
  "send_agent_prompt",
  "send_terminal_keys",
  "set_agent_mode",
  "speak",
  "start_workspace_script",
  "stop_workspace_script",
  "update_agent",
  "update_schedule",
]);

export function isReservedPluginToolName(name: string): boolean {
  return BUILTIN_PASEO_TOOL_NAMES.has(name) || /^(?:paseo|plugin)[._-]/u.test(name);
}

export function clampPluginToolTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return PLUGIN_TOOL_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Plugin tool timeoutMs must be a positive finite number");
  }
  return Math.min(Math.floor(timeoutMs), PLUGIN_TOOL_MAX_TIMEOUT_MS);
}

export interface PluginToolCatalogEntry {
  pluginId: string;
  generation: number;
  installationId: string;
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  timeoutMs: number;
}

export interface PluginToolCallerContext {
  callerAgentId: string;
  agent: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
}

export function serializePluginToolSchema(
  schema: z.ZodType | z.ZodRawShape,
  label: string,
  options: { requireObject?: boolean } = {},
): Record<string, unknown> {
  let jsonSchema: unknown;
  try {
    const normalized = normalizeObjectSchema(schema as AnySchema | ZodRawShapeCompat);
    if (!normalized) {
      throw new Error(`${label} must provide a supported object schema`);
    }
    jsonSchema = toJsonSchemaCompat(normalized, { strictUnions: true, pipeStrategy: "input" });
  } catch (error) {
    throw new Error(
      `Plugin tool ${label} has a schema that cannot be converted to JSON Schema: ${describeError(error)}`,
      { cause: error },
    );
  }
  assertSafeJson(jsonSchema, `${label} JSON Schema`, PLUGIN_TOOL_MAX_SCHEMA_BYTES);
  if (!isRecord(jsonSchema)) throw new Error(`Plugin tool ${label} schema must be an object`);
  assertSupportedJsonSchema(jsonSchema, label, options);
  return jsonSchema;
}

/**
 * Validate the deliberately small JSON Schema vocabulary that every tool
 * transport understands. Keeping this check at the registration boundary
 * prevents one transport from silently turning an unsupported schema into
 * `z.any()` or an empty object.
 */
export function assertSupportedJsonSchema(
  schema: Record<string, unknown>,
  label: string,
  options: { requireObject?: boolean } = {},
): void {
  // oxlint-disable-next-line complexity -- schema validation is intentionally fail-closed and exhaustive.
  const visit = (value: unknown, path: string, requireObject: boolean): void => {
    if (!isRecord(value)) throw new Error(`${label} has an unsupported schema at ${path}`);

    const supportedKeys = new Set([
      "type",
      "$schema",
      "title",
      "description",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "enum",
      "const",
      "anyOf",
      "oneOf",
      "minLength",
      "maxLength",
      "pattern",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minProperties",
      "maxProperties",
    ]);
    for (const key of Object.keys(value)) {
      if (!supportedKeys.has(key)) {
        throw new Error(`${label} uses unsupported JSON Schema keyword '${key}' at ${path}`);
      }
    }

    for (const key of ["title", "description"]) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        throw new Error(`${label}.${key} must be a string at ${path}`);
      }
    }
    if (value.$schema !== undefined && typeof value.$schema !== "string") {
      throw new Error(`${label}.$schema must be a string at ${path}`);
    }

    const type = value.type;
    if (type !== undefined) {
      const types = Array.isArray(type) ? type : [type];
      if (
        types.length === 0 ||
        new Set(types).size !== types.length ||
        types.some(
          (entry) =>
            typeof entry !== "string" ||
            !["object", "array", "string", "number", "integer", "boolean", "null"].includes(entry),
        )
      ) {
        throw new Error(`${label} has an unsupported type at ${path}`);
      }
      if (types.filter((entry) => entry !== "null").length > 1) {
        throw new Error(`${label} uses an unsupported type union at ${path}; use anyOf or oneOf`);
      }
      if (requireObject && !types.includes("object")) {
        throw new Error(`${label} input schema must have an object root`);
      }
    } else if (requireObject) {
      throw new Error(`${label} input schema must have an object root`);
    }

    let concreteType: unknown;
    if (Array.isArray(type)) {
      concreteType = type.find((entry) => entry !== "null");
    } else if (typeof type === "string") {
      concreteType = type;
    }
    if (requireObject && type !== "object") {
      throw new Error(`${label} input schema must have an object root`);
    }
    if (
      type === undefined &&
      value.enum === undefined &&
      value.const === undefined &&
      value.anyOf === undefined &&
      value.oneOf === undefined
    ) {
      throw new Error(`${label} has no supported schema assertion at ${path}`);
    }

    const properties = value.properties;
    if (properties !== undefined) {
      if (!isRecord(properties) || concreteType !== "object") {
        throw new Error(`${label} properties require an object schema at ${path}`);
      }
      for (const [name, property] of Object.entries(properties)) {
        if (!name || name === "__proto__" || name === "constructor" || name === "prototype") {
          throw new Error(`${label} has an unsafe property name at ${path}.${name}`);
        }
        visit(property, `${path}.properties.${name}`, false);
      }
    }

    const required = value.required;
    if (required !== undefined) {
      if (
        !Array.isArray(required) ||
        concreteType !== "object" ||
        required.some((entry) => typeof entry !== "string") ||
        new Set(required).size !== required.length ||
        (properties !== undefined &&
          required.some((entry) => !isRecord(properties) || !(entry in properties)))
      ) {
        throw new Error(`${label} has an invalid required list at ${path}`);
      }
    }

    const additionalProperties = value.additionalProperties;
    if (additionalProperties !== undefined) {
      if (typeof additionalProperties === "boolean") {
        // Supported directly by all tool transports.
      } else {
        visit(additionalProperties, `${path}.additionalProperties`, false);
      }
      if (concreteType !== "object") {
        throw new Error(`${label} additionalProperties requires an object schema at ${path}`);
      }
    }

    if (value.items !== undefined) {
      if (concreteType !== "array") {
        throw new Error(`${label} items require an array schema at ${path}`);
      }
      visit(value.items, `${path}.items`, false);
    } else if (concreteType === "array") {
      throw new Error(`${label} array schemas must declare items`);
    }

    const enumValues = value.enum;
    if (enumValues !== undefined) {
      if (!Array.isArray(enumValues) || enumValues.length === 0 || enumValues.length > 128) {
        throw new Error(`${label} has an invalid enum at ${path}`);
      }
      for (const [index, enumValue] of enumValues.entries()) {
        if (
          enumValue !== null &&
          typeof enumValue !== "string" &&
          typeof enumValue !== "number" &&
          typeof enumValue !== "boolean"
        ) {
          throw new Error(`${label} supports only primitive enum values at ${path}.enum[${index}]`);
        }
      }
    }
    if (value.const !== undefined) {
      const constValue = value.const;
      if (
        constValue !== null &&
        typeof constValue !== "string" &&
        typeof constValue !== "number" &&
        typeof constValue !== "boolean"
      ) {
        throw new Error(`${label} supports only primitive const values at ${path}.const`);
      }
    }

    const stringKeywords = ["minLength", "maxLength", "pattern"];
    if (stringKeywords.some((key) => value[key] !== undefined) && concreteType !== "string") {
      throw new Error(`${label} string limits require a string schema at ${path}`);
    }
    const numberKeywords = [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ];
    if (
      numberKeywords.some((key) => value[key] !== undefined) &&
      !["number", "integer"].includes(String(concreteType))
    ) {
      throw new Error(`${label} numeric limits require a number schema at ${path}`);
    }
    const arrayKeywords = ["minItems", "maxItems", "uniqueItems"];
    if (arrayKeywords.some((key) => value[key] !== undefined) && concreteType !== "array") {
      throw new Error(`${label} array limits require an array schema at ${path}`);
    }
    if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean") {
      throw new Error(`${label}.uniqueItems must be a boolean at ${path}`);
    }
    const objectKeywords = ["minProperties", "maxProperties"];
    if (objectKeywords.some((key) => value[key] !== undefined) && concreteType !== "object") {
      throw new Error(`${label} object limits require an object schema at ${path}`);
    }

    for (const key of ["anyOf", "oneOf"]) {
      const union = value[key];
      if (union !== undefined) {
        if (
          !Array.isArray(union) ||
          union.length === 0 ||
          (value.anyOf !== undefined && value.oneOf !== undefined)
        ) {
          throw new Error(`${label} has an invalid ${key} union at ${path}`);
        }
        union.forEach((member, index) => visit(member, `${path}.${key}[${index}]`, false));
      }
    }

    for (const key of [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
    ]) {
      const limit = value[key];
      if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 0)) {
        throw new Error(`${label}.${key} must be a non-negative integer at ${path}`);
      }
    }
    for (const [lower, upper] of [
      ["minLength", "maxLength"],
      ["minItems", "maxItems"],
      ["minProperties", "maxProperties"],
    ]) {
      if (
        value[lower] !== undefined &&
        value[upper] !== undefined &&
        (value[lower] as number) > (value[upper] as number)
      ) {
        throw new Error(`${label} has ${lower} greater than ${upper} at ${path}`);
      }
    }
    for (const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ]) {
      const limit = value[key];
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
        throw new Error(`${label}.${key} must be a finite number at ${path}`);
      }
    }
    if (value.multipleOf !== undefined && (value.multipleOf as number) <= 0) {
      throw new Error(`${label}.multipleOf must be positive at ${path}`);
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== "string") {
        throw new Error(`${label}.pattern must be a string at ${path}`);
      }
      try {
        const pattern = new RegExp(value.pattern, "u");
        void pattern;
      } catch (error) {
        throw new Error(`${label}.pattern is not a valid regular expression at ${path}`, {
          cause: error,
        });
      }
    }
  };

  visit(schema, "$", options.requireObject === true);
}

export function assertUtf8ByteLimit(value: string, label: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let used = 0;
  let result = "";
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

export function assertSafeJson(
  value: unknown,
  label: string,
  maxBytes: number = PLUGIN_TOOL_MAX_RESULT_BYTES,
): void {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > PLUGIN_TOOL_MAX_JSON_NODES) {
      throw new Error(`${label} exceeds the JSON node limit`);
    }
    if (depth > PLUGIN_TOOL_MAX_JSON_DEPTH) {
      throw new Error(`${label} exceeds the JSON depth limit at ${path}`);
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new Error(`${label} contains a non-finite number at ${path}`);
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`${label} contains non-JSON data at ${path}`);
    }
    if (seen.has(current)) throw new Error(`${label} contains a cyclic value at ${path}`);
    if (current instanceof Date || current instanceof Map || current instanceof Set) {
      throw new Error(`${label} contains a non-JSON object at ${path}`);
    }
    if (Object.getPrototypeOf(current) !== Object.prototype && !Array.isArray(current)) {
      throw new Error(`${label} contains a non-plain object at ${path}`);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, depth + 1, `${path}[${index}]`));
    } else {
      for (const [key, item] of Object.entries(current)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`${label} contains a dangerous key at ${path}.${key}`);
        }
        visit(item, depth + 1, `${path}.${key}`);
      }
    }
    seen.delete(current);
  };

  visit(value, 0, "$");
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} cannot be JSON encoded: ${describeError(error)}`, { cause: error });
  }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
