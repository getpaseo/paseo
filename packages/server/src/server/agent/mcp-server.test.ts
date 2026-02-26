import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createAgentMcpServer } from "./mcp-server.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

type TestDeps = {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  spies: {
    agentManager: Record<string, any>;
    agentStorage: Record<string, any>;
  };
};

function createTestDeps(): TestDeps {
  const agentManagerSpies = {
    createAgent: vi.fn(),
    waitForAgentEvent: vi.fn(),
    recordUserMessage: vi.fn(),
    setAgentMode: vi.fn(),
    setTitle: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn(),
    streamAgent: vi.fn(() => (async function* noop() {})()),
    respondToPermission: vi.fn(),
    cancelAgentRun: vi.fn(),
    getPendingPermissions: vi.fn(),
  };

  const agentStorageSpies = {
    get: vi.fn().mockResolvedValue(null),
    setTitle: vi.fn().mockResolvedValue(undefined),
    applySnapshot: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  };

  return {
    agentManager: agentManagerSpies as unknown as AgentManager,
    agentStorage: agentStorageSpies as unknown as AgentStorage,
    spies: {
      agentManager: agentManagerSpies,
      agentStorage: agentStorageSpies,
    },
  };
}

describe("create_agent MCP tool", () => {
  const logger = createTestLogger();
  const existingCwd = process.cwd();

  it("requires a concise title no longer than 60 characters", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];
    expect(tool).toBeDefined();

    const missingTitle = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      initialMode: "default",
      initialPrompt: "test",
    });
    expect(missingTitle.success).toBe(false);
    expect(missingTitle.error.issues[0].path).toEqual(["title"]);

    const tooLong = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      initialMode: "default",
      title: "x".repeat(61),
      initialPrompt: "test",
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error.issues[0].path).toEqual(["title"]);

    const ok = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      initialMode: "default",
      title: "Short title",
      initialPrompt: "test",
    });
    expect(ok.success).toBe(true);
  });

  it("requires initialPrompt", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];
    const parsed = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      initialMode: "default",
      title: "Short title",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues.some((issue: { path: string[] }) => issue.path[0] === "initialPrompt")).toBe(true);
  });

  it("surfaces createAgent validation failures", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockRejectedValue(
      new Error("Working directory does not exist: /path/that/does/not/exist")
    );
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];

    await expect(
      tool.callback({
        cwd: "/path/that/does/not/exist",
        title: "Short title",
        initialPrompt: "Do work",
      })
    ).rejects.toThrow("Working directory does not exist");
  });

  it("passes caller-provided titles directly into createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-123",
      cwd: "/tmp/repo",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth bug" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: existingCwd,
      title: "  Fix auth bug  ",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
        title: "Fix auth bug",
      }),
      undefined,
      undefined
    );
  });

  it("trims caller-provided titles before createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-456",
      cwd: "/tmp/repo",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: existingCwd,
      title: "  Fix auth  ",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix auth",
      }),
      undefined,
      undefined
    );
  });

  it("allows caller agents to override cwd and applies caller context labels", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const baseDir = await mkdtemp(join(tmpdir(), "junction-mcp-test-"));
    const subdir = join(baseDir, "subdir");
    await mkdir(subdir, { recursive: true });
    spies.agentManager.getAgent.mockReturnValue({
      id: "voice-agent",
      cwd: baseDir,
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: subdir,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: "subdir",
      title: "Child",
      agentType: "codex",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: subdir,
      }),
    );
    await rm(baseDir, { recursive: true, force: true });
  });
});
