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
    setLabels: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    archiveAgent: vi.fn().mockResolvedValue({ archivedAt: new Date().toISOString() }),
    notifyAgentState: vi.fn(),
    getAgent: vi.fn(),
    streamAgent: vi.fn(() => (async function* noop() {})()),
    respondToPermission: vi.fn(),
    cancelAgentRun: vi.fn(),
    getPendingPermissions: vi.fn(),
  };

  const agentStorageSpies = {
    get: vi.fn().mockResolvedValue(null),
    setTitle: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
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
      mode: "default",
      initialPrompt: "test",
    });
    expect(missingTitle.success).toBe(false);
    expect(missingTitle.error.issues[0].path).toEqual(["title"]);

    const tooLong = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      title: "x".repeat(61),
      initialPrompt: "test",
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error.issues[0].path).toEqual(["title"]);

    const ok = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
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
      mode: "default",
      title: "Short title",
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.error.issues.some((issue: { path: string[] }) => issue.path[0] === "initialPrompt"),
    ).toBe(true);
  });

  it("surfaces createAgent validation failures", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockRejectedValue(
      new Error("Working directory does not exist: /path/that/does/not/exist"),
    );
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];

    await expect(
      tool.callback({
        cwd: "/path/that/does/not/exist",
        title: "Short title",
        initialPrompt: "Do work",
      }),
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
      undefined,
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
      undefined,
    );
  });

  it("passes optional model, thinking, and labels through createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-789",
      cwd: "/tmp/repo",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Config test", model: "claude-sonnet-4-20250514" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: existingCwd,
      title: "Config test",
      mode: "default",
      initialPrompt: "Do work",
      model: "claude-sonnet-4-20250514",
      thinking: "think-hard",
      labels: { source: "mcp" },
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
        title: "Config test",
        model: "claude-sonnet-4-20250514",
        thinkingOptionId: "think-hard",
      }),
      undefined,
      { labels: { source: "mcp" } },
    );
  });

  it("allows caller agents to override cwd and applies caller context labels", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const baseDir = await mkdtemp(join(tmpdir(), "paseo-mcp-test-"));
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
      callerAgentId: "voice-agent",
      resolveCallerContext: () => ({
        childAgentDefaultLabels: { source: "voice" },
        allowCustomCwd: true,
      }),
      logger,
    });

    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: "subdir",
      title: "Child",
      provider: "codex",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: subdir,
      }),
      undefined,
      {
        labels: {
          "paseo.parent-agent-id": "voice-agent",
          source: "voice",
        },
      },
    );
    await rm(baseDir, { recursive: true, force: true });
  });

  it("delegates MCP injection to AgentManager and passes through an undefined agent ID", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-injected-123",
      cwd: "/tmp/repo",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Injected config test" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
    });
    const tool = (server as any)._registeredTools["create_agent"];
    await tool.callback({
      cwd: existingCwd,
      title: "Injected config test",
      mode: "default",
      initialPrompt: "Do work",
    });

    const [configArg, agentIdArg, optionsArg] = spies.agentManager.createAgent.mock.calls[0];
    expect(configArg).toMatchObject({
      cwd: existingCwd,
      title: "Injected config test",
    });
    expect(configArg.mcpServers).toBeUndefined();
    expect(agentIdArg).toBeUndefined();
    expect(optionsArg).toBeUndefined();
  });
});

describe("speak MCP tool", () => {
  const logger = createTestLogger();

  it("invokes registered speak handler for caller agent", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const speak = vi.fn().mockResolvedValue(undefined);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "voice-agent-1",
      enableVoiceTools: true,
      resolveSpeakHandler: () => speak,
      logger,
    });
    const tool = (server as any)._registeredTools["speak"];
    expect(tool).toBeDefined();

    await tool.callback({ text: "Hello from voice agent." });
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from voice agent.",
        callerAgentId: "voice-agent-1",
      }),
    );
  });

  it("fails when no speak handler exists", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "voice-agent-2",
      enableVoiceTools: true,
      resolveSpeakHandler: () => null,
      logger,
    });
    const tool = (server as any)._registeredTools["speak"];
    await expect(tool.callback({ text: "Hello." })).rejects.toThrow(
      "No speak handler registered for caller agent",
    );
  });

  it("does not register speak tool unless voice tools are enabled", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "agent-no-voice",
      logger,
    });
    const tool = (server as any)._registeredTools["speak"];
    expect(tool).toBeUndefined();
  });
});

describe("agent snapshot MCP serialization", () => {
  const logger = createTestLogger();

  it("normalizes null features to an empty array for list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listAgents = vi.fn().mockReturnValue([
      {
        id: "agent-null-features",
        provider: "claude",
        cwd: "/tmp/repo",
        config: {},
        runtimeInfo: undefined,
        createdAt: new Date("2026-04-11T00:00:00.000Z"),
        updatedAt: new Date("2026-04-11T00:00:00.000Z"),
        lastUserMessageAt: null,
        lifecycle: "idle",
        capabilities: {
          supportsStreaming: false,
          supportsSessionPersistence: false,
          supportsDynamicModes: false,
          supportsMcpServers: true,
          supportsReasoningStream: false,
          supportsToolInvocations: true,
        },
        currentModeId: null,
        availableModes: [],
        features: null,
        pendingPermissions: new Map(),
        persistence: null,
        labels: {},
        attention: { requiresAttention: false },
      } as unknown as ManagedAgent,
    ]);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["list_agents"];
    const response = await tool.callback({});
    const structured = response.structuredContent;

    expect(structured).toEqual({
      agents: [
        expect.objectContaining({
          id: "agent-null-features",
          features: [],
        }),
      ],
    });
    expect(Array.isArray(structured.agents[0].features)).toBe(true);
  });
});
