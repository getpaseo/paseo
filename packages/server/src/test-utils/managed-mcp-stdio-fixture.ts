import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (process.argv.includes("--verify-env")) {
  if (process.env.MCP_TEST_EXPLICIT !== "allowed") {
    throw new Error("Expected explicitly configured environment variable");
  }
  if (process.env.PASEO_MCP_TEST_UNRELATED_SECRET !== undefined) {
    throw new Error("Inherited an unrelated daemon environment variable");
  }
}

const server = new McpServer({ name: "managed-mcp-test", version: "1.0.0" });
server.registerTool(
  "ping",
  {
    description: "Return a deterministic test response",
  },
  async () => ({ content: [{ type: "text", text: "pong" }] }),
);

await server.connect(new StdioServerTransport());
