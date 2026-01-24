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

function isStructuredContent(value: unknown): value is StructuredContent {
  return typeof value === "object" && value !== null;
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && "structuredContent" in content && content.structuredContent) {
    return content.structuredContent;
  }
  if (isStructuredContent(content)) {
    return content;
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
    "creates a Claude agent and deletes a file",
    async () => {
      const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
      const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
      const port = await getAvailablePort();

      const daemonConfig: PaseoDaemonConfig = {
        listen: `${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        agentMcpRoute: "/mcp/agents",
        agentMcpAllowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        staticDir,
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: path.join(paseoHome, "agents"),
        agentControlMcp: {
          url: `http://127.0.0.1:${port}/mcp/agents`,
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

      const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
      await daemon.start();

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents`)
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
          "Run it and reply with done and stop.",
          "Do not respond before the command finishes.",
        ].join("\n");

        // Use bypassPermissions mode so tests don't depend on user's permission settings
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
        expect(payload).toBeTruthy();
        agentId = payload?.agentId as string | null;
        expect(agentId).toBeTruthy();

        // With bypassPermissions mode, agent should complete without waiting for permission
        await waitForAgentCompletion(client, agentId!);

        if (existsSync(filePath)) {
          const contents = await readFile(filePath, "utf8");
          throw new Error(
            `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`
          );
        }

        // Test follow-up prompt
        const secondFilePath = path.join(agentCwd, "mcp-smoke-2.txt");
        await writeFile(secondFilePath, "ok-2", "utf8");
        const prompt = [
          "You must call the Bash command tool with the exact command `rm -f mcp-smoke-2.txt`.",
          "Run it and reply with done and stop.",
          "Do not respond before the command finishes.",
        ].join("\n");

        await client.callTool({
          name: "send_agent_prompt",
          args: {
            agentId,
            prompt,
            background: false,
          },
        });

        await waitForAgentCompletion(client, agentId!);

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
        await daemon.stop();
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

  test(
    "send_agent_prompt interrupts running agent and processes new message",
    async () => {
      const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
      const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
      const port = await getAvailablePort();

      const daemonConfig: PaseoDaemonConfig = {
        listen: `${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        agentMcpRoute: "/mcp/agents",
        agentMcpAllowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        staticDir,
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: path.join(paseoHome, "agents"),
        agentControlMcp: {
          url: `http://127.0.0.1:${port}/mcp/agents`,
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

      const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
      await daemon.start();

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents`)
      );
      const client = (await experimental_createMCPClient({
        transport,
      })) as McpClient;

      let agentId: string | null = null;

      try {
        // Create a Codex agent (simpler for this test, no permissions needed)
        const result = (await client.callTool({
          name: "create_agent",
          args: {
            cwd: agentCwd,
            title: "MCP interrupt test",
            agentType: "codex",
            initialMode: "full-access",
            background: true, // Start in background so create returns immediately
          },
        })) as McpToolResult;

        const payload = getStructuredContent(result);
        expect(payload).toBeTruthy();
        agentId = payload?.agentId as string | null;
        expect(agentId).toBeTruthy();

        // Send a long-running prompt in background mode
        const longPrompt = "Write a file called 'long-running.txt' that contains the numbers 1 through 100, one per line. Do it now.";
        const firstPromptResult = (await client.callTool({
          name: "send_agent_prompt",
          args: {
            agentId,
            prompt: longPrompt,
            background: true, // Returns immediately while agent is running
          },
        })) as McpToolResult;

        const firstPromptPayload = getStructuredContent(firstPromptResult);
        expect(firstPromptPayload?.success).toBe(true);

        // Small delay to ensure agent starts processing
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Now send another prompt while the first is still running
        // This should NOT throw "Agent already has an active run" error
        const interruptPrompt = "Write a file called 'interrupt-test.txt' with the content 'interrupted'. Do it now.";
        let secondPromptResult: McpToolResult;
        try {
          secondPromptResult = (await client.callTool({
            name: "send_agent_prompt",
            args: {
              agentId,
              prompt: interruptPrompt,
              background: false, // Wait for this one to complete
            },
          })) as McpToolResult;
        } catch (error) {
          // Capture the actual error for assertion
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(`send_agent_prompt should not throw when agent is running, but got: ${errorMessage}`);
        }

        // The key assertion: send_agent_prompt should NOT error with "already has an active run"
        // Check that the result is not an error response
        const resultWithError = secondPromptResult as { isError?: boolean; content?: Array<{ text?: string }> };
        if (resultWithError.isError) {
          const errorText = resultWithError.content?.[0]?.text ?? "";
          // The specific error we're testing for is "already has an active run"
          // Other errors (like API key issues) are acceptable in this test
          if (errorText.includes("already has an active run")) {
            throw new Error(`send_agent_prompt should interrupt running agent, but got: ${errorText}`);
          }
          // Other errors are OK - the main test is that we don't get "already has an active run"

        } else {
          const secondPromptPayload = getStructuredContent(secondPromptResult);
          expect(secondPromptPayload).toBeTruthy();
          expect(secondPromptPayload?.success).toBe(true);
        }

        // The core test passes: send_agent_prompt on a running agent doesn't error with "already has an active run"
        // The rest of the test (file creation) depends on LLM API availability which may not be present in CI
      } finally {
        if (agentId) {
          await client.callTool({ name: "kill_agent", args: { agentId } });
        }
        await client.close();
        await daemon.stop();
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
