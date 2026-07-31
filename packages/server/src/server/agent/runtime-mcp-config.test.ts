import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import {
  stripInternalPaseoMcpServerFromPersistence,
  withRuntimePaseoMcpServer,
} from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
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

  test("strips the injected server from provider persistence metadata", () => {
    const result = stripInternalPaseoMcpServerFromPersistence({
      provider: "claude",
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: {
        cwd: "/tmp/agent",
        model: "test-model",
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
            headers: { Authorization: "Bearer sentinel-secret" },
          },
          userServer: {
            type: "http",
            url: "https://example.test/mcp",
          },
        },
      },
    });

    expect(result).toEqual({
      provider: "claude",
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: {
        cwd: "/tmp/agent",
        model: "test-model",
        mcpServers: {
          userServer: {
            type: "http",
            url: "https://example.test/mcp",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("sentinel-secret");
  });
});
