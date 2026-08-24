import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

export interface HubActionCall {
  actionId: string;
  name: "finish_execution" | "reply" | "undeclared_action";
  input: Record<string, unknown>;
  ordinal: number;
}

export interface HubActionSink {
  url: string;
  calls: HubActionCall[];
  close(): Promise<void>;
}

export async function startHubActionSink(): Promise<HubActionSink> {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  const calls: HubActionCall[] = [];
  const capabilityPath = `/execution/${randomUUID()}/mcp`;

  app.post(capabilityPath, (request, response) => {
    void handleRequest(request, response, calls);
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Hub action sink did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    url: `http://127.0.0.1:${port}${capabilityPath}`,
    calls,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

async function handleRequest(
  request: express.Request,
  response: express.Response,
  calls: HubActionCall[],
): Promise<void> {
  const server = createActionServer(calls);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: false,
  });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

function createActionServer(calls: HubActionCall[]): McpServer {
  const server = new McpServer({ name: "hub-execution-action-sink", version: "1.0.0" });
  server.registerTool(
    "finish_execution",
    {
      description: "Complete this Hub execution with a structured classification result.",
      inputSchema: {
        classification: z.enum(["safe", "needs_review", "blocked"]),
        confidence: z.number().min(0).max(1),
        summary: z.string().min(1),
      },
    },
    async (input) => acknowledge(calls, "finish_execution", input),
  );
  server.registerTool(
    "reply",
    {
      description: "Send one synthetic reply action for this Hub execution.",
      inputSchema: {
        actionId: z.string().min(1),
        message: z.string().min(1),
      },
    },
    async (input) => acknowledge(calls, "reply", input),
  );
  server.registerTool(
    "undeclared_action",
    {
      description: "An action that is intentionally not preapproved by the Hub request.",
      inputSchema: { value: z.string().min(1) },
    },
    async (input) => acknowledge(calls, "undeclared_action", input),
  );
  return server;
}

function acknowledge(
  calls: HubActionCall[],
  name: HubActionCall["name"],
  input: Record<string, unknown>,
) {
  const acknowledgement = {
    acknowledged: true,
    actionId: typeof input.actionId === "string" ? input.actionId : `${name}-${calls.length + 1}`,
    ordinal: calls.length + 1,
  };
  calls.push({ ...acknowledgement, name, input });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(acknowledgement) }],
    structuredContent: acknowledgement,
  };
}
