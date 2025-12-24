import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";

type McpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ structuredContent?: Record<string, unknown> } | Record<string, unknown>>;
};

type McpClient = {
  callTool: (input: { name: string; args?: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
};

type PermissionPayload = {
  id: string;
};

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function getStructuredContent(result: McpToolResult): Record<string, unknown> | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && "structuredContent" in content && content.structuredContent) {
    return content.structuredContent;
  }
  if (content && typeof content === "object") {
    return content as Record<string, unknown>;
  }
  return null;
}

async function waitForFile(filePath: string, timeoutMs = 30000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForAgentCompletion(
  client: McpClient,
  agentId: string
): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const waitResult = (await client.callTool({
      name: "wait_for_agent",
      args: { agentId },
    })) as McpToolResult;
    const payload = getStructuredContent(waitResult);
    const status = payload?.status;
    if (status && status !== "running" && status !== "initializing") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const hasClaudeCredentials = Boolean(
  process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
);

describe("agent MCP end-to-end", () => {
  const runTest = hasClaudeCredentials ? test : test.skip;
  runTest(
    "creates a Claude agent and writes a file",
    async () => {
      const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
      const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
      const port = await getAvailablePort();
      const basicUsers = { test: "pass" };
      const [agentMcpUser, agentMcpPassword] =
        Object.entries(basicUsers)[0] ?? [];
      const agentMcpAuthHeader =
        agentMcpUser && agentMcpPassword
          ? `Basic ${Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")}`
          : undefined;
      const agentMcpBearerToken =
        agentMcpUser && agentMcpPassword
          ? Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")
          : undefined;

      const daemonConfig: PaseoDaemonConfig = {
        port,
        paseoHome,
        agentMcpRoute: "/mcp/agents",
        agentMcpAllowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        auth: {
          basicUsers,
          agentMcpAuthHeader,
          agentMcpBearerToken,
          realm: "Voice Assistant",
        },
        staticDir,
        mcpDebug: false,
        agentClients: {},
        agentRegistryPath: path.join(paseoHome, "agents.json"),
        agentControlMcp: {
          url: `http://127.0.0.1:${port}/mcp/agents`,
          ...(agentMcpAuthHeader
            ? { headers: { Authorization: agentMcpAuthHeader } }
            : {}),
        },
      };

      const previousCodexSessionDir = process.env.CODEX_SESSION_DIR;
      const previousCodexHome = process.env.CODEX_HOME;
      const codexSessionDir = await mkdtemp(
        path.join(os.tmpdir(), "codex-session-")
      );
      const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
      process.env.CODEX_SESSION_DIR = codexSessionDir;
      process.env.CODEX_HOME = codexHome;

      const daemon = await createPaseoDaemon(daemonConfig);
      await new Promise<void>((resolve) => {
        daemon.httpServer.listen(port, () => resolve());
      });

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents`),
        agentMcpAuthHeader
          ? { requestInit: { headers: { Authorization: agentMcpAuthHeader } } }
          : undefined
      );
      const client = (await experimental_createMCPClient({
        transport,
      })) as McpClient;

      let agentId: string | null = null;

      try {
        const initialPrompt = [
          "You must call the tool named shell.",
          "Run this command exactly: [\"bash\", \"-lc\", \"echo ok > mcp-smoke.txt\"].",
          "After the tool runs, reply with done and stop.",
        ].join("\n");

        const result = (await client.callTool({
          name: "create_agent",
          args: {
            cwd: agentCwd,
            title: "MCP e2e smoke",
            agentType: "claude",
            initialMode: "default",
            initialPrompt,
            background: false,
          },
        })) as McpToolResult;

        const payload = getStructuredContent(result);
        expect(payload).toBeTruthy();
        agentId = payload?.agentId as string | null;
        expect(agentId).toBeTruthy();
        const createPermission = payload?.permission as PermissionPayload | null;
        expect(createPermission?.id).toBeTruthy();
        await client.callTool({
          name: "respond_to_permission",
          args: {
            agentId,
            requestId: createPermission!.id,
            response: { behavior: "allow" },
          },
        });
        await waitForAgentCompletion(client, agentId);

        const filePath = path.join(agentCwd, "mcp-smoke.txt");
        let contents: string;
        try {
          contents = await waitForFile(filePath);
        } catch (error) {
          const activityResult = (await client.callTool({
            name: "get_agent_activity",
            args: { agentId, limit: 25 },
          })) as McpToolResult;
          const activityPayload = getStructuredContent(activityResult);
          const activitySummary = activityPayload?.content;
          const details = activitySummary
            ? `Agent activity:\n${activitySummary}`
            : "Agent activity unavailable";
          throw new Error(`${(error as Error).message}\n${details}`);
        }
        expect(contents.trim()).toBe("ok");

        const prompt = [
          "You must call the tool named shell.",
          "Run this command exactly: [\"bash\", \"-lc\", \"echo ok-2 > mcp-smoke-2.txt\"].",
          "After the tool runs, reply with done and stop.",
        ].join("\n");

        const promptResult = (await client.callTool({
          name: "send_agent_prompt",
          args: {
            agentId,
            prompt,
            sessionMode: "default",
            background: false,
          },
        })) as McpToolResult;

        const promptPayload = getStructuredContent(promptResult);
        const promptPermission = promptPayload?.permission as PermissionPayload | null;
        expect(promptPermission?.id).toBeTruthy();

        const waitPermissionResult = (await client.callTool({
          name: "wait_for_agent",
          args: { agentId },
        })) as McpToolResult;
        const waitPermissionPayload = getStructuredContent(waitPermissionResult);
        const waitPermission =
          waitPermissionPayload?.permission as PermissionPayload | null;
        expect(waitPermission?.id).toBe(promptPermission?.id);

        await client.callTool({
          name: "respond_to_permission",
          args: {
            agentId,
            requestId: promptPermission!.id,
            response: { behavior: "allow" },
          },
        });

        await waitForAgentCompletion(client, agentId);

        const secondFilePath = path.join(agentCwd, "mcp-smoke-2.txt");
        const secondContents = await waitForFile(secondFilePath);
        expect(secondContents.trim()).toBe("ok-2");
      } finally {
        if (agentId) {
          await client.callTool({ name: "kill_agent", args: { agentId } });
        }
        await client.close();
        await daemon.close().catch(() => undefined);
        if (previousCodexSessionDir === undefined) {
          delete process.env.CODEX_SESSION_DIR;
        } else {
          process.env.CODEX_SESSION_DIR = previousCodexSessionDir;
        }
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
        await rm(paseoHome, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
        await rm(agentCwd, { recursive: true, force: true });
        await rm(codexSessionDir, { recursive: true, force: true });
        await rm(codexHome, { recursive: true, force: true });
      }
    },
    180_000
  );
});
