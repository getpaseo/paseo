import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ACPAgentSession, DEFAULT_ACP_CAPABILITIES } from "./acp-agent.js";
import type { AgentCapabilityFlags, McpServerConfig } from "../agent-sdk-types.js";

function createSession(options: {
  mcpServers?: Record<string, McpServerConfig>;
  supportsMcpServers?: boolean;
}): ACPAgentSession {
  const capabilities: AgentCapabilityFlags = {
    ...DEFAULT_ACP_CAPABILITIES,
    supportsMcpServers: options.supportsMcpServers ?? true,
  };
  return new ACPAgentSession(
    {
      provider: "claude-acp",
      cwd: "/tmp/paseo-acp-mcp-test",
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    },
    {
      provider: "claude-acp",
      logger: createTestLogger(),
      defaultCommand: ["claude", "--acp"],
      defaultModes: [],
      capabilities,
    },
  );
}

/**
 * One test file for every ACP provider — Copilot, Cursor, Kimi, Kiro, Trae and the
 * generic adapter all run on ACPAgentSession, so the behaviour is shared.
 */
describe("ACP MCP status", () => {
  test("reports the servers Paseo injected, with their state left unknown", async () => {
    const session = createSession({
      mcpServers: {
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" },
        brain: { type: "stdio", command: "gbrain", args: ["mcp"] },
      },
    });

    expect(await session.listMcpServers()).toEqual({
      servers: [
        { name: "brain", status: "unknown" },
        { name: "paseo", status: "unknown" },
      ],
      source: "configured",
    });
  });

  test("marks the report configured, because ACP has no status channel to ask", async () => {
    const session = createSession({
      mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } },
    });
    expect((await session.listMcpServers()).source).toBe("configured");
  });

  test("advertises the capability only when servers were actually injected", () => {
    expect(
      createSession({ mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } } })
        .capabilities.supportsMcpStatus,
    ).toBe(true);

    // Nothing injected means the panel could only ever open on an empty list, so the
    // control should not exist. ACP can never report more than the config it was given.
    expect(createSession({}).capabilities.supportsMcpStatus).toBe(false);
  });

  test("drops the capability for an ACP agent that takes no MCP config", async () => {
    const session = createSession({
      supportsMcpServers: false,
      mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } },
    });

    expect(session.capabilities.supportsMcpStatus).toBe(false);
    // Even handed config, it reports nothing: Paseo never passes those servers to an
    // agent that cannot take them, so listing them would describe a fiction.
    expect(await session.listMcpServers()).toEqual({ servers: [], source: "configured" });
  });

  test("still answers with an empty list if asked despite the capability being off", async () => {
    // Defence in depth: the capability gate is the reason nothing asks, but a stale
    // snapshot could still send the request and it must not throw.
    expect(await createSession({}).listMcpServers()).toEqual({
      servers: [],
      source: "configured",
    });
  });
});
