import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { McpServerConfig } from "../../agent-sdk-types.js";
import {
  type McpCallToolResult,
  type McpConnection,
  type McpConnectionFactory,
  type McpToolInfo,
  createMcpToolBridge,
  mapMcpToolContent,
} from "./mcp-bridge.js";

interface FakeConnectionSpec {
  tools?: McpToolInfo[];
  listToolsError?: Error;
  callResult?: McpCallToolResult;
}

function fakeConnection(spec: FakeConnectionSpec) {
  const calls: { toolName: string; args: Record<string, unknown> }[] = [];
  const closed = { value: false };
  const connection: McpConnection = {
    async listTools() {
      if (spec.listToolsError) {
        throw spec.listToolsError;
      }
      return spec.tools ?? [];
    },
    async callTool(toolName, args) {
      calls.push({ toolName, args });
      return spec.callResult ?? { content: [{ type: "text", text: "ok" }] };
    },
    async close() {
      closed.value = true;
    },
  };
  return { connection, calls, closed };
}

const HTTP_SERVER: McpServerConfig = { type: "http", url: "https://example.test/mcp" };

describe("mapMcpToolContent", () => {
  it("maps text and image blocks, notes other kinds", () => {
    const content = mapMcpToolContent({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "b64", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///x" },
        { type: "audio", mimeType: "audio/wav" },
      ],
    });
    expect(content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "b64", mimeType: "image/png" },
      { type: "text", text: "[resource file:///x]" },
      { type: "text", text: "[audio audio/wav]" },
    ]);
  });
});

describe("createMcpToolBridge", () => {
  it("lists tools from each server as namespaced Pi tools", async () => {
    const { connection } = fakeConnection({
      tools: [
        { name: "do_thing", description: "does a thing", inputSchema: { type: "object" } },
        { name: "other", inputSchema: { type: "object" } },
      ],
    });
    const connect: McpConnectionFactory = async () => connection;

    const bridge = await createMcpToolBridge({
      mcpServers: { paseo: HTTP_SERVER },
      logger: createTestLogger(),
      connect,
    });

    expect(bridge.tools.map((t) => t.name)).toEqual(["paseo__do_thing", "paseo__other"]);
    expect(bridge.tools[0]?.description).toBe("does a thing");
    await bridge.close();
  });

  it("proxies execute to callTool and maps the result", async () => {
    const { connection, calls } = fakeConnection({
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
      callResult: { content: [{ type: "text", text: "pong" }] },
    });
    const bridge = await createMcpToolBridge({
      mcpServers: { paseo: HTTP_SERVER },
      logger: createTestLogger(),
      connect: async () => connection,
    });

    const tool = bridge.tools[0];
    const result = await tool.execute("call-1", { msg: "ping" }, undefined, undefined, {} as never);

    expect(calls).toEqual([{ toolName: "echo", args: { msg: "ping" } }]);
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    await bridge.close();
  });

  it("throws from execute when the MCP result is an error", async () => {
    const { connection } = fakeConnection({
      tools: [{ name: "boom", inputSchema: { type: "object" } }],
      callResult: { isError: true, content: [{ type: "text", text: "kaboom" }] },
    });
    const bridge = await createMcpToolBridge({
      mcpServers: { paseo: HTTP_SERVER },
      logger: createTestLogger(),
      connect: async () => connection,
    });

    await expect(
      bridge.tools[0].execute("call-1", {}, undefined, undefined, {} as never),
    ).rejects.toThrow(/kaboom/);
    await bridge.close();
  });

  it("skips a server whose listTools fails but still closes it on teardown", async () => {
    const { connection, closed } = fakeConnection({ listToolsError: new Error("nope") });
    const bridge = await createMcpToolBridge({
      mcpServers: { paseo: HTTP_SERVER },
      logger: createTestLogger(),
      connect: async () => connection,
    });

    expect(bridge.tools).toHaveLength(0);
    await bridge.close();
    expect(closed.value).toBe(true);
  });

  it("skips a server that fails to connect without throwing", async () => {
    const connect = vi.fn(async () => {
      throw new Error("connect failed");
    });
    const bridge = await createMcpToolBridge({
      mcpServers: { paseo: HTTP_SERVER },
      logger: createTestLogger(),
      connect,
    });

    expect(bridge.tools).toHaveLength(0);
    expect(connect).toHaveBeenCalledTimes(1);
    await bridge.close();
  });

  it("closes every connection on teardown", async () => {
    const a = fakeConnection({ tools: [{ name: "t", inputSchema: { type: "object" } }] });
    const b = fakeConnection({ tools: [{ name: "u", inputSchema: { type: "object" } }] });
    const connect: McpConnectionFactory = async (serverName) =>
      serverName === "a" ? a.connection : b.connection;

    const bridge = await createMcpToolBridge({
      mcpServers: { a: HTTP_SERVER, b: HTTP_SERVER },
      logger: createTestLogger(),
      connect,
    });
    await bridge.close();

    expect(a.closed.value).toBe(true);
    expect(b.closed.value).toBe(true);
  });

  it("produces no tools when there are no MCP servers", async () => {
    const bridge = await createMcpToolBridge({ logger: createTestLogger() });
    expect(bridge.tools).toHaveLength(0);
    await bridge.close();
  });
});
