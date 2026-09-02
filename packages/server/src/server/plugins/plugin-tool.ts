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
export const PLUGIN_TOOL_MAX_UPDATE_COUNT = 32;
export const PLUGIN_TOOL_MAX_UPDATE_BYTES = 16 * 1024;
export const PLUGIN_TOOL_MAX_ERROR_BYTES = 16 * 1024;
export const PLUGIN_TOOL_MAX_RESULT_BYTES = 256 * 1024;
export const PLUGIN_TOOL_MAX_SCHEMA_BYTES = 96 * 1024;
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
): Record<string, unknown> {
  let jsonSchema: unknown;
  try {
    const normalized = normalizeObjectSchema(schema as AnySchema | ZodRawShapeCompat);
    jsonSchema = normalized
      ? toJsonSchemaCompat(normalized, { strictUnions: true, pipeStrategy: "input" })
      : { type: "object", properties: {} };
  } catch (error) {
    throw new Error(
      `Plugin tool ${label} has a schema that cannot be converted to JSON Schema: ${describeError(error)}`,
      { cause: error },
    );
  }
  assertSafeJson(jsonSchema, `${label} JSON Schema`, PLUGIN_TOOL_MAX_SCHEMA_BYTES);
  if (!isRecord(jsonSchema)) throw new Error(`Plugin tool ${label} schema must be an object`);
  return jsonSchema;
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
