import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

type StructuredContent = { [key: string]: unknown };

type McpToolResult = {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
};

type McpClient = {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<unknown>;
  close: () => Promise<void>;
};

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    const structured = (content as { structuredContent?: StructuredContent }).structuredContent;
    if (structured) return structured;
  }
  if (content && typeof content === "object") {
    return content as StructuredContent;
  }
  return null;
}

async function waitForAgentCompletion(client: McpClient, agentId: string): Promise<void> {
  const waitResult = (await client.callTool({
    name: "wait_for_agent",
    args: { agentId },
  })) as McpToolResult;
  const payload = getStructuredContent(waitResult);
  if (!payload) {
    throw new Error("wait_for_agent returned no structured payload");
  }
  if (payload.permission) {
    throw new Error(`Unexpected permission while waiting: ${JSON.stringify(payload.permission)}`);
  }
  const status = payload.status;
  if (status === "running" || status === "initializing") {
    throw new Error(`Agent still running after wait_for_agent (status=${String(status)})`);
  }
}

describe("agent MCP end-to-end (offline)", () => {
  test(
    "create_agent runs initial prompt and affects filesystem",
    async () => {
      const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
      const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
      const port = await getAvailablePort();

      const daemonConfig: PaseoDaemonConfig = {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        allowedHosts: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        openrouterApiKey: null,
      };

      const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
      await daemon.start();

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents`)
      );
      const client = (await experimental_createMCPClient({ transport })) as McpClient;

      let agentId: string | null = null;
      try {
        const filePath = path.join(agentCwd, "mcp-smoke.txt");
        await writeFile(filePath, "ok", "utf8");

        const initialPrompt = [
          "You must call the Bash command tool with the exact command `rm -f mcp-smoke.txt`.",
          "Run it and reply with done and stop.",
          "Do not respond before the command finishes.",
        ].join("\n");

        const result = (await client.callTool({
          name: "create_agent",
          args: {
            cwd: agentCwd,
            title: "MCP e2e smoke",
            agentType: "claude",
            initialMode: "bypassPermissions",
            initialPrompt,
            background: false,
          },
        })) as McpToolResult;

        const payload = getStructuredContent(result);
        agentId = (payload?.agentId as string | undefined) ?? null;
        expect(agentId).toBeTruthy();

        await waitForAgentCompletion(client, agentId!);

        if (existsSync(filePath)) {
          const contents = await readFile(filePath, "utf8");
          throw new Error(
            `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`
          );
        }
      } finally {
        if (agentId) {
          await client.callTool({ name: "kill_agent", args: { agentId } });
        }
        await client.close();
        await daemon.stop();
        await rm(paseoHome, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
        await rm(agentCwd, { recursive: true, force: true });
      }
    },
    30_000
  );
});
