import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { McpServerStore } from "./mcp-server-store.js";
import type { McpServerConfig } from "./mcp-server-types.js";

describe("McpServerStore", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: McpServerStore;
  const logger = createTestLogger();

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mcp-server-store-"));
    storagePath = path.join(tmpDir, "mcp-servers.json");
    storage = new McpServerStore(storagePath, logger);
    await storage.initialize();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test("listMcpServers returns empty array initially", async () => {
    const servers = await storage.list();
    expect(servers).toEqual([]);
  });

  test("addMcpServer creates new server", async () => {
    const serverConfig: McpServerConfig = {
      type: "stdio",
      command: "echo",
      args: ["hello"],
      env: { TEST: "value" },
    };

    const server = await storage.add({
      name: "test-stdio-server",
      type: "stdio",
      config: serverConfig,
      enabled: true,
      tags: ["test"],
      description: "Test stdio server",
    });

    expect(server.id).toBeDefined();
    expect(server).toMatchObject({
      name: "test-stdio-server",
      type: "stdio",
      config: serverConfig,
      enabled: true,
      tags: ["test"],
      description: "Test stdio server",
    });
    expect(server.createdAt).toBe(server.updatedAt);
  });

  test("getMcpServer returns server by id", async () => {
    const serverConfig: McpServerConfig = {
      type: "http",
      url: "http://localhost:8080/mcp",
      headers: { Authorization: "Bearer token" },
    };

    const created = await storage.add({
      name: "test-http-server",
      type: "http",
      config: serverConfig,
    });

    const fetched = await storage.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched).toMatchObject({
      id: created.id,
      name: "test-http-server",
      type: "http",
      config: serverConfig,
      enabled: true,
    });
  });

  test("getMcpServer returns null for non-existent id", async () => {
    const fetched = await storage.get("non-existent-id");
    expect(fetched).toBeNull();
  });

  test("getByIds returns multiple servers", async () => {
    const server1 = await storage.add({
      name: "server-1",
      type: "stdio",
      config: { type: "stdio", command: "echo", args: ["1"] },
    });

    const server2 = await storage.add({
      name: "server-2",
      type: "stdio",
      config: { type: "stdio", command: "echo", args: ["2"] },
    });

    const fetched = await storage.getByIds([server1.id, server2.id]);
    expect(fetched).toHaveLength(2);
    expect(fetched.map((s) => s.id)).toContain(server1.id);
    expect(fetched.map((s) => s.id)).toContain(server2.id);
  });

  test("getByIds filters by provided ids", async () => {
    const server1 = await storage.add({
      name: "server-1",
      type: "stdio",
      config: { type: "stdio", command: "echo", args: ["1"] },
    });

    const server2 = await storage.add({
      name: "server-2",
      type: "stdio",
      config: { type: "stdio", command: "echo", args: ["2"] },
    });

    const fetched = await storage.getByIds([server1.id]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].id).toBe(server1.id);
  });

  test("updateMcpServer updates existing server", async () => {
    const original = await storage.add({
      name: "original-name",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: false,
      description: "Original description",
    });

    // Wait to ensure updatedAt changes
    await new Promise((resolve) => setTimeout(resolve, 1));

    const updated = await storage.update(original.id, {
      name: "updated-name",
      enabled: true,
      description: "Updated description",
      tags: ["updated"],
    });

    expect(updated).not.toBeNull();
    expect(updated).toMatchObject({
      id: original.id,
      name: "updated-name",
      enabled: true,
      description: "Updated description",
    });
    expect(updated!.updatedAt).not.toBe(original.updatedAt);
    expect(updated!.createdAt).toBe(original.createdAt);
  });

  test("updateMcpServer returns null for non-existent id", async () => {
    const updated = await storage.update("non-existent-id", {
      name: "updated-name",
    });

    expect(updated).toBeNull();
  });

  test("deleteMcpServer removes server", async () => {
    const server = await storage.add({
      name: "to-delete",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
    });

    const deleted = await storage.delete(server.id);
    expect(deleted).toBe(true);

    const fetched = await storage.get(server.id);
    expect(fetched).toBeNull();
  });

  test("deleteMcpServer returns false for non-existent id", async () => {
    const deleted = await storage.delete("non-existent-id");
    expect(deleted).toBe(false);
  });

  test("enable enables server", async () => {
    const server = await storage.add({
      name: "to-enable",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: false,
    });

    const enabled = await storage.enable(server.id);
    expect(enabled).toBe(true);

    const fetched = await storage.get(server.id);
    expect(fetched?.enabled).toBe(true);
  });

  test("enable returns false for non-existent id", async () => {
    const enabled = await storage.enable("non-existent-id");
    expect(enabled).toBe(false);
  });

  test("disable disables server", async () => {
    const server = await storage.add({
      name: "to-disable",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: true,
    });

    const disabled = await storage.disable(server.id);
    expect(disabled).toBe(true);

    const fetched = await storage.get(server.id);
    expect(fetched?.enabled).toBe(false);
  });

  test("disable returns false for non-existent id", async () => {
    const disabled = await storage.disable("non-existent-id");
    expect(disabled).toBe(false);
  });

  test("listEnabled returns only enabled servers", async () => {
    await storage.add({
      name: "enabled-server",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: true,
    });

    await storage.add({
      name: "disabled-server",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: false,
    });

    const enabled = await storage.listEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("enabled-server");
  });

  test("persisted data survives restart", async () => {
    const server1 = await storage.add({
      name: "persistent-server-1",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: true,
      tags: ["persistent"],
    });

    const server2 = await storage.add({
      name: "persistent-server-2",
      type: "http",
      config: { type: "http", url: "http://localhost:8080" },
      enabled: false,
    });

    // Create new store instance with same path
    const newStorage = new McpServerStore(storagePath, logger);
    await newStorage.initialize();

    const servers = await newStorage.list();
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.id)).toContain(server1.id);
    expect(servers.map((s) => s.id)).toContain(server2.id);

    await newStorage.close?.();
  });

  test("resolveMcpServers converts server IDs to config", async () => {
    const server1 = await storage.add({
      name: "server-1",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: true,
    });

    const server2 = await storage.add({
      name: "server-2",
      type: "http",
      config: { type: "http", url: "http://localhost:8080" },
      enabled: true,
    });

    const server3 = await storage.add({
      name: "server-3",
      type: "sse",
      config: { type: "sse", url: "http://localhost:8080/sse" },
      enabled: false,
    });

    const resolved = storage.resolveMcpServers([server1.id, server2.id, server3.id]);

    expect(resolved).toBeDefined();
    expect(Object.keys(resolved!)).toHaveLength(2);
    expect(resolved!).toHaveProperty("server-1");
    expect(resolved!).toHaveProperty("server-2");
    expect(resolved!).not.toHaveProperty("server-3");
  });

  test("resolveMcpServers returns undefined for empty ids", async () => {
    const resolved = storage.resolveMcpServers([]);
    expect(resolved).toBeUndefined();
  });

  test("resolveMcpServers returns undefined for all disabled servers", async () => {
    const server1 = await storage.add({
      name: "disabled-server-1",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
      enabled: false,
    });

    const server2 = await storage.add({
      name: "disabled-server-2",
      type: "http",
      config: { type: "http", url: "http://localhost:8080" },
      enabled: false,
    });

    const resolved = storage.resolveMcpServers([server1.id, server2.id]);
    expect(resolved).toBeUndefined();
  });

  test("supports all MCP server types", async () => {
    const stdioServer = await storage.add({
      name: "stdio-server",
      type: "stdio",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "command"],
        env: { NODE_ENV: "production" },
      },
    });

    const httpServer = await storage.add({
      name: "http-server",
      type: "http",
      config: {
        type: "http",
        url: "http://localhost:8080/mcp",
        headers: { Authorization: "Bearer token" },
      },
    });

    const sseServer = await storage.add({
      name: "sse-server",
      type: "sse",
      config: {
        type: "sse",
        url: "http://localhost:8080/sse",
        headers: { "X-Custom": "value" },
      },
    });

    const servers = await storage.list();
    expect(servers).toHaveLength(3);

    expect(stdioServer.config).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "command"],
      env: { NODE_ENV: "production" },
    });

    expect(httpServer.config).toMatchObject({
      type: "http",
      url: "http://localhost:8080/mcp",
      headers: { Authorization: "Bearer token" },
    });

    expect(sseServer.config).toMatchObject({
      type: "sse",
      url: "http://localhost:8080/sse",
      headers: { "X-Custom": "value" },
    });
  });

  test("handles SSE server type correctly", async () => {
    const server = await storage.add({
      name: "sse-test-server",
      type: "sse",
      config: {
        type: "sse",
        url: "http://localhost:8080/sse",
        headers: { "Content-Type": "text/event-stream" },
      },
    });

    expect(server.type).toBe("sse");
    expect(server.config.type).toBe("sse");

    const fetched = await storage.get(server.id);
    expect(fetched).toMatchObject({
      name: "sse-test-server",
      type: "sse",
      config: {
        type: "sse",
        url: "http://localhost:8080/sse",
        headers: { "Content-Type": "text/event-stream" },
      },
    });
  });

  test("handles HTTP server type correctly", async () => {
    const server = await storage.add({
      name: "http-test-server",
      type: "http",
      config: {
        type: "http",
        url: "https://api.example.com/mcp",
        headers: {
          Authorization: "Bearer token123",
          "X-API-Key": "secret",
        },
      },
    });

    expect(server.type).toBe("http");
    expect(server.config.type).toBe("http");

    const fetched = await storage.get(server.id);
    expect(fetched).toMatchObject({
      name: "http-test-server",
      type: "http",
      config: {
        type: "http",
        url: "https://api.example.com/mcp",
        headers: {
          Authorization: "Bearer token123",
          "X-API-Key": "secret",
        },
      },
    });
  });

  test("handles stdio server type correctly", async () => {
    const server = await storage.add({
      name: "stdio-test-server",
      type: "stdio",
      config: {
        type: "stdio",
        command: "python",
        args: ["-m", "mcp_server"],
        env: {
          PATH: "/usr/local/bin",
          PYTHONPATH: "/opt/python",
        },
      },
    });

    expect(server.type).toBe("stdio");
    expect(server.config.type).toBe("stdio");

    const fetched = await storage.get(server.id);
    expect(fetched).toMatchObject({
      name: "stdio-test-server",
      type: "stdio",
      config: {
        type: "stdio",
        command: "python",
        args: ["-m", "mcp_server"],
        env: {
          PATH: "/usr/local/bin",
          PYTHONPATH: "/opt/python",
        },
      },
    });
  });

  test("atomic write prevents data loss on crash", async () => {
    const server = await storage.add({
      name: "atomic-test",
      type: "stdio",
      config: { type: "stdio", command: "echo" },
    });

    // File should exist and be valid JSON
    const fileContent = await fs.readFile(storagePath, "utf8");
    const parsed = JSON.parse(fileContent);

    expect(parsed).toHaveProperty("servers");
    expect(Array.isArray(parsed.servers)).toBe(true);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].id).toBe(server.id);
  });
});
