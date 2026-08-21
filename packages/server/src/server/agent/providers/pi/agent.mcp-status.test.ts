import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { PiRpcAgentSession } from "./agent.js";
import type { AgentCapabilityFlags, McpServerConfig } from "../../agent-sdk-types.js";

/**
 * Pi only accepts MCP config when the `pi-mcp-adapter` extension is loaded, and that is
 * exactly what `supportsMcpServers` encodes — so the status capability moves with it.
 */
function createSession(options: {
  mcpServers?: Record<string, McpServerConfig>;
  supportsMcpServers?: boolean;
}): PiRpcAgentSession {
  const supportsMcpServers = options.supportsMcpServers ?? true;
  const capabilities = {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers,
    supportsMcpStatus: supportsMcpServers,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  } satisfies AgentCapabilityFlags;

  return new PiRpcAgentSession({
    // The session subscribes on construction; nothing else here touches the runtime.
    runtimeSession: { onEvent: () => () => {} } as never,
    config: {
      provider: "pi",
      cwd: "/tmp/pi-mcp-status-test",
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    },
    initialState: {} as never,
    capabilities,
    logger: createTestLogger(),
  });
}

describe("Pi MCP status", () => {
  test("lists the servers Paseo wrote into the per-agent mcp.json", async () => {
    const session = createSession({
      mcpServers: {
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" },
        brain: { type: "stdio", command: "gbrain" },
      },
    });

    expect(await session.listMcpServers()).toEqual({
      servers: [
        { name: "brain", status: "unknown" },
        { name: "paseo", status: "unknown" },
      ],
      // The adapter has no status RPC, so nothing here has been verified.
      source: "configured",
    });
  });

  test("reports nothing when the adapter is absent, which is what clears the capability", async () => {
    const session = createSession({
      supportsMcpServers: false,
      mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } },
    });

    expect(session.capabilities.supportsMcpStatus).toBe(false);
    expect(await session.listMcpServers()).toEqual({ servers: [], source: "configured" });
  });

  test("reports an empty list when nothing was injected", async () => {
    expect(await createSession({}).listMcpServers()).toEqual({
      servers: [],
      source: "configured",
    });
  });
});
