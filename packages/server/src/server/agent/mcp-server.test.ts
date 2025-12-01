import { describe, expect, it, vi } from "vitest";

import { createAgentMcpServer } from "./mcp-server.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentRegistry } from "./agent-registry.js";

type TestDeps = {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  spies: {
    agentManager: Record<string, any>;
    agentRegistry: Record<string, any>;
  };
};

function createTestDeps(): TestDeps {
  const agentManagerSpies = {
    createAgent: vi.fn(),
    waitForAgentEvent: vi.fn(),
    recordUserMessage: vi.fn(),
    setAgentMode: vi.fn(),
    getAgent: vi.fn(),
    streamAgent: vi.fn(() => (async function* noop() {})()),
    respondToPermission: vi.fn(),
    cancelAgentRun: vi.fn(),
    getPendingPermissions: vi.fn(),
  };

  const agentRegistrySpies = {
    get: vi.fn().mockResolvedValue(null),
    setTitle: vi.fn().mockResolvedValue(undefined),
    applySnapshot: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  };

  return {
    agentManager: agentManagerSpies as unknown as AgentManager,
    agentRegistry: agentRegistrySpies as unknown as AgentRegistry,
    spies: {
      agentManager: agentManagerSpies,
      agentRegistry: agentRegistrySpies,
    },
  };
}

describe("create_agent MCP tool", () => {
  it("requires a concise title no longer than 40 characters", async () => {
    const { agentManager, agentRegistry } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentRegistry });
    const tool = (server as any)._registeredTools["create_agent"];
    expect(tool).toBeDefined();

    const missingTitle = await tool.inputSchema.safeParseAsync({
      cwd: "/tmp/repo",
    });
    expect(missingTitle.success).toBe(false);
    expect(missingTitle.error.issues[0].path).toEqual(["title"]);

    const tooLong = await tool.inputSchema.safeParseAsync({
      cwd: "/tmp/repo",
      title: "x".repeat(41),
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error.issues[0].path).toEqual(["title"]);

    const ok = await tool.inputSchema.safeParseAsync({
      cwd: "/tmp/repo",
      title: "Short title",
    });
    expect(ok.success).toBe(true);
  });

  it("persists provided titles immediately after agent creation", async () => {
    const { agentManager, agentRegistry, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-123",
      cwd: "/tmp/repo",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentRegistry });
    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: "/tmp/repo",
      title: "  Fix auth bug  ",
    });

    expect(spies.agentRegistry.setTitle).toHaveBeenCalledWith(
      "agent-123",
      "Fix auth bug"
    );
  });
});
