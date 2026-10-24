import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { listRepositories } from "./repositories.ts";

const server = createServer(async (request, response) => {
  const mcp = new McpServer({ name: "fictional-repositories", version: "1.0.0" });
  mcp.registerTool(
    "list_repositories",
    {
      description: "List fictional demonstration repositories. Does not access a real platform.",
      inputSchema: { mode: z.enum(["normal", "empty", "failure"]).default("normal") },
      annotations: { readOnlyHint: true },
    },
    async ({ mode }) => {
      const result = listRepositories({ mode });
      return {
        ...(result.error ? { isError: true } : {}),
        content: [
          {
            type: "text",
            text:
              result.error ??
              (result.repositories.map((repository) => repository.path).join("\n") ||
                "No repositories"),
          },
        ],
        structuredContent: { repositories: result.repositories },
        _meta: { fictional: true },
      };
    },
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(request, response);
});
server.listen(Number(process.argv[2] ?? "7779"), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.info(`Fictional MCP: http://127.0.0.1:${address.port}/mcp`);
});
