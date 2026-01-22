import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
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
  const logger = createTestLogger();

  it("requires a concise title no longer than 60 characters", async () => {
    const { agentManager, agentRegistry } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentRegistry, logger });
    const tool = (server as any)._registeredTools["create_agent"];
    expect(tool).toBeDefined();

    const missingTitle = await tool.inputSchema.safeParseAsync({
      cwd: "/tmp/repo",
      initialMode: "default",
    });
    expect(missingTitle.success).toBe(false);
    expect(missingTitle.error.issues[0].path).toEqual(["title"]);

    const tooLong = await tool.inputSchema.safeParseAsync({
      cwd: "/tmp/repo",
      initialMode: "default",
      title: "x".repeat(61),
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error.issues[0].path).toEqual(["title"]);

    const ok = await tool.inputSchema.safeParseAsync({
      cwd: "/tmp/repo",
      initialMode: "default",
      title: "Short title",
    });
    expect(ok.success).toBe(true);
  });

  it("passes caller-provided titles directly into createAgent", async () => {
    const { agentManager, agentRegistry, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-123",
      cwd: "/tmp/repo",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentRegistry, logger });
    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: "/tmp/repo",
      title: "  Fix auth bug  ",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/repo",
        title: "Fix auth bug",
      })
    );
  });

  it("set_title trims and persists titles for caller agent", async () => {
    const { agentManager, agentRegistry, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "agent-1",
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentRegistry,
      logger,
      callerAgentId: "agent-1",
    });
    const tool = (server as any)._registeredTools["set_title"];

    await tool.callback({ title: "  Fix auth  " });

    expect(spies.agentRegistry.setTitle).toHaveBeenCalledWith(
      "agent-1",
      "Fix auth"
    );
  });
});
