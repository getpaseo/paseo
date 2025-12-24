import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const CLAUDE_SETTINGS = {
  permissions: {
    allow: [],
    deny: [],
    ask: ["Bash(rm:*)"],
    additionalDirectories: [],
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: false,
  },
};

async function copyClaudeCredentials(sourceDir: string, targetDir: string): Promise<void> {
  const sourceCredentials = path.join(sourceDir, ".credentials.json");
  if (!existsSync(sourceCredentials)) {
    return;
  }
  await copyFile(sourceCredentials, path.join(targetDir, ".credentials.json"));
}

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

async function waitForAgentCompletion(
  client: McpClient,
  agentId: string
): Promise<void> {
  const waitResult = (await client.callTool({
    name: "wait_for_agent",
    args: { agentId },
  })) as McpToolResult;
  const payload = getStructuredContent(waitResult);
  const status = payload?.status;
  const lastMessage =
    typeof payload?.lastMessage === "string" ? payload.lastMessage : null;
  if (payload?.permission) {
    throw new Error(
      `wait_for_agent returned a pending permission instead of completion: ${JSON.stringify(
        payload.permission
      )}`
    );
  }
  if (status === "running" || status === "initializing") {
    throw new Error(
      `Agent still running after wait_for_agent (status=${status ?? "unknown"}). ${
        lastMessage ?? "No last message."
      }`
    );
  }
}

describe("agent MCP end-to-end", () => {
  test(
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
      const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const sourceClaudeConfigDir =
        previousClaudeConfigDir ?? path.join(os.homedir(), ".claude");
      const claudeConfigDir = await mkdtemp(path.join(os.tmpdir(), "claude-config-"));
      const claudeSettingsText = `${JSON.stringify(CLAUDE_SETTINGS, null, 2)}\n`;
      await writeFile(path.join(claudeConfigDir, "settings.json"), claudeSettingsText, "utf8");
      await writeFile(path.join(claudeConfigDir, "settings.local.json"), claudeSettingsText, "utf8");
      await copyClaudeCredentials(sourceClaudeConfigDir, claudeConfigDir);
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

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
        const filePath = path.join(agentCwd, "mcp-smoke.txt");
        await writeFile(filePath, "ok", "utf8");
        const initialPrompt = [
          "You must call the Bash command tool with the exact command `rm -f mcp-smoke.txt`.",
          "After approval, run it and reply with done and stop.",
          "Do not respond before the command finishes.",
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

        if (existsSync(filePath)) {
          const contents = await readFile(filePath, "utf8");
          throw new Error(
            `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`
          );
        }

        const secondFilePath = path.join(agentCwd, "mcp-smoke-2.txt");
        await writeFile(secondFilePath, "ok-2", "utf8");
        const prompt = [
          "You must call the Bash command tool with the exact command `rm -f mcp-smoke-2.txt`.",
          "After approval, run it and reply with done and stop.",
          "Do not respond before the command finishes.",
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

        if (existsSync(secondFilePath)) {
          const secondContents = await readFile(secondFilePath, "utf8");
          throw new Error(
            `Expected mcp-smoke-2.txt to be removed, but it still exists with contents: ${secondContents}`
          );
        }
      } finally {
        if (agentId) {
          await client.callTool({ name: "kill_agent", args: { agentId } });
        }
        await client.close();
        await daemon.close();
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
        if (previousClaudeConfigDir === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        }
        await rm(paseoHome, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
        await rm(agentCwd, { recursive: true, force: true });
        await rm(codexSessionDir, { recursive: true, force: true });
        await rm(codexHome, { recursive: true, force: true });
        await rm(claudeConfigDir, { recursive: true, force: true });
      }
    },
    180_000
  );
});
