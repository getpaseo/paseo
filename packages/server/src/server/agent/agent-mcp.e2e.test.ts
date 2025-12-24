import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

type McpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<
    { structuredContent?: Record<string, unknown> } | Record<string, unknown>
  >;
};

type McpClient = {
  callTool: (input: {
    name: string;
    args?: Record<string, unknown>;
  }) => Promise<unknown>;
  close: () => Promise<void>;
};

type PermissionPayload = {
  id: string;
};

function getStructuredContent(
  result: McpToolResult
): Record<string, unknown> | null {
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
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

async function waitForFile(
  filePath: string,
  timeoutMs = 30000
): Promise<string> {
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

describe("agent MCP end-to-end", () => {
  test("creates a Claude agent and writes a file", async () => {
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const daemonHandle = await createTestPaseoDaemon();

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${daemonHandle.port}/mcp/agents`),
      daemonHandle.agentMcpAuthHeader
        ? {
            requestInit: {
              headers: { Authorization: daemonHandle.agentMcpAuthHeader },
            },
          }
        : undefined
    );
    const client = (await experimental_createMCPClient({
      transport,
    })) as McpClient;

    let agentId: string | null = null;

    try {
      const result = (await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP e2e codex smoke",
          agentType: "codex",
          initialMode: "read-only",
          background: false,
        },
      })) as McpToolResult;

      const payload = getStructuredContent(result);
      expect(payload).toBeTruthy();
      agentId = payload?.agentId as string | null;
      expect(agentId).toBeTruthy();

      const prompt = [
        'Run this command exactly: ["bash", "-lc", "echo ok > mcp-smoke.txt"].',
        "After the command runs, reply with done and stop.",
      ].join("\n");

      const promptResult = (await client.callTool({
        name: "send_agent_prompt",
        args: {
          agentId,
          prompt,
            sessionMode: "read-only",
          background: false,
        },
      })) as McpToolResult;
      const promptPayload = getStructuredContent(promptResult);
      const permission = promptPayload?.permission as PermissionPayload | null;
      if (!permission?.id) {
        const activityResult = (await client.callTool({
          name: "get_agent_activity",
          args: { agentId, limit: 10 },
        })) as McpToolResult;
        console.log(
          "[agent-mcp.e2e] send_agent_prompt payload:",
          promptPayload
        );
        console.log(
          "[agent-mcp.e2e] get_agent_activity payload:",
          getStructuredContent(activityResult)
        );
      }
      expect(permission?.id).toBeTruthy();
      await client.callTool({
        name: "respond_to_permission",
        args: {
          agentId,
          requestId: permission!.id,
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
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemonHandle.close();
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 180_000);
});
