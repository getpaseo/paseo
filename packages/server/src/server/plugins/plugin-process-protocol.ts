import { serialize as serializeV8 } from "node:v8";
import { Buffer } from "node:buffer";
import { z } from "zod";

import {
  PLUGIN_TOOL_MAX_DESCRIPTION_BYTES,
  PLUGIN_TOOL_MAX_CATALOG_SCHEMA_BYTES,
  PLUGIN_TOOL_MAX_CATALOG_TOOLS,
  PLUGIN_TOOL_MAX_ERROR_BYTES,
  PLUGIN_TOOL_MAX_NAME_BYTES,
  PLUGIN_TOOL_MAX_RESULT_BYTES,
  PLUGIN_TOOL_MAX_SCHEMA_BYTES,
  PLUGIN_TOOL_MAX_TITLE_BYTES,
  PLUGIN_TOOL_MAX_UPDATE_BYTES,
  assertPluginToolCatalogBytes,
  assertSafeJson,
  assertSafePluginToolText,
  assertSupportedJsonSchema,
  assertUtf8ByteLimit,
} from "./plugin-tool.js";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/transport-limits";
import {
  assertPluginHostResponse,
  PluginCallerAuthoritySchema,
  PluginHostRequestSchema,
  PluginHostResponseSchema,
  type PluginHostResponse,
} from "@getpaseo/protocol/plugin-host";
import { DeliveryPayloadSchema } from "@getpaseo/protocol/deliveries";

export const MAX_PLUGIN_PROCESS_MESSAGE_BYTES = 4 * 1024 * 1024;
const PluginCapabilityNonceSchema = z.string().min(1).max(128);

const JsonObjectSchema = z.record(z.string(), z.unknown());
const BinaryFrameSchema = z.union([
  z.string(),
  z.custom<Uint8Array<ArrayBuffer>>((value) => value instanceof Uint8Array),
]);

export const PluginToolCallerContextSchema = z
  .object({
    callerAgentId: z.string().min(1),
    agent: JsonObjectSchema.nullable(),
    workspace: JsonObjectSchema.nullable(),
    // COMPAT(pluginCallerHostApis): old already-installed plugin processes
    // can still receive the legacy context while new invocations always set it.
    caller: PluginCallerAuthoritySchema.optional(),
  })
  .strict();

