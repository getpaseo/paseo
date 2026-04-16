import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createAgentMcpServer } from "./mcp-server.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { ProviderDefinition } from "./provider-registry.js";

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
    listAgents: vi.fn().mockReturnValue([]),
    getTimeline: vi.fn().mockReturnValue([]),
    resumeAgentFromPersistence: vi.fn(),
    hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
    hasInFlightRun: vi.fn().mockReturnValue(false),
    subscribe: vi.fn().mockReturnValue(() => {}),
    streamAgent: vi.fn(() => (async function* noop() {})()),
    respondToPermission: vi.fn(),
    cancelAgentRun: vi.fn(),
    getPendingPermissions: vi.fn(),
    getRegisteredProviderIds: vi.fn().mockReturnValue(["claude"]),
  };

  const agentStorageSpies = {
    get: vi.fn().mockResolvedValue(null),
    setTitle: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    applySnapshot: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
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

function createProviderDefinition(overrides: Partial<ProviderDefinition>): ProviderDefinition {
  return {
    id: "claude",
    label: "Claude",
    description: "Test provider",
    defaultModeId: "default",
    modes: [],
    createClient: vi.fn() as ProviderDefinition["createClient"],
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchModes: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createStoredRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = "2026-04-11T00:00:00.000Z";
  return {
    id: "stored-agent",
    provider: "claude",
    cwd: "/tmp/stored-project",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastUserMessageAt: null,
    title: "Stored agent",
    labels: {},
    lastStatus: "closed",
    lastModeId: "default",
    config: {
      modeId: "default",
      model: "claude-sonnet-4-20250514",
    },
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-123",
      model: "claude-sonnet-4-20250514",
    },
    features: [],
    persistence: {
      provider: "claude",
      sessionId: "session-123",
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
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

  it("accepts custom provider IDs in create_agent input validation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];

    const parsed = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      title: "Custom provider agent",
      initialMode: "default",
      agentType: "zai",
      initialPrompt: "Do work",
    });

    expect(parsed.success).toBe(true);
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

describe("provider listing MCP tool", () => {
  const logger = createTestLogger();

  it("returns providers from the registry, including custom providers", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const providerRegistry = {
      claude: createProviderDefinition({
        id: "claude",
        label: "Claude",
        modes: [{ id: "default", label: "Default", description: "Built-in mode" }],
      }),
      zai: createProviderDefinition({
        id: "zai",
        label: "ZAI",
        description: "Custom Claude profile",
        defaultModeId: "default",
        modes: [{ id: "default", label: "Default", description: "Custom mode" }],
      }),
    };

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerRegistry,
      logger,
    });
    const tool = (server as any)._registeredTools["list_providers"];
    const response = await tool.callback({});

    expect(response.structuredContent).toEqual({
      providers: [
        {
          id: "claude",
          label: "Claude",
          modes: [{ id: "default", label: "Default", description: "Built-in mode" }],
        },
        {
          id: "zai",
          label: "ZAI",
          modes: [{ id: "default", label: "Default", description: "Custom mode" }],
        },
      ],
    });
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

  it("returns archived agent snapshots from storage for get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const record = createStoredRecord({
      id: "archived-agent",
      archivedAt: "2026-04-12T00:00:00.000Z",
    });
    spies.agentManager.getAgent.mockReturnValue(null);
    spies.agentStorage.get.mockResolvedValue(record);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerRegistry: {
        claude: createProviderDefinition({}),
      } as any,
    });
    const tool = (server as any)._registeredTools["get_agent_status"];
    const response = await tool.callback({ agentId: "archived-agent" });

    expect(response.structuredContent).toEqual({
      status: "closed",
      snapshot: expect.objectContaining({
        id: "archived-agent",
        archivedAt: "2026-04-12T00:00:00.000Z",
        title: "Stored agent",
        status: "closed",
      }),
    });
    expect(spies.agentStorage.get).toHaveBeenCalledWith("archived-agent");
  });

  it("does not expose internal stored agents from get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue(null);
    spies.agentStorage.get.mockResolvedValue(
      createStoredRecord({
        id: "internal-agent",
        internal: true,
      }),
    );

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerRegistry: {
        claude: createProviderDefinition({}),
      } as any,
    });
    const tool = (server as any)._registeredTools["get_agent_status"];

    await expect(tool.callback({ agentId: "internal-agent" })).rejects.toThrow(
      "Agent internal-agent not found",
    );
  });

  it("includes stored non-archived agents in list_agents by default", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const liveAgent = {
      id: "live-agent",
      provider: "claude",
      cwd: "/tmp/live-project",
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
      features: [],
      pendingPermissions: new Map(),
      persistence: null,
      labels: {},
      attention: { requiresAttention: false },
    } as unknown as ManagedAgent;
    spies.agentManager.listAgents.mockReturnValue([liveAgent]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({ id: "closed-agent", archivedAt: null }),
      createStoredRecord({ id: "archived-agent", archivedAt: "2026-04-12T00:00:00.000Z" }),
      createStoredRecord({ id: "live-agent", archivedAt: null }),
      createStoredRecord({ id: "internal-agent", archivedAt: null, internal: true }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerRegistry: {
        claude: createProviderDefinition({}),
      } as any,
    });
    const tool = (server as any)._registeredTools["list_agents"];
    const response = await tool.callback({});

    expect(response.structuredContent.agents).toEqual([
      expect.objectContaining({ id: "live-agent" }),
      expect.objectContaining({ id: "closed-agent", archivedAt: null }),
    ]);
  });

  it("includes archived stored agents in list_agents when requested", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const liveAgent = {
      id: "live-agent",
      provider: "claude",
      cwd: "/tmp/live-project",
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
      features: [],
      pendingPermissions: new Map(),
      persistence: null,
      labels: {},
      attention: { requiresAttention: false },
    } as unknown as ManagedAgent;
    spies.agentManager.listAgents.mockReturnValue([liveAgent]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({ id: "archived-agent", archivedAt: "2026-04-12T00:00:00.000Z" }),
      createStoredRecord({ id: "live-agent", archivedAt: "2026-04-12T00:00:00.000Z" }),
      createStoredRecord({
        id: "internal-archived-agent",
        archivedAt: "2026-04-12T00:00:00.000Z",
        internal: true,
      }),
      createStoredRecord({ id: "not-archived-agent", archivedAt: null }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerRegistry: {
        claude: createProviderDefinition({}),
      } as any,
    });
    const tool = (server as any)._registeredTools["list_agents"];
    const response = await tool.callback({ includeArchived: true });

    expect(response.structuredContent.agents).toEqual([
      expect.objectContaining({ id: "live-agent" }),
      expect.objectContaining({
        id: "archived-agent",
        archivedAt: "2026-04-12T00:00:00.000Z",
      }),
      expect.objectContaining({
        id: "not-archived-agent",
        archivedAt: null,
      }),
    ]);
  });

  it("loads archived agents before reading get_agent_activity", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const record = createStoredRecord({ id: "archived-activity-agent" });
    const snapshot = {
      id: "archived-activity-agent",
      currentModeId: "default",
    } as ManagedAgent;
    spies.agentManager.getAgent
      .mockReturnValueOnce(null)
      .mockReturnValue(snapshot)
      .mockReturnValue(snapshot);
    spies.agentStorage.get.mockResolvedValue(record);
    spies.agentManager.resumeAgentFromPersistence.mockResolvedValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      {
        kind: "status",
        timestamp: "2026-04-11T00:00:00.000Z",
        text: "Agent resumed",
      },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerRegistry: {
        claude: createProviderDefinition({}),
      } as any,
    });
    const tool = (server as any)._registeredTools["get_agent_activity"];
    const response = await tool.callback({ agentId: "archived-activity-agent" });

    expect(response.structuredContent).toEqual(
      expect.objectContaining({
        agentId: "archived-activity-agent",
        updateCount: 1,
        currentModeId: "default",
      }),
    );
    expect(spies.agentManager.resumeAgentFromPersistence).toHaveBeenCalled();
    expect(spies.agentManager.hydrateTimelineFromProvider).toHaveBeenCalledWith(
      "archived-activity-agent",
    );
  });
});
