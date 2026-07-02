import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Logger } from "pino";

import type { AgentToolResultLike, ToolDefinition } from "./pi-services.js";
import type { McpServerConfig } from "../../agent-sdk-types.js";
import { mcpInputSchemaToTypeBox } from "./mcp-schema.js";

// Provider-owned bridge that turns `AgentSessionConfig.mcpServers` into Pi
// `customTools`. It owns the MCP client lifecycle: connect on creation, expose tools,
// proxy execution, and tear down on session close. Network/transport construction is
// behind an injectable connection factory so the bridge is testable with a fake.

const MCP_CLIENT_NAME = "paseo-agent";
const MCP_CLIENT_VERSION = "0.1.0";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { text?: string; uri?: string; mimeType?: string; blob?: string };
}

export interface McpCallToolResult {
  content?: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** A live connection to one MCP server. The default impl wraps the MCP SDK Client. */
export interface McpConnection {
  listTools(): Promise<McpToolInfo[]>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export type McpConnectionFactory = (
  serverName: string,
  config: McpServerConfig,
) => Promise<McpConnection>;

export interface McpToolBridge {
  /** Pi custom tools for every successfully-listed MCP tool. */
  tools: ToolDefinition[];
  /** Close every MCP connection. Idempotent and best-effort. */
  close(): Promise<void>;
}

function buildTransport(config: McpServerConfig): Transport {
  switch (config.type) {
    case "http":
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined,
      );
    case "sse":
      return new SSEClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined,
      );
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
      });
  }
}

/** Default connection factory: a real MCP SDK client over the configured transport. */
async function connectWithSdk(
  _serverName: string,
  config: McpServerConfig,
): Promise<McpConnection> {
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );
  await client.connect(buildTransport(config));
  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    async callTool(toolName, args) {
      return (await client.callTool({ name: toolName, arguments: args })) as McpCallToolResult;
    },
    async close() {
      await client.close();
    },
  };
}

function mcpResultText(result: McpCallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource" && typeof block.resource?.text === "string") {
      parts.push(block.resource.text);
    }
  }
  return parts.join("\n");
}

/**
 * Map an MCP `CallToolResult` content array into Pi tool-result content. Text and image
 * blocks map directly; other block kinds become a short text note so nothing is silently
 * dropped. Pure and exported for testing.
 */
export function mapMcpToolContent(result: McpCallToolResult): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text ?? "" });
        break;
      case "image":
        if (block.data && block.mimeType) {
          content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        }
        break;
      case "audio":
        content.push({
          type: "text",
          text: `[audio${block.mimeType ? ` ${block.mimeType}` : ""}]`,
        });
        break;
      case "resource":
        if (typeof block.resource?.text === "string") {
          content.push({ type: "text", text: block.resource.text });
        } else if (block.resource?.uri) {
          content.push({ type: "text", text: `[resource ${block.resource.uri}]` });
        }
        break;
      case "resource_link":
        if (block.uri) {
          content.push({ type: "text", text: `[resource ${block.uri}]` });
        }
        break;
      default:
        content.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  return content;
}

function buildToolDefinition(
  serverName: string,
  info: McpToolInfo,
  connection: McpConnection,
): ToolDefinition {
  const toolName = `${serverName}__${info.name}`;
  const description = info.description ?? info.name;
  const definition: ToolDefinition = {
    name: toolName,
    label: info.name,
    description,
    promptSnippet: description,
    parameters: mcpInputSchemaToTypeBox(info.inputSchema),
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const result = await connection.callTool(info.name, args);
      if (result.isError) {
        // Throwing makes Pi mark the tool call failed and surface the message.
        throw new Error(mcpResultText(result) || `MCP tool "${info.name}" reported an error`);
      }
      const toolResult: AgentToolResultLike = {
        content: mapMcpToolContent(result),
        details: result.structuredContent ?? null,
      };
      return toolResult;
    },
  };
  return definition;
}

/**
 * Connect to every configured MCP server, list its tools, and produce Pi custom tools.
 * Servers that fail to connect or list are logged and skipped rather than failing the
 * whole session. Call `close()` on session teardown.
 */
export async function createMcpToolBridge(options: {
  mcpServers?: Record<string, McpServerConfig>;
  logger: Logger;
  connect?: McpConnectionFactory;
}): Promise<McpToolBridge> {
  const connect = options.connect ?? connectWithSdk;
  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  for (const [serverName, serverConfig] of Object.entries(options.mcpServers ?? {})) {
    let connection: McpConnection;
    try {
      connection = await connect(serverName, serverConfig);
    } catch (error) {
      options.logger.warn({ err: error, mcpServer: serverName }, "Paseo Agent: MCP connect failed");
      continue;
    }
    connections.push(connection);

    try {
      const toolInfos = await connection.listTools();
      for (const info of toolInfos) {
        tools.push(buildToolDefinition(serverName, info, connection));
      }
    } catch (error) {
      options.logger.warn(
        { err: error, mcpServer: serverName },
        "Paseo Agent: MCP listTools failed",
      );
    }
  }

  return {
    tools,
    async close() {
      await Promise.all(
        connections.map((connection) =>
          connection
            .close()
            .catch((error) =>
              options.logger.warn({ err: error }, "Paseo Agent: MCP connection close failed"),
            ),
        ),
      );
    },
  };
}
