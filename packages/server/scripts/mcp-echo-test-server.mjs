import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "paseo-test-mcp", version: "1.0.0" });

server.tool(
  "paseo_roundtrip_text",
  { text: z.string() },
  async ({ text }) => ({
    content: [{ type: "text", text: `ECHO:${text}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
