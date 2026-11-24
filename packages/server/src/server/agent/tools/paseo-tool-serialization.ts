import { z } from "zod";

import type { PaseoToolDefinition, PaseoToolResult } from "./types.js";

const EMPTY_OBJECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

function formatStructuredContentForModel(structuredContent: unknown): string {
  if (
    !structuredContent ||
    typeof structuredContent !== "object" ||
    Array.isArray(structuredContent)
  ) {
    return JSON.stringify(structuredContent, null, 2);
  }

  const record = structuredContent as Record<string, unknown>;
  const summary: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!Array.isArray(value)) {
      continue;
    }
    summary.push(`${key}_count=${value.length}`);
    const ids = value
      .map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>).id
          : null,
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === value.length && ids.length > 0) {
      summary.push(`${key}_ids=${ids.join(",")}`);
    }
  }

  const json = JSON.stringify(structuredContent, null, 2);
  return summary.length > 0 ? `${summary.join("\n")}\n\n${json}` : json;
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

// Native host tools must advertise the schema the agent MCP endpoint serves.
// @modelcontextprotocol/server converts tool input schemas with zod's
// standard JSON Schema hook at the draft 2020-12 target, so do the same here.
export function serializePaseoToolInputParameters(
  tool: PaseoToolDefinition,
): Record<string, unknown> {
  if (tool.inputSchema === undefined) {
    return { ...EMPTY_OBJECT_JSON_SCHEMA };
  }
  const schema =
    tool.inputSchema instanceof z.ZodType ? tool.inputSchema : z.object(tool.inputSchema);
  return {
    type: "object",
    ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }),
  };
}
