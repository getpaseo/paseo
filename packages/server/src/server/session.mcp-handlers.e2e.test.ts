import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { McpServerConfig } from "./mcp-server-types.js";

describe("MCP server handlers E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test("listMcpServers returns empty array initially", async () => {
    const result = await ctx.client.listMcpServers();

    expect(result.requestId).toBeDefined();
    expect(result.error).toBeNull();
    expect(result.servers).toEqual([]);
  });

  test("createMcpServer creates stdio server", async () => {
    const serverConfig: McpServerConfig = {
      type: "stdio",
      command: "echo",
      args: ["test"],
      env: { TEST: "value" },
    };

    const result = await ctx.client.createMcpServer({
      name: "test-stdio-server",
      type: "stdio",
      config: serverConfig,
      enabled: true,
      tags: ["test"],
      description: "Test stdio server",
    });

    expect(result.requestId).toBeDefined();
    expect(result.error).toBeNull();
    expect(result.server).toBeDefined();
    expect(result.server.name).toBe("test-stdio-server");
    expect(result.server.type).toBe("stdio");
    expect(result.server.config).toEqual(serverConfig);
    expect(result.server.enabled).toBe(true);
    expect(result.server.tags).toEqual(["test"]);
    expect(result.server.description).toBe("Test stdio server");
    expect(result.server.id).toBeDefined();
    expect(result.server.createdAt).toBeDefined();
    expect(result.server.updatedAt).toBeDefined();
  });

  test("createMcpServer creates http server", async () => {
    const serverConfig: McpServerConfig = {
      type: "http",
      url: "http://localhost:8080/mcp",
      headers: { Authorization: "Bearer token" },
    };

    const result = await ctx.client.createMcpServer({
      name: "test-http-server",
      type: "http",
      config: serverConfig,
    });

    expect(result.error).toBeNull();
    expect(result.server).toBeDefined();
    expect(result.server.name).toBe("test-http-server");
    expect(result.server.type).toBe("http");
    expect(result.server.config).toEqual(serverConfig);
    expect(result.server.enabled).toBe(true); // Default
  });

  test("createMcpServer creates sse server", async () => {
    const serverConfig: McpServerConfig = {
      type: "sse",
      url: "http://localhost:8080/sse",
      headers: { "Content-Type": "text/event-stream" },
    };

    const result = await ctx.client.createMcpServer({
      name: "test-sse-server",
      type: "sse",
      config: serverConfig,
      enabled: false,
    });

    expect(result.error).toBeNull();
    expect(result.server).toBeDefined();
    expect(result.server.name).toBe("test-sse-server");
    expect(result.server.type).toBe("sse");
    expect(result.server.config).toEqual(serverConfig);
    expect(result.server.enabled).toBe(false);
  });

  test("listMcpServers returns all servers", async () => {
    // Create multiple servers
    await ctx.client.createMcpServer({
      name: "server-1",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
    });

    await ctx.client.createMcpServer({
      name: "server-2",
      type: "http",
      config: { type: "http", url: "http://localhost:8080" },
    });

    await ctx.client.createMcpServer({
      name: "server-3",
      type: "sse",
      config: { type: "sse", url: "http://localhost:8080/sse" },
    });

    const result = await ctx.client.listMcpServers();

    expect(result.error).toBeNull();
    expect(result.servers).toHaveLength(3);
    expect(result.servers.map((s) => s.name)).toContain("server-1");
    expect(result.servers.map((s) => s.name)).toContain("server-2");
    expect(result.servers.map((s) => s.name)).toContain("server-3");
  });

  test("updateMcpServer updates existing server", async () => {
    const created = await ctx.client.createMcpServer({
      name: "original-name",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: false,
      description: "Original description",
    });

    // Wait a bit to ensure updatedAt would change
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await ctx.client.updateMcpServer(created.server.id, {
      name: "updated-name",
      enabled: true,
      description: "Updated description",
      tags: ["updated"],
    });

    expect(result.error).toBeNull();
    expect(result.server).toBeDefined();
    expect(result.server.id).toBe(created.server.id);
    expect(result.server.name).toBe("updated-name");
    expect(result.server.enabled).toBe(true);
    expect(result.server.description).toBe("Updated description");
    expect(result.server.tags).toEqual(["updated"]);
    expect(result.server.updatedAt).not.toBe(created.server.updatedAt);
    expect(result.server.createdAt).toBe(created.server.createdAt);
  });

  test("updateMcpServer returns null for non-existent id", async () => {
    const result = await ctx.client.updateMcpServer("non-existent-id", {
      name: "updated-name",
    });

    expect(result.server).toBeNull();
    expect(result.error).toBe("MCP server not found");
  });

  test("deleteMcpServer removes server", async () => {
    const created = await ctx.client.createMcpServer({
      name: "to-delete",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
    });

    const result = await ctx.client.deleteMcpServer(created.server.id);

    expect(result.error).toBeNull();
    expect(result.deleted).toBe(true);
    expect(result.id).toBe(created.server.id);

    // Verify it's gone
    const listResult = await ctx.client.listMcpServers();
    expect(listResult.servers).toHaveLength(0);
  });

  test("deleteMcpServer returns false for non-existent id", async () => {
    const result = await ctx.client.deleteMcpServer("non-existent-id");

    expect(result.deleted).toBe(false);
    expect(result.error).toBe("MCP server not found");
  });

  test("toggleMcpServer enables server", async () => {
    const created = await ctx.client.createMcpServer({
      name: "to-enable",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: false,
    });

    const result = await ctx.client.toggleMcpServer({
      id: created.server.id,
      enabled: true,
    });

    expect(result.error).toBeNull();
    expect(result.enabled).toBe(true);
    expect(result.id).toBe(created.server.id);

    // Verify it's enabled
    const listResult = await ctx.client.listMcpServers();
    const server = listResult.servers.find((s) => s.id === created.server.id);
    expect(server?.enabled).toBe(true);
  });

  test("toggleMcpServer disables server", async () => {
    const created = await ctx.client.createMcpServer({
      name: "to-disable",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: true,
    });

    const result = await ctx.client.toggleMcpServer({
      id: created.server.id,
      enabled: false,
    });

    expect(result.error).toBeNull();
    expect(result.enabled).toBe(false);
    expect(result.id).toBe(created.server.id);

    // Verify it's disabled
    const listResult = await ctx.client.listMcpServers();
    const server = listResult.servers.find((s) => s.id === created.server.id);
    expect(server?.enabled).toBe(false);
  });

  test("toggleMcpServer returns error for non-existent id", async () => {
    const result = await ctx.client.toggleMcpServer({
      id: "non-existent-id",
      enabled: true,
    });

    expect(result.enabled).toBe(true); // Requested state
    expect(result.error).toBe("MCP server not found");
  });

  test("MCP servers persist across daemon restarts", async () => {
    // Create some servers
    const server1 = await ctx.client.createMcpServer({
      name: "persistent-server-1",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
    });

    const server2 = await ctx.client.createMcpServer({
      name: "persistent-server-2",
      type: "http",
      config: { type: "http", url: "http://localhost:8080" },
    });

    // Cleanup current daemon
    await ctx.cleanup();

    // Create new daemon context (simulates restart)
    const newCtx = await createDaemonTestContext();

    try {
      // Verify servers persist
      const result = await newCtx.client.listMcpServers();

      expect(result.error).toBeNull();
      expect(result.servers).toHaveLength(2);

      const server1Persisted = result.servers.find((s) => s.id === server1.server.id);
      const server2Persisted = result.servers.find((s) => s.id === server2.server.id);

      expect(server1Persisted).toBeDefined();
      expect(server2Persisted).toBeDefined();

      expect(server1Persisted?.name).toBe("persistent-server-1");
      expect(server2Persisted?.name).toBe("persistent-server-2");
    } finally {
      await newCtx.cleanup();
    }
  }, 120000); // 2 minute timeout for restart

  test("createMcpServer with minimal config", async () => {
    const result = await ctx.client.createMcpServer({
      name: "minimal-server",
      type: "stdio",
      config: {
        type: "stdio",
        command: "echo",
      },
    });

    expect(result.error).toBeNull();
    expect(result.server).toBeDefined();
    expect(result.server.name).toBe("minimal-server");
    expect(result.server.enabled).toBe(true); // Default
    expect(result.server.tags).toBeUndefined();
    expect(result.server.description).toBeUndefined();
  });

  test("createMcpServer with all config options", async () => {
    const result = await ctx.client.createMcpServer({
      name: "full-config-server",
      type: "http",
      config: {
        type: "http",
        url: "https://api.example.com/mcp",
        headers: {
          Authorization: "Bearer token123",
          "X-API-Key": "secret-key",
          "X-Custom-Header": "custom-value",
        },
      },
      enabled: false,
      tags: ["production", "api", "custom"],
      description: "A fully configured HTTP MCP server for production use",
    });

    expect(result.error).toBeNull();
    expect(result.server).toBeDefined();
    expect(result.server.name).toBe("full-config-server");
    expect(result.server.type).toBe("http");
    expect(result.server.enabled).toBe(false);
    expect(result.server.tags).toEqual(["production", "api", "custom"]);
    expect(result.server.description).toBe("A fully configured HTTP MCP server for production use");
    expect(result.server.config).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: {
        Authorization: "Bearer token123",
        "X-API-Key": "secret-key",
        "X-Custom-Header": "custom-value",
      },
    });
  });

  test("updateMcpServer preserves unchanged fields", async () => {
    const created = await ctx.client.createMcpServer({
      name: "preserve-server",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: true,
      tags: ["tag1", "tag2"],
      description: "Original description",
    });

    const result = await ctx.client.updateMcpServer(created.server.id, {
      description: "Updated description only",
    });

    expect(result.error).toBeNull();
    expect(result.server).toBeDefined();
    expect(result.server.name).toBe("preserve-server");
    expect(result.server.enabled).toBe(true);
    expect(result.server.tags).toEqual(["tag1", "tag2"]);
    expect(result.server.description).toBe("Updated description only");
    expect(result.server.config).toEqual(created.server.config);
  });
});
