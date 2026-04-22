import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createAgentMcpServer } from "./mcp-server.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { ProviderDefinition } from "./provider-registry.js";
import { AgentListItemPayloadSchema, AgentSnapshotPayloadSchema } from "../../shared/messages.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreateScheduleInput, StoredSchedule } from "../schedule/types.js";
import {
  createPaseoWorktree as createPaseoWorktreeService,
  type CreatePaseoWorktreeFn,
} from "../paseo-worktree-service.js";
import { createWorktreeCoreDeps } from "../worktree-core.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import type { GitHubService } from "../../services/github-service.js";

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
    appendTimelineItem: vi.fn().mockResolvedValue(undefined),
    emitLiveTimelineItem: vi.fn().mockResolvedValue(undefined),
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

function createManagedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  const now = new Date();
  return {
    id: "live-agent",
    provider: "claude",
    cwd: "/tmp/live-project",
    config: {},
    runtimeInfo: undefined,
    createdAt: now,
    updatedAt: now,
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
    ...overrides,
  } as ManagedAgent;
}

function createGitHubServiceStub(): GitHubService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({ items: [], githubFeaturesEnabled: true }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createStoredSchedule(input: CreateScheduleInput): StoredSchedule {
  const now = "2026-04-11T00:00:00.000Z";
  return {
    id: "schedule-1",
    name: input.name ?? null,
    prompt: input.prompt,
    cadence: input.cadence,
    target: input.target,
    status: "active",
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: input.expiresAt ?? null,
    maxRuns: input.maxRuns ?? null,
    runs: [],
  };
}

function createPaseoWorktreeForMcpTest(options: {
  paseoHome: string;
  broadcasts: string[];
  createdWorkspaceIds?: string[];
}): CreatePaseoWorktreeFn {
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const github = createGitHubServiceStub();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger: createTestLogger(),
    paseoHome: options.paseoHome,
    deps: { github },
  });

  return async (input, serviceOptions) => {
    const coreDeps = createWorktreeCoreDeps(github);
    const result = await createPaseoWorktreeService(input, {
      ...coreDeps,
      ...(serviceOptions?.resolveDefaultBranch
        ? { resolveDefaultBranch: serviceOptions.resolveDefaultBranch }
        : {}),
      projectRegistry: {
        get: async (projectId) => projects.get(projectId) ?? null,
        upsert: async (record) => {
          projects.set(record.projectId, record);
        },
      },
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        list: async () => Array.from(workspaces.values()),
        upsert: async (record) => {
          workspaces.set(record.workspaceId, record);
        },
      },
      workspaceGitService,
      primeWorkspaceGitWatchFingerprints: async () => {},
      broadcastWorkspaceUpdate: async (workspaceId) => {
        options.broadcasts.push(workspaceId);
      },
    });
    options.createdWorkspaceIds?.push(result.workspace.workspaceId);
    return result;
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
      provider: "codex/gpt-5.4",
      initialPrompt: "test",
    });
    expect(missingTitle.success).toBe(false);
    expect(missingTitle.error.issues[0].path).toEqual(["title"]);

    const tooLong = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      provider: "codex/gpt-5.4",
      title: "x".repeat(61),
      initialPrompt: "test",
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error.issues[0].path).toEqual(["title"]);

    const ok = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      provider: "codex/gpt-5.4",
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
      provider: "codex/gpt-5.4",
      title: "Short title",
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.error.issues.some((issue: { path: string[] }) => issue.path[0] === "initialPrompt"),
    ).toBe(true);
  });

  it("requires provider as provider/model and rejects the old model field", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];

    const missingProvider = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      title: "Short title",
      initialPrompt: "test",
    });
    expect(missingProvider.success).toBe(false);
    expect(
      missingProvider.error.issues.some(
        (issue: { path: string[] }) => issue.path[0] === "provider",
      ),
    ).toBe(true);

    const providerWithoutModel = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      title: "Short title",
      provider: "codex",
      initialPrompt: "test",
    });
    expect(providerWithoutModel.success).toBe(false);

    const providerWithEmptyModel = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      title: "Short title",
      provider: "codex/",
      initialPrompt: "test",
    });
    expect(providerWithEmptyModel.success).toBe(false);

    const providerWithEmptyProvider = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      title: "Short title",
      provider: "/gpt-5.4",
      initialPrompt: "test",
    });
    expect(providerWithEmptyProvider.success).toBe(false);

    await expect(
      tool.callback({
        cwd: existingCwd,
        mode: "default",
        title: "Short title",
        provider: "codex/gpt-5.4",
        model: "gpt-5.4",
        initialPrompt: "test",
      }),
    ).rejects.toThrow("Unrecognized key");
  });

  it("accepts optional worktree intent fields in create_agent input validation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];

    const parsed = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      title: "Short title",
      provider: "codex/gpt-5.4",
      initialPrompt: "test",
      worktreeName: "review-42",
      action: "checkout",
      refName: "head-ref",
      githubPrNumber: 42,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts optional worktree intent fields in create_worktree input validation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_worktree"];

    const parsed = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      action: "checkout",
      refName: "head-ref",
      githubPrNumber: 42,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects create_worktree without a branch name or checkout intent", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_worktree"];

    await expect(tool.callback({})).rejects.toThrow(
      "create_worktree requires branchName, refName, or githubPrNumber",
    );
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
        provider: "codex/gpt-5.4",
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
      provider: "codex/gpt-5.4",
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
      provider: "codex/gpt-5.4",
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

  it("requires provider/model and passes thinking and labels through createAgent", async () => {
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
      provider: "codex/gpt-5.4",
      thinking: "think-hard",
      labels: { source: "mcp" },
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
        title: "Config test",
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "think-hard",
      }),
      undefined,
      { labels: { source: "mcp" } },
    );
  });

  it("registers and broadcasts a workspace when create_agent creates a worktree", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-worktree-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const createdWorkspaceIds: string[] = [];

    try {
      execSync(`git init ${JSON.stringify(repoDir)}`, { stdio: "pipe" });
      execSync("git config user.email test@example.com", { cwd: repoDir, stdio: "pipe" });
      execSync("git config user.name Test", { cwd: repoDir, stdio: "pipe" });
      execSync("git config commit.gpgsign false", { cwd: repoDir, stdio: "pipe" });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
      execSync("git commit -m init", { cwd: repoDir, stdio: "pipe" });
      execSync("git branch -M main", { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-with-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Worktree agent" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          createdWorkspaceIds,
        }),
        logger,
      });
      const tool = (server as any)._registeredTools["create_agent"];
      await tool.callback({
        cwd: repoDir,
        title: "Worktree agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
        worktreeName: "agent-worktree",
        baseBranch: "main",
        background: true,
      });

      expect(broadcasts).toHaveLength(1);
      expect(createdWorkspaceIds).toHaveLength(1);
      expect(broadcasts[0]).toBe(createdWorkspaceIds[0]);
      expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: expect.stringContaining("agent-worktree"),
        }),
        undefined,
        undefined,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("registers and broadcasts a workspace when create_worktree creates a worktree", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-create-worktree-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];

    try {
      execSync(`git init ${JSON.stringify(repoDir)}`, { stdio: "pipe" });
      execSync("git config user.email test@example.com", { cwd: repoDir, stdio: "pipe" });
      execSync("git config user.name Test", { cwd: repoDir, stdio: "pipe" });
      execSync("git config commit.gpgsign false", { cwd: repoDir, stdio: "pipe" });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
      execSync("git commit -m init", { cwd: repoDir, stdio: "pipe" });
      execSync("git branch -M main", { cwd: repoDir, stdio: "pipe" });
      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
      };

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts }),
        workspaceGitService: workspaceGitService as any,
        logger,
      });
      const tool = (server as any)._registeredTools["create_worktree"];
      const response = await tool.callback({
        cwd: repoDir,
        branchName: "tool-worktree",
        baseBranch: "main",
      });

      expect(response.structuredContent.branchName).toBe("tool-worktree");
      expect(response.structuredContent.worktreePath).toContain("tool-worktree");
      expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "create-worktree",
      });
      expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(
        response.structuredContent.worktreePath,
        {
          force: true,
          reason: "create-worktree",
        },
      );
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toContain("tool-worktree");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forces a workspace git snapshot refresh when archive_worktree deletes a worktree", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execSync(`git init ${JSON.stringify(repoDir)}`, { stdio: "pipe" });
      execSync("git config user.email test@example.com", { cwd: repoDir, stdio: "pipe" });
      execSync("git config user.name Test", { cwd: repoDir, stdio: "pipe" });
      execSync("git config commit.gpgsign false", { cwd: repoDir, stdio: "pipe" });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
      execSync("git commit -m init", { cwd: repoDir, stdio: "pipe" });
      execSync("git branch -M main", { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
      };
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as any,
        logger,
      });
      const createTool = (server as any)._registeredTools["create_worktree"];
      const archiveTool = (server as any)._registeredTools["archive_worktree"];
      const created = await createTool.callback({
        cwd: repoDir,
        branchName: "archive-tool-worktree",
        baseBranch: "main",
      });
      workspaceGitService.getSnapshot.mockClear();

      await archiveTool.callback({
        cwd: repoDir,
        worktreePath: created.structuredContent.worktreePath,
      });

      expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "archive-worktree",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("routes list_worktrees through WorkspaceGitService", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => null),
      listWorktrees: vi.fn(async () => [
        {
          path: "/tmp/paseo/worktrees/repo/feature",
          branchName: "feature",
          createdAt: "2026-04-12T00:00:00.000Z",
        },
      ]),
    };
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      workspaceGitService: workspaceGitService as any,
      logger,
    });
    const tool = (server as any)._registeredTools["list_worktrees"];

    const response = await tool.callback({ cwd: "/tmp/repo" });

    expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith("/tmp/repo", {
      reason: "mcp:list-worktrees",
    });
    expect(response.structuredContent.worktrees).toEqual([
      {
        path: "/tmp/paseo/worktrees/repo/feature",
        branchName: "feature",
        createdAt: "2026-04-12T00:00:00.000Z",
      },
    ]);
  });

  it("accepts custom provider IDs in create_agent input validation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["create_agent"];

    const parsed = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      title: "Custom provider agent",
      mode: "default",
      provider: "zai/custom-model",
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
      provider: "codex/gpt-5.4",
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
      provider: "codex/gpt-5.4",
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

describe("create_schedule MCP tool", () => {
  const logger = createTestLogger();

  it("preserves default new-agent schedule behavior without requiring provider", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const create = vi.fn(async (input: CreateScheduleInput) => createStoredSchedule(input));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      scheduleService: { create } as any,
      logger,
    });
    const tool = (server as any)._registeredTools["create_schedule"];

    const response = await tool.callback({
      prompt: "say hello",
      every: "5m",
      name: "Default schedule",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "say hello",
        target: {
          type: "new-agent",
          config: {
            provider: "claude",
            cwd: process.cwd(),
          },
        },
      }),
    );
    expect(response.structuredContent.target).toEqual({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: process.cwd(),
      },
    });
  });

  it("keeps create_schedule provider overrides compatible with provider and provider/model forms", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const create = vi.fn(async (input: CreateScheduleInput) => createStoredSchedule(input));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      scheduleService: { create } as any,
      logger,
    });
    const tool = (server as any)._registeredTools["create_schedule"];

    await tool.callback({
      prompt: "say hello",
      every: "5m",
      provider: "codex",
    });
    await tool.callback({
      prompt: "say hello again",
      every: "10m",
      provider: "codex/gpt-5.4",
    });

    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            cwd: process.cwd(),
          },
        },
      }),
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            cwd: process.cwd(),
            model: "gpt-5.4",
          },
        },
      }),
    );
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

  it("returns compact list items from list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listAgents = vi.fn().mockReturnValue([
      createManagedAgent({
        id: "agent-compact",
        provider: "codex",
        cwd: "/tmp/repo",
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
        runtimeInfo: { provider: "codex", sessionId: "session-123", model: "gpt-5.4" },
        labels: { role: "researcher" },
      }),
    ]);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["list_agents"];
    const response = await tool.callback({});
    const structured = response.structuredContent;

    expect(structured).toEqual({
      agents: [
        {
          id: "agent-compact",
          shortId: "agent-c",
          title: null,
          provider: "codex",
          model: "gpt-5.4",
          thinkingOptionId: "high",
          effectiveThinkingOptionId: "high",
          status: "idle",
          cwd: "/tmp/repo",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          lastUserMessageAt: null,
          archivedAt: null,
          requiresAttention: false,
          attentionReason: null,
          attentionTimestamp: null,
          labels: { role: "researcher" },
        },
      ],
    });
    expect(structured.agents[0]).not.toHaveProperty("features");
    expect(structured.agents[0]).not.toHaveProperty("availableModes");
    expect(structured.agents[0]).not.toHaveProperty("capabilities");
    expect(structured.agents[0]).not.toHaveProperty("runtimeInfo");
    expect(structured.agents[0]).not.toHaveProperty("persistence");
    expect(structured.agents[0]).not.toHaveProperty("pendingPermissions");
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

  it("returns full-detail snapshots from get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentStorage.get.mockResolvedValue({ title: "Full detail agent" });
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "full-detail-agent",
        provider: "codex",
        cwd: "/tmp/full-detail",
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
        runtimeInfo: {
          provider: "codex",
          sessionId: "session-full",
          model: "gpt-5.4",
          thinkingOptionId: "xhigh",
          modeId: "auto",
        },
        currentModeId: "auto",
        availableModes: [
          {
            id: "auto",
            label: "Auto",
            description: "Default coding mode",
          },
        ],
        features: [
          {
            type: "toggle",
            id: "web-search",
            label: "Web search",
            value: true,
          },
        ],
        pendingPermissions: new Map(),
        persistence: {
          provider: "codex",
          sessionId: "session-full",
        },
      }),
    );

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["get_agent_status"];
    const response = await tool.callback({ agentId: "full-detail-agent" });
    const snapshot = response.structuredContent.snapshot;

    const parsed = AgentSnapshotPayloadSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new Error(
        `get_agent_status response failed AgentSnapshotPayloadSchema: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    expect(response.structuredContent.status).toBe("idle");
    expect(snapshot).toEqual(
      expect.objectContaining({
        id: "full-detail-agent",
        title: "Full detail agent",
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "high",
        effectiveThinkingOptionId: "xhigh",
        currentModeId: "auto",
        runtimeInfo: {
          provider: "codex",
          sessionId: "session-full",
          model: "gpt-5.4",
          thinkingOptionId: "xhigh",
          modeId: "auto",
        },
        persistence: {
          provider: "codex",
          sessionId: "session-full",
        },
      }),
    );
    expect(snapshot.capabilities).toEqual(
      expect.objectContaining({
        supportsMcpServers: true,
        supportsToolInvocations: true,
      }),
    );
    expect(snapshot.availableModes).toEqual([
      {
        id: "auto",
        label: "Auto",
        description: "Default coding mode",
      },
    ]);
    expect(snapshot.features).toEqual([
      {
        type: "toggle",
        id: "web-search",
        label: "Web search",
        value: true,
      },
    ]);
    expect(snapshot.pendingPermissions).toEqual([]);
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

  it("defaults list_agents to caller cwd and excludes archived agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({ id: "caller-agent", cwd: "/tmp/workspace" }),
    );
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({ id: "in-cwd", cwd: "/tmp/workspace" }),
      createManagedAgent({ id: "in-child-cwd", cwd: "/tmp/workspace/packages/server" }),
      createManagedAgent({ id: "other-cwd", cwd: "/tmp/other" }),
    ]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-in-cwd",
        cwd: "/tmp/workspace",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      }),
      createStoredRecord({
        id: "archived-in-cwd",
        cwd: "/tmp/workspace",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: now,
      }),
      createStoredRecord({ id: "internal-agent", archivedAt: null, internal: true }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerRegistry: {
        claude: createProviderDefinition({}),
      } as any,
      callerAgentId: "caller-agent",
    });
    const tool = (server as any)._registeredTools["list_agents"];
    const response = await tool.callback({});

    expect(response.structuredContent.agents.map((agent: { id: string }) => agent.id)).toEqual([
      "in-cwd",
      "in-child-cwd",
      "stored-in-cwd",
    ]);
  });

  it("allows explicit cwd, status, archive, time, and limit filters for list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    const recent = new Date(now - 60 * 60 * 1000).toISOString();
    const old = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "running-target",
        cwd: "/tmp/target",
        lifecycle: "running",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "idle-target",
        cwd: "/tmp/target",
        lifecycle: "idle",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "old-running-target",
        cwd: "/tmp/target",
        lifecycle: "running",
        createdAt: new Date(old),
        updatedAt: new Date(old),
      }),
    ]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({ id: "recent-archived", cwd: "/tmp/target", archivedAt: recent }),
      createStoredRecord({ id: "old-archived", cwd: "/tmp/target", archivedAt: old }),
      createStoredRecord({ id: "recent-other-cwd", cwd: "/tmp/other", archivedAt: recent }),
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
    const response = await tool.callback({
      cwd: "/tmp/target",
      includeArchived: true,
      sinceHours: 48,
      statuses: ["running", "closed"],
      limit: 3,
    });

    expect(response.structuredContent.agents.map((agent: { id: string }) => agent.id)).toEqual([
      "running-target",
      "old-running-target",
      "recent-archived",
    ]);
  });

  it("bounds includeArchived by default time window and limit", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    const recentArchivedRecords = Array.from({ length: 55 }, (_, index) =>
      createStoredRecord({
        id: `recent-archived-${index.toString().padStart(2, "0")}`,
        archivedAt: new Date(now - index * 60 * 1000).toISOString(),
      }),
    );
    spies.agentStorage.list.mockResolvedValue([
      ...recentArchivedRecords,
      createStoredRecord({
        id: "old-archived",
        archivedAt: new Date(now - 49 * 60 * 60 * 1000).toISOString(),
      }),
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
    const agentIds = response.structuredContent.agents.map((agent: { id: string }) => agent.id);

    expect(agentIds).toHaveLength(50);
    expect(agentIds).toEqual(
      Array.from(
        { length: 50 },
        (_, index) => `recent-archived-${index.toString().padStart(2, "0")}`,
      ),
    );
    expect(agentIds).not.toContain("old-archived");
  });

  it("returns compact list items for stored archived agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-archived-compact",
        cwd: "/tmp/repo",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: now,
        features: [
          {
            type: "toggle",
            id: "danger-zone",
            label: "Danger zone",
            value: false,
          },
        ],
      }),
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
    const response = await tool.callback({ cwd: "/tmp/repo", includeArchived: true });
    const item = response.structuredContent.agents[0];

    expect(item).toEqual({
      id: "stored-archived-compact",
      shortId: "stored-",
      title: "Stored agent",
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      status: "closed",
      cwd: "/tmp/repo",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: now,
      lastUserMessageAt: null,
      archivedAt: now,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      labels: {},
    });
    expect(item).not.toHaveProperty("features");
    expect(item).not.toHaveProperty("availableModes");
    expect(item).not.toHaveProperty("capabilities");
    expect(item).not.toHaveProperty("runtimeInfo");
    expect(item).not.toHaveProperty("persistence");
    expect(item).not.toHaveProperty("pendingPermissions");
  });

  it("sorts list_agents by attention, status priority, then activity", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "idle-recent",
        lifecycle: "idle",
        updatedAt: new Date(now),
      }),
      createManagedAgent({
        id: "running-older",
        lifecycle: "running",
        updatedAt: new Date(now - 60 * 60 * 1000),
      }),
      createManagedAgent({
        id: "closed-newest",
        lifecycle: "closed",
        updatedAt: new Date(now + 60 * 1000),
      }),
      createManagedAgent({
        id: "initializing-middle",
        lifecycle: "initializing",
        updatedAt: new Date(now - 30 * 60 * 1000),
      }),
      createManagedAgent({
        id: "idle-attention-oldest",
        lifecycle: "idle",
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
        attention: {
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date(now - 2 * 60 * 60 * 1000),
        },
      }),
      createManagedAgent({
        id: "error-recent",
        lifecycle: "error",
        updatedAt: new Date(now),
      }),
    ]);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = (server as any)._registeredTools["list_agents"];
    const response = await tool.callback({});

    expect(response.structuredContent.agents.map((agent: { id: string }) => agent.id)).toEqual([
      "idle-attention-oldest",
      "running-older",
      "initializing-middle",
      "idle-recent",
      "error-recent",
      "closed-newest",
    ]);
  });

  it("emits list_agents payloads that satisfy the declared output schema", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentManager.listAgents.mockReturnValue([createManagedAgent()]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-non-archived",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      }),
      createStoredRecord({ id: "stored-archived", archivedAt: now }),
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

    const parsed = z.array(AgentListItemPayloadSchema).safeParse(response.structuredContent.agents);
    if (!parsed.success) {
      throw new Error(
        `list_agents response failed AgentListItemPayloadSchema: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
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
