import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { listRepositories } from "../../../../../../plugin-examples/repository-mcp/server/repositories.ts";

const [transportName, evidence] = process.argv.slice(2);
function record(event) {
  appendFileSync(
    evidence,
    JSON.stringify({ ...event, pid: process.pid, cwd: process.cwd(), transport: transportName }) +
      "\n",
  );
}
async function connect(transport) {
  const mcp = new McpServer({ name: "fictional-repositories", version: "1.0.0" });
  mcp.registerTool(
    "list_repositories",
    {
      description: "List only fictional demonstration repositories; no real platform access.",
      inputSchema: { mode: z.enum(["normal", "empty", "failure"]).default("normal") },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = listRepositories(args);
      record({ event: "call", name: "list_repositories", arguments: args, result });
      return {
        content: [
          {
            type: "text",
            text: result.error ?? result.repositories.map((entry) => entry.path).join("\n"),
          },
        ],
        structuredContent: { repositories: result.repositories },
        ...(result.error ? { isError: true } : {}),
      };
    },
  );
  await mcp.connect(transport);
  const receive = transport.onmessage;
  // MCP Transport exposes this callback instead of EventTarget listeners.
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message, extra) => {
    if (message.method === "initialize") {
      record({
        event: "initialize",
        protocolVersion: message.params.protocolVersion,
        clientInfo: message.params.clientInfo,
      });
    }
    receive(message, extra);
  };
  return mcp;
}
if (transportName === "stdio") {
  await connect(new StdioServerTransport());
} else if (transportName === "http") {
  const server = createServer(async (request, response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = await connect(transport);
    response.on("close", () => {
      void mcp.close();
    });
    await transport.handleRequest(request, response);
  });
  server.listen(0, "127.0.0.1", () => {
    console.info(`Fictional MCP: http://127.0.0.1:${server.address().port}/mcp`);
  });
} else throw new Error("Expected stdio or http fixture transport");