export const PluginToolCatalogEntrySchema = z
  .object({
    pluginId: z.string().min(1),
    generation: z.number().int().positive(),
    installationId: z.string().min(1),
    name: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema.optional(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export type PluginToolCallerContext = z.infer<typeof PluginToolCallerContextSchema>;
export type PluginToolCatalogEntry = z.infer<typeof PluginToolCatalogEntrySchema>;

export const PluginProcessRequestSchema = z.union([
  z
    .object({
      type: z.literal("initialize"),
      pluginId: z.string().min(1),
      bundle: z.string().min(1),
      appVersion: z.string().min(1),
      generation: z.number().int().positive().optional(),
      installationId: z.string().min(1),
      capabilityNonce: PluginCapabilityNonceSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("invoke"),
      requestId: z.string().min(1),
      method: z.string().min(1),
      input: z.unknown(),
      context: PluginCallerAuthoritySchema.nullable().optional(),
      generation: z.number().int().positive().optional(),
      installationId: z.string().min(1).optional(),
      capabilityNonce: PluginCapabilityNonceSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_invoke"),
      requestId: z.string().min(1),
      name: z.string().min(1),
      input: z.unknown(),
      context: PluginToolCallerContextSchema,
      generation: z.number().int().positive().optional(),
      installationId: z.string().min(1).optional(),
      capabilityNonce: PluginCapabilityNonceSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("tool_cancel"), requestId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("rpc_cancel"), requestId: z.string().min(1) }).strict(),
  PluginHostResponseSchema,
  z.object({ type: z.literal("shutdown") }).strict(),
  z
    .object({ type: z.literal("paseo_frame"), data: BinaryFrameSchema, isBinary: z.boolean() })
    .strict(),
  z.object({ type: z.literal("paseo_close") }).strict(),
]);

export const PluginProcessMessageSchema = z.union([
  z
    .object({
      type: z.literal("ready"),
      methods: z.array(z.string()).max(256),
      catalog: z.array(PluginToolCatalogEntrySchema).max(256).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("result"), requestId: z.string().min(1), output: z.unknown() })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      requestId: z.string().min(1),
      error: z.string(),
    })
    .strict(),
  z
    .object({ type: z.literal("tool_update"), requestId: z.string().min(1), update: z.unknown() })
    .strict(),
  z.object({ type: z.literal("tool_cancel_ack"), requestId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("rpc_cancel_ack"), requestId: z.string().min(1) }).strict(),
  PluginHostRequestSchema,
  PluginHostResponseSchema,
  z
    .object({ type: z.literal("tool_result"), requestId: z.string().min(1), output: z.unknown() })
    .strict(),
  z
    .object({
      type: z.literal("tool_error"),
      requestId: z.string().min(1),
      error: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("fatal"), error: z.string() }).strict(),
  z
    .object({ type: z.literal("paseo_frame"), data: BinaryFrameSchema, isBinary: z.boolean() })
    .strict(),
  z.object({ type: z.literal("paseo_close") }).strict(),
]);

export type PluginProcessRequest = z.infer<typeof PluginProcessRequestSchema>;
export type PluginProcessMessage = z.infer<typeof PluginProcessMessageSchema>;

export function validatePluginProcessRequest(message: unknown): PluginProcessRequest {
  const parsed = PluginProcessRequestSchema.parse(message);
  validateProcessEnvelope(parsed);
  if (parsed.type.startsWith("plugin.host.") && "ok" in parsed) {
    assertPluginHostResponse(parsed as unknown as PluginHostResponse);
  }
  return parsed;
}

export function validatePluginProcessMessage(message: unknown): PluginProcessMessage {
  const parsed = PluginProcessMessageSchema.parse(message);
  validateProcessEnvelope(parsed);
  if (parsed.type.startsWith("plugin.host.") && "ok" in parsed) {
    assertPluginHostResponse(parsed as unknown as PluginHostResponse);
  }
  return parsed;
}

// oxlint-disable-next-line complexity -- every process message family has an explicit size boundary.
function validateProcessEnvelope(message: PluginProcessRequest | PluginProcessMessage): void {
  if (message.type === "paseo_frame") {
    const frameBytes =
      typeof message.data === "string"
        ? Buffer.byteLength(message.data, "utf8")
        : message.data.byteLength;
    if (frameBytes > MAX_WEBSOCKET_MESSAGE_BYTES) {
      throw new Error("Plugin session frame exceeds the WebSocket message size limit");
    }
    assertSerializedProcessEnvelopeBytes(message);
    return;
  }
  let json: string;
  try {
    json = JSON.stringify(message);
  } catch (error) {
    throw new Error(`Plugin process message is not JSON encodable: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (Buffer.byteLength(json, "utf8") > MAX_PLUGIN_PROCESS_MESSAGE_BYTES) {
    throw new Error("Plugin process message exceeds the IPC size limit");
  }
  if (message.type === "tool_invoke") {
    assertSafeJson(message.input, "Plugin tool input", PLUGIN_TOOL_MAX_RESULT_BYTES);
    assertSafeJson(message.context, "Plugin tool caller context", PLUGIN_TOOL_MAX_RESULT_BYTES);
  }
  if (message.type === "invoke" && message.context !== undefined) {
    assertSafeJson(message.context, "Plugin RPC caller context", PLUGIN_TOOL_MAX_RESULT_BYTES);
  }
  if (
    message.type.startsWith("plugin.host.") &&
    "result" in message &&
    message.result !== undefined
  ) {
    assertSafeJson(message.result, "Plugin host result", PLUGIN_TOOL_MAX_RESULT_BYTES);
  }
  if (message.type.startsWith("plugin.host.") && "payload" in message) {
    DeliveryPayloadSchema.parse(message.payload);
  }
  if (
    message.type.startsWith("plugin.host.") &&
    "options" in message &&
    message.options !== undefined
  ) {
    assertSafeJson(message.options, "Plugin host options", PLUGIN_TOOL_MAX_RESULT_BYTES);
  }
  if (
    message.type.startsWith("plugin.host.") &&
    "error" in message &&
    message.error !== undefined
  ) {
    assertUtf8ByteLimit(message.error, "Plugin host error", PLUGIN_TOOL_MAX_ERROR_BYTES);
  }
  if (message.type === "tool_update") {
    assertSafeJson(message.update, "Plugin tool progress update", PLUGIN_TOOL_MAX_UPDATE_BYTES);
  }
  if (message.type === "tool_result" || message.type === "result") {
    assertSafeJson(message.output, "Plugin tool output", PLUGIN_TOOL_MAX_RESULT_BYTES);
  }
  if (message.type === "error" || message.type === "tool_error" || message.type === "fatal") {
    assertUtf8ByteLimit(message.error, "Plugin process error", PLUGIN_TOOL_MAX_ERROR_BYTES);
  }
  if (message.type === "ready" && message.catalog) {
    let schemaBytes = 0;
    for (const entry of message.catalog) {
      assertSafePluginToolText(
        entry.pluginId,
        `Plugin tool ${entry.name} pluginId`,
        PLUGIN_TOOL_MAX_NAME_BYTES,
      );
      assertSafePluginToolText(
        entry.installationId,
        `Plugin tool ${entry.name} installationId`,
        PLUGIN_TOOL_MAX_NAME_BYTES,
      );
      assertSafePluginToolText(entry.name, "Plugin tool name", PLUGIN_TOOL_MAX_NAME_BYTES);
      assertSafePluginToolText(
        entry.title,
        `Plugin tool ${entry.name} title`,
        PLUGIN_TOOL_MAX_TITLE_BYTES,
      );
      assertSafePluginToolText(
        entry.description,
        `Plugin tool ${entry.name} description`,
        PLUGIN_TOOL_MAX_DESCRIPTION_BYTES,
      );
      assertSafeJson(
        entry.inputSchema,
        `Plugin tool ${entry.name} input schema`,
        PLUGIN_TOOL_MAX_SCHEMA_BYTES,
      );
      assertSupportedJsonSchema(entry.inputSchema, `Plugin tool ${entry.name} input schema`, {
        requireObject: true,
      });
      if (entry.outputSchema) {
        assertSafeJson(
          entry.outputSchema,
          `Plugin tool ${entry.name} output schema`,
          PLUGIN_TOOL_MAX_SCHEMA_BYTES,
        );
        assertSupportedJsonSchema(entry.outputSchema, `Plugin tool ${entry.name} output schema`);
      }
      schemaBytes += Buffer.byteLength(JSON.stringify(entry.inputSchema), "utf8");
      if (entry.outputSchema) {
        schemaBytes += Buffer.byteLength(JSON.stringify(entry.outputSchema), "utf8");
      }
    }
    if (message.catalog.length > PLUGIN_TOOL_MAX_CATALOG_TOOLS) {
      throw new Error("Plugin tool catalog exceeds the tool count limit");
    }
    if (schemaBytes > PLUGIN_TOOL_MAX_CATALOG_SCHEMA_BYTES) {
      throw new Error("Plugin tool catalog exceeds the schema byte limit");
    }
    assertPluginToolCatalogBytes(message.catalog, "Plugin tool catalog");
  }
}

function assertSerializedProcessEnvelopeBytes(
  message: PluginProcessRequest | PluginProcessMessage,
): void {
  let bytes: number;
  try {
    bytes = serializeV8(message).byteLength;
  } catch (error) {
    throw new Error(`Plugin process message is not serializable: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (bytes > MAX_PLUGIN_PROCESS_MESSAGE_BYTES) {
    throw new Error("Plugin process message exceeds the IPC size limit");
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
