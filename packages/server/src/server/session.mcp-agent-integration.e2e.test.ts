import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { McpServerConfig } from "./mcp-server-types.js";

describe("MCP server agent integration", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test("createAgent with mcpServers passes config to agent", async () => {
    const mcpServerConfig: McpServerConfig = {
      type: "stdio",
      command: "echo",
      args: ["hello"],
      env: { TEST: "value" },
    };

    const server = await ctx.client.createMcpServer({
      name: "test-echo-server",
      type: "stdio",
      config: mcpServerConfig,
      enabled: true,
    });

    expect(server.error).toBeNull();
    expect(server.server).toBeDefined();

    const cwd = mkdtempSync(path.join(tmpdir(), "mcp-agent-test-"));

    try {
      const agent = await ctx.client.createAgent({
        config: {
          provider: "opencode",
          cwd,
          mcpServers: {
            "test-echo-server": mcpServerConfig,
          },
        },
        initialPrompt: "hello",
      });

      expect(agent).toBeDefined();
      expect(agent.id).toBeDefined();
      expect(agent.config).toBeDefined();
      expect(agent.config.mcpServers).toBeDefined();
      expect(agent.config.mcpServers?.["test-echo-server"]).toEqual(mcpServerConfig);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("persisted agent retains mcpServers config", async () => {
    const mcpServerConfig: McpServerConfig = {
      type: "stdio",
      command: "echo",
      args: ["persist-test"],
    };

    const cwd = mkdtempSync(path.join(tmpdir(), "mcp-persist-test-"));

    try {
      const created = await ctx.client.createAgent({
        config: {
          provider: "opencode",
          cwd,
          mcpServers: {
            "persist-server": mcpServerConfig,
          },
        },
        initialPrompt: "test",
      });

      const fetched = await ctx.client.fetchAgent(created.id);

      expect(fetched.config?.mcpServers).toBeDefined();
      expect(fetched.config?.mcpServers?.["persist-server"]).toEqual(mcpServerConfig);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120000);

  test("disabled mcpServer is not included in agent config", async () => {
    const mcpServerConfig: McpServerConfig = {
      type: "stdio",
      command: "echo",
    };

    const server = await ctx.client.createMcpServer({
      name: "disabled-server",
      type: "stdio",
      config: mcpServerConfig,
      enabled: false,
    });

    expect(server.error).toBeNull();

    const cwd = mkdtempSync(path.join(tmpdir(), "mcp-disabled-test-"));

    try {
      const agent = await ctx.client.createAgent({
        config: {
          provider: "opencode",
          cwd,
          mcpServers: {
            "disabled-server": mcpServerConfig,
          },
        },
        initialPrompt: "test",
      });

      expect(agent.config.mcpServers?.["disabled-server"]).toEqual(mcpServerConfig);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);
});
