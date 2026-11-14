import { McpServer } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = ServerContext;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
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
      {
        title: tool.title,
        description: tool.description,
        // Paseo declares tool schemas through the `zod` root entry; the SDK types
        // its input schema through the `zod/v4` core entry. Both are the same zod
        // runtime, but the two entry points carry distinct type identities, so a
        // single narrowing cast is required at this boundary.
        inputSchema: tool.inputSchema as StandardSchemaWithJSON,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(
          await catalog.executeTool(tool.name, args, { signal: context?.mcpReq?.signal }),
        ),
    );
  }

  return server;
}
