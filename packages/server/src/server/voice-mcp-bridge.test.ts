import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { z } from "zod";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";

import { createVoiceMcpBridgeSocketServer } from "./voice-mcp-bridge.js";

describe("voice MCP bridge", () => {
  test("proxies stdio MCP messages through unix socket bridge", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-voice-mcp-bridge-"));
    const socketPath = path.join(tmpRoot, "voice-mcp.sock");
    const callerAgentId = "voice-agent-bridge-test";

    const bridge = createVoiceMcpBridgeSocketServer({
      socketPath,
      logger: pino({ level: "silent" }),
      createAgentMcpServerForCaller: async (callerId) => {
        const server = new McpServer({
          name: "bridge-test-server",
          version: "1.0.0",
        });

        server.registerTool(
          "echo_caller",
          {
            value: z.string().optional(),
          },
          async (args) => {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    callerAgentId: callerId,
                    value: args.value ?? null,
                  }),
                },
              ],
              structuredContent: {
                callerAgentId: callerId,
                value: args.value ?? null,
              },
            };
          }
        );

        return server;
      },
    });

    await bridge.start();

    const tsxBin = path.resolve(process.cwd(), "../../node_modules/.bin/tsx");
    const serverIndex = path.resolve(process.cwd(), "src/server/index.ts");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        tsxBin,
        serverIndex,
        "__paseo_voice_mcp_bridge",
        "--socket",
        socketPath,
        "--caller-agent-id",
        callerAgentId,
      ],
    });

    const client = await experimental_createMCPClient({ transport });

    try {
      const result = await client.callTool({
        name: "echo_caller",
        args: { value: "ok" },
      });

      const payload =
        ((result as { structuredContent?: { callerAgentId?: string; value?: string | null } })
          .structuredContent) ?? null;

      expect(payload?.callerAgentId).toBe(callerAgentId);
    } finally {
      await client.close();
      await bridge.stop();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
