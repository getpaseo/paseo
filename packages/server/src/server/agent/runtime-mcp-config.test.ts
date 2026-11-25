import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { stripInternalPaseoMcpServer, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpEndpoint: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" },
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
      mcpEndpoint: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" },
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
      mcpEndpoint: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });
});

describe("Unix runtime MCP configuration", () => {
  const endpoint = { type: "socket", path: "/tmp/paseo daemon.sock" } as const;
  function inject(config = BASE_CONFIG, agentId = "agent-one", token = "token-one") {
    return withRuntimePaseoMcpServer({
      config,
      agentId,
      mcpEndpoint: endpoint,
      mcpAuthToken: token,
    });
  }

  test("keeps capability credentials out of command arguments and stored configuration", () => {
    const result = inject({
      ...BASE_CONFIG,
      mcpServers: { custom: { type: "stdio", command: "custom" } },
    });
    const server = result.mcpServers?.paseo;
    expect(server?.type).toBe("stdio");
    if (server?.type !== "stdio") throw new Error("Missing stdio server");
    expect(server.args).toEqual(
      expect.arrayContaining(["--socket", endpoint.path, "--agent-id", "agent-one"]),
    );
    expect(server.args?.join(" ")).not.toContain("token-one");
    expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", PASEO_AGENT_MCP_TOKEN: "token-one" });
    expect(stripInternalPaseoMcpServer(result).mcpServers).toEqual({
      custom: { type: "stdio", command: "custom" },
    });
  });

  test("rebinds stale stdio injection to the current caller and token on resume", () => {
    const previous = inject();
    const current = inject(previous, "agent-two", "token-two");
    const server = current.mcpServers?.paseo;
    if (server?.type !== "stdio") throw new Error("Missing stdio server");
    expect(server.args).toContain("agent-two");
    expect(server.args).not.toContain("agent-one");
    expect(server.env?.PASEO_AGENT_MCP_TOKEN).toBe("token-two");
    expect(
      withRuntimePaseoMcpServer({
        config: previous,
        agentId: "agent-two",
        mcpEndpoint: null,
        mcpAuthToken: null,
      }).mcpServers,
    ).toBeUndefined();
  });

  test("preserves independently configured servers named paseo", () => {
    const config: AgentSessionConfig = {
      ...BASE_CONFIG,
      mcpServers: { paseo: { type: "stdio", command: "my-server", args: ["--stdio"] } },
    };
    expect(inject(config)).toEqual(config);
  });
});
