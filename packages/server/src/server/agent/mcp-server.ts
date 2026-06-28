import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParseAsync?: unknown }).safeParseAsync === "function"
  );
}

function relaxMcpOutputSchema(outputSchema: unknown): unknown {
  if (!outputSchema) {
    return outputSchema;
  }

  if (isZodSchema(outputSchema)) {
    return outputSchema instanceof z.ZodObject ? outputSchema.passthrough() : outputSchema;
  }

  return z.object(outputSchema as z.ZodRawShape).passthrough();
}

function relaxMcpToolOutputSchema<TConfig extends { outputSchema?: unknown }>(
  config: TConfig,
): TConfig {
  if (config.outputSchema === undefined) {
    return config;
  }

  return {
    ...config,
    outputSchema: relaxMcpOutputSchema(config.outputSchema),
  } as TConfig;
}

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

function addModelVisibleStructuredContent(result: CallToolResult): CallToolResult {
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

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  return addModelVisibleStructuredContent({
    content: result.content as CallToolResult["content"],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent as CallToolResult["structuredContent"] }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  });
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      relaxMcpToolOutputSchema({
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }),
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}
