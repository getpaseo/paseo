import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";

const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

export interface McpProtocolVersionHeaderCarrier {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
}

/**
 * Rewrites an unknown `mcp-protocol-version` header to the newest version we speak.
 *
 * The SDK's streamable HTTP transport rejects any header value outside its own
 * supported list with `400 Unsupported protocol version`, which breaks clients
 * that ship a newer protocol revision than the pinned SDK knows about. Initialize
 * already handles this the same way: an unknown requested version negotiates down
 * to `LATEST_PROTOCOL_VERSION`, so later requests have to be read as that version
 * rather than refused. The header also has to be fixed in `rawHeaders` because the
 * Node transport builds its Web `Request` from `rawHeaders`, not `headers`.
 */
export function normalizeMcpProtocolVersionHeader(req: McpProtocolVersionHeaderCarrier): void {
  const header = req.headers[PROTOCOL_VERSION_HEADER];
  const requested = Array.isArray(header) ? header[0] : header;
  if (requested === undefined || SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return;
  }
  req.headers[PROTOCOL_VERSION_HEADER] = LATEST_PROTOCOL_VERSION;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === PROTOCOL_VERSION_HEADER) {
      req.rawHeaders[index + 1] = LATEST_PROTOCOL_VERSION;
    }
  }
}

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

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
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}
