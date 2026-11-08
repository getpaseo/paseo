import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { isRuntimePaseoMcpServer, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test.each([
    "http://127.0.0.1:6767/mcp/agents",
    "http://192.168.1.25:6767/mcp/agents",
    "http://100.85.12.3:6767/mcp/agents",
    "http://[fd7a:115c:a1e0::1234]:6767/mcp/agents",
  ])("recognizes the injected runtime server at %s", (mcpBaseUrl) => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl,
      mcpAuthToken: "cap-token",
    });

    expect(isRuntimePaseoMcpServer(result.mcpServers!.paseo!)).toBe(true);
  });

  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer cap-token" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
    });
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });

  test("does not trust copied or serialized runtime-server configurations", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://100.85.12.3:6767/mcp/agents",
      mcpAuthToken: null,
    });
    const server = result.mcpServers!.paseo!;

    expect(isRuntimePaseoMcpServer(server)).toBe(true);
    expect(isRuntimePaseoMcpServer({ ...server })).toBe(false);
    const restored: AgentSessionConfig = JSON.parse(JSON.stringify(result));
    expect(isRuntimePaseoMcpServer(restored.mcpServers!.paseo!)).toBe(false);

    const resumed = withRuntimePaseoMcpServer({
      config: restored,
      agentId: "agent-1",
      mcpBaseUrl: "http://192.168.1.25:6767/mcp/agents",
      mcpAuthToken: null,
    });
    expect(resumed.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://192.168.1.25:6767/mcp/agents?callerAgentId=agent-1",
    });
    expect(isRuntimePaseoMcpServer(resumed.mcpServers!.paseo!)).toBe(true);
  });

  test("does not trust a caller-configured server named paseo", () => {
    const server = { type: "http" as const, url: "https://external.example/custom-mcp" };
    const result = withRuntimePaseoMcpServer({
      config: { ...BASE_CONFIG, mcpServers: { paseo: server } },
      agentId: "agent-1",
      mcpBaseUrl: "http://100.85.12.3:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toBe(server);
    expect(isRuntimePaseoMcpServer(server)).toBe(false);
    expect(
      isRuntimePaseoMcpServer({
        type: "http",
        url: "http://100.85.12.3:6767/mcp/agents?callerAgentId=agent-1",
      }),
    ).toBe(false);
  });
});
