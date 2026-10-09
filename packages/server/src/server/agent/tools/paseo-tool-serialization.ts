// These SDK internals are reachable through @modelcontextprotocol/sdk's wildcard export,
// not a curated public subpath. Keep that package pinned exactly and re-verify these
// paths on every SDK bump so native host-tool schemas stay byte-compatible.
import {
  normalizeObjectSchema,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

import type { PaseoToolDefinition, PaseoToolResult } from "./types.js";

const EMPTY_OBJECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

function formatStructuredContentForModel(structuredContent: unknown): string {
  return JSON.stringify(structuredContent);
}

export function addModelVisibleStructuredContent(result: PaseoToolResult): PaseoToolResult {
  if (result.structuredContent === undefined || result.content.length > 0) {
    return result;
  }

  return {
    ...result,
    content: [
      {
        type: "text",
        text: formatStructuredContentForModel(result.structuredContent),
      },
    ],
  };
}

export function serializePaseoToolInputParameters(
  tool: PaseoToolDefinition,
): Record<string, unknown> {
  const schema = normalizeObjectSchema(
    tool.inputSchema as AnySchema | ZodRawShapeCompat | undefined,
  );
  return schema
    ? toJsonSchemaCompat(schema, {
        strictUnions: true,
        pipeStrategy: "input",
      })
    : { ...EMPTY_OBJECT_JSON_SCHEMA };
}
