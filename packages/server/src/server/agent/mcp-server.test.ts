import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
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
import type { ScheduleService } from "../schedule/service.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import {
  createPaseoWorktree as createPaseoWorktreeService,
  type CreatePaseoWorktreeInput,
} from "../paseo-worktree-service.js";
import type { CreatePaseoWorktreeWorkflowFn } from "../worktree-session.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import type { GitHubService } from "../../services/github-service.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { PARENT_AGENT_ID_LABEL } from "../../shared/agent-labels.js";

const REPO_CWD = resolvePath("/tmp/repo");
const TARGET_CWD = resolvePath("/tmp/target");

interface LooseSafeParseResult {
  success: boolean;
  data: unknown;
  error: {
    issues: Array<{ path: Array<string | number>; message: string; code: string }>;
  };
}

interface LooseInputSchema {
  safeParseAsync(input: unknown): Promise<LooseSafeParseResult>;
}

interface LooseStructuredContent {
  [key: string]: unknown;
}

interface RegisteredMcpTool {
  inputSchema: LooseInputSchema;
  handler: (input: unknown) => Promise<{
    structuredContent: LooseStructuredContent;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

function lookupTool(
  server: Awaited<ReturnType<typeof createAgentMcpServer>>,
  name: string,
): RegisteredMcpTool | undefined {
  const tools: Record<string, RegisteredMcpTool> = Reflect.get(server, "_registeredTools");
  return tools[name];
}

function registeredTool(
  server: Awaited<ReturnType<typeof createAgentMcpServer>>,
  name: string,
): RegisteredMcpTool {
  const tool = lookupTool(server, name);
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  return tool;
}

function agentsOf(response: {
  structuredContent: LooseStructuredContent;
}): Array<Record<string, unknown>> {
  return z.array(z.record(z.unknown())).parse(response.structuredContent.agents);
}

type AgentManagerSpies = ReturnType<typeof buildAgentManagerSpies>;
type AgentStorageSpies = ReturnType<typeof buildAgentStorageSpies>;

interface TestDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  spies: {
    agentManager: AgentManagerSpies;
    agentStorage: AgentStorageSpies;
  };
}

function buildAgentManagerSpies() {
  return {
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
}

function buildAgentStorageSpies() {
  return {
    get: vi.fn().mockResolvedValue(null),
    setTitle: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    applySnapshot: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  };
}

function createTestDeps(): TestDeps {
  const agentManagerSpies = buildAgentManagerSpies();
  const agentStorageSpies = buildAgentStorageSpies();

  return {
    agentManager: agentManagerSpies as unknown as AgentManager,
    agentStorage: agentStorageSpies as unknown as AgentStorage,
    spies: {
      agentManager: agentManagerSpies,
      agentStorage: agentStorageSpies,
    },
  };
}

function createTerminalManagerStub(overrides: Partial<TerminalManager> = {}): TerminalManager {
  return {
    getTerminals: vi.fn().mockResolvedValue([]),
    createTerminal: vi.fn(),
    registerCwdEnv: vi.fn(),
    getTerminal: vi.fn(),
    getTerminalState: vi.fn().mockResolvedValue(null),
    killTerminal: vi.fn(),
    killTerminalAndWait: vi.fn().mockResolvedValue(undefined),
    captureTerminal: vi.fn().mockResolvedValue({ lines: [], totalLines: 0 }),
    listDirectories: vi.fn().mockReturnValue([]),
    killAll: vi.fn(),
    subscribeTerminalsChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as TerminalManager;
}

function createProviderDefinition(overrides: Partial<ProviderDefinition>): ProviderDefinition {
  const provider = overrides.id ?? "claude";
  return {
    id: provider,
    label: "Claude",
    description: "Test provider",
    enabled: true,
    defaultModeId: "default",
    modes: [],
    createClient: vi.fn(() => ({
      provider,
      capabilities: {
        supportsStreaming: false,
        supportsSessionPersistence: false,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      createSession: async () => {
        throw new Error("createSession is not used by this MCP provider test");
      },
      resumeSession: async () => {
        throw new Error("resumeSession is not used by this MCP provider test");
      },
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    })),
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
    mergePullRequest: async () => ({ success: true }),
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
  setupContinuations?: Array<"workspace" | "agent" | undefined>;
  startedAgentSetupIds?: string[];
}): CreatePaseoWorktreeWorkflowFn {
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const github = createGitHubServiceStub();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger: createTestLogger(),
    paseoHome: options.paseoHome,
    deps: { github },
  });

  return async (input, serviceOptions) => {
    options.setupContinuations?.push(serviceOptions?.setupContinuation?.kind);
    const result = await createPaseoWorktreeService(input, {
      github,
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
    });
    options.broadcasts.push(result.workspace.workspaceId);
    options.createdWorkspaceIds?.push(result.workspace.workspaceId);
    if (serviceOptions?.setupContinuation?.kind === "agent") {
      return {
        ...result,
        setupContinuation: {
          kind: "agent",
          startAfterAgentCreate: ({ agentId }) => {
            options.startedAgentSetupIds?.push(agentId);
          },
        },
      };
    }
    return result;
  };
}

describe("terminal MCP tools", () => {
  const logger = createTestLogger();

  it("captures terminal output through the terminal manager authority", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const captureTerminal = vi.fn().mockResolvedValue({
      lines: ["from worker scrollback"],
      totalLines: 42,
    });
    const terminalManager = createTerminalManagerStub({
      getTerminal: vi.fn().mockReturnValue({
        id: "term-1",
        name: "daemon",
        cwd: process.cwd(),
        getState: vi.fn().mockReturnValue({ scrollback: [], grid: [[]] }),
      }),
      captureTerminal,
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      terminalManager,
      logger,
    });
    const tool = registeredTool(server, "capture_terminal");

    const response = await tool.handler({
      terminalId: "term-1",
      scrollback: true,
      stripAnsi: false,
      start: -10,
      end: -1,
    });

    expect(captureTerminal).toHaveBeenCalledWith("term-1", {
      start: 0,
      end: -1,
      stripAnsi: false,
    });
    expect(response.structuredContent).toEqual({
      terminalId: "term-1",
      lines: ["from worker scrollback"],
      totalLines: 42,
    });
  });
});

describe("create_agent MCP tool", () => {
  const logger = createTestLogger();
  const existingCwd = process.cwd();

  it("requires a concise title no longer than 60 characters", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_agent");
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
    const tool = registeredTool(server, "create_agent");
    const parsed = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      provider: "codex/gpt-5.4",
      title: "Short title",
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.error.issues.some(
        (issue: { path: Array<string | number> }) => issue.path[0] === "initialPrompt",
      ),
    ).toBe(true);
  });

  it("requires provider as provider/model and rejects the old model field", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_agent");

    const missingProvider = await tool.inputSchema.safeParseAsync({
      cwd: existingCwd,
      mode: "default",
      title: "Short title",
      initialPrompt: "test",
    });
    expect(missingProvider.success).toBe(false);
    expect(
      missingProvider.error.issues.some(
        (issue: { path: Array<string | number> }) => issue.path[0] === "provider",
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
      tool.handler({
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
    const tool = registeredTool(server, "create_agent");

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

  it("accepts each create_worktree target mode", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_worktree");

    for (const target of [
      { mode: "branch-off", newBranch: "feature-x", base: "main" },
      { mode: "checkout-branch", branch: "head-ref" },
      { mode: "checkout-pr", prNumber: 42 },
    ] as const) {
      const parsed = await tool.inputSchema.safeParseAsync({ cwd: existingCwd, target });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects create_worktree without a target", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_worktree");

    const parsed = await tool.inputSchema.safeParseAsync({});
    expect(parsed.success).toBe(false);
  });

  it("surfaces createAgent validation failures", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockRejectedValue(
      new Error("Working directory does not exist: /path/that/does/not/exist"),
    );
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
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
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth bug" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
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
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
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
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Config test", model: "claude-sonnet-4-20250514" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      cwd: existingCwd,
      title: "Config test",
      mode: "auto",
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
    const setupContinuations: Array<"workspace" | "agent" | undefined> = [];
    const startedAgentSetupIds: string[] = [];

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

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
          setupContinuations,
          startedAgentSetupIds,
        }),
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
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
      expect(setupContinuations).toEqual(["agent"]);
      expect(startedAgentSetupIds).toEqual(["agent-with-worktree"]);
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

  it("creates a create_agent branch-off worktree without invoking the legacy metadata branch rename", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-worktree-name-context-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => {
        throw new Error("agent metadata branch rename should not run");
      }),
    };

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-auto-named-worktree",
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
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees"
        >,
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        cwd: repoDir,
        title: "Worktree agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Fix workspace creation naming",
        action: "branch-off",
        baseBranch: "main",
        background: true,
      });

      const agentCwd = z.string().parse(spies.agentManager.createAgent.mock.calls[0]?.[0].cwd);
      const initialBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: agentCwd,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(initialBranch).not.toBe("");
      expect(initialBranch).not.toBe("main");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
      expect(broadcasts).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not auto-rename a create_agent checkout worktree from the initial prompt", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-checkout-name-context-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => {
        throw new Error("agent metadata branch rename should not run");
      }),
    };

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["checkout", "-b", "existing-feature"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "feature.txt"), "feature\n");
      execFileSync("git", ["add", "feature.txt"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-checkout-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Checkout agent" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees"
        >,
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        cwd: repoDir,
        title: "Checkout agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Rename this checkout from the prompt",
        action: "checkout",
        refName: "existing-feature",
        background: true,
      });

      const agentCwd = z.string().parse(spies.agentManager.createAgent.mock.calls[0]?.[0].cwd);
      expect(
        execFileSync("git", ["branch", "--show-current"], { cwd: agentCwd, stdio: "pipe" })
          .toString()
          .trim(),
      ).toBe("existing-feature");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
      expect(broadcasts).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes create_agent GitHub PR worktrees through workspace creation without metadata branch rename", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const startedAgentSetupIds: string[] = [];
    const createPaseoWorktree = vi.fn(
      async (
        input: CreatePaseoWorktreeInput,
        options?: Parameters<CreatePaseoWorktreeWorkflowFn>[1],
      ) => ({
        worktree: {
          branchName: "pr-123",
          worktreePath: "/tmp/worktrees/pr-123",
        },
        intent: {
          kind: "checkout-github-pr" as const,
          githubPrNumber: input.githubPrNumber ?? 123,
          headRef: "pr-123",
          baseRefName: "main",
        },
        workspace: {
          workspaceId: "/tmp/worktrees/pr-123",
          projectId: REPO_CWD,
          cwd: "/tmp/worktrees/pr-123",
          kind: "worktree" as const,
          displayName: "pr-123",
          createdAt: "2026-04-30T00:00:00.000Z",
          updatedAt: "2026-04-30T00:00:00.000Z",
          archivedAt: null,
        },
        repoRoot: REPO_CWD,
        created: true,
        ...(options?.setupContinuation?.kind === "agent"
          ? {
              setupContinuation: {
                kind: "agent" as const,
                startAfterAgentCreate: ({ agentId }: { agentId: string }) => {
                  startedAgentSetupIds.push(agentId);
                },
              },
            }
          : {}),
      }),
    );
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => {
        throw new Error("agent metadata branch rename should not run");
      }),
    };
    spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
      id: "agent-pr-worktree",
      cwd: config.cwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "PR agent" },
    }));

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      createPaseoWorktree,
      workspaceGitService: workspaceGitService as unknown as Pick<
        WorkspaceGitService,
        "getSnapshot" | "listWorktrees"
      >,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      cwd: REPO_CWD,
      title: "PR agent",
      provider: "codex/gpt-5.4",
      initialPrompt: "Rename this PR branch from prompt",
      githubPrNumber: 123,
      background: true,
    });

    expect(createPaseoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        githubPrNumber: 123,
        firstAgentContext: { prompt: "Rename this PR branch from prompt" },
      }),
      expect.objectContaining({
        setupContinuation: expect.objectContaining({ kind: "agent" }),
      }),
    );
    expect(startedAgentSetupIds).toEqual(["agent-pr-worktree"]);
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktrees/pr-123" }),
      undefined,
      undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
  });

  it("registers and broadcasts a workspace when create_worktree creates a worktree", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-create-worktree-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const setupContinuations: Array<"workspace" | "agent" | undefined> = [];

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });
      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
      };

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          setupContinuations,
        }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees"
        >,
        logger,
      });
      const tool = registeredTool(server, "create_worktree");
      const response = await tool.handler({
        cwd: repoDir,
        target: { mode: "branch-off", newBranch: "tool-worktree", base: "main" },
      });

      expect(response.structuredContent.branchName).toBe("tool-worktree");
      expect(response.structuredContent.worktreePath).toContain("tool-worktree");
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
      expect(setupContinuations).toEqual([undefined]);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toContain("tool-worktree");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forces a workspace git snapshot refresh when archive_worktree deletes a worktree", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = realpathSync.native(
      await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-")),
    );
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
      };
      const archiveWorkspaceRecord = vi.fn(async () => undefined);
      const emitWorkspaceUpdatesForWorkspaceIds = vi.fn(async () => undefined);
      const markWorkspaceArchiving = vi.fn();
      const clearWorkspaceArchiving = vi.fn();
      const emitSessionMessage = vi.fn();
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees"
        >,
        archiveWorkspaceRecord,
        emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving,
        clearWorkspaceArchiving,
        emitSessionMessage,
        github: createGitHubServiceStub(),
        logger,
      });
      const createTool = registeredTool(server, "create_worktree");
      const archiveTool = registeredTool(server, "archive_worktree");
      const created = await createTool.handler({
        cwd: repoDir,
        target: { mode: "branch-off", newBranch: "archive-tool-worktree", base: "main" },
      });
      workspaceGitService.getSnapshot.mockClear();

      await archiveTool.handler({
        cwd: repoDir,
        worktreePath: created.structuredContent.worktreePath,
      });

      expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "archive-worktree",
      });
      expect(archiveWorkspaceRecord).toHaveBeenCalledWith(created.structuredContent.worktreePath);
      expect(markWorkspaceArchiving).toHaveBeenCalledWith(
        [created.structuredContent.worktreePath],
        expect.any(String),
      );
      expect(clearWorkspaceArchiving).toHaveBeenCalledWith([
        created.structuredContent.worktreePath,
      ]);
      expect(Array.from(emitWorkspaceUpdatesForWorkspaceIds.mock.calls[0]?.[0] ?? [])).toEqual([
        created.structuredContent.worktreePath,
      ]);
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
      workspaceGitService: workspaceGitService as unknown as Pick<
        WorkspaceGitService,
        "getSnapshot" | "listWorktrees"
      >,
      logger,
    });
    const tool = registeredTool(server, "list_worktrees");

    const response = await tool.handler({ cwd: REPO_CWD });

    expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith(REPO_CWD, {
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
    const tool = registeredTool(server, "create_agent");

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

    const tool = registeredTool(server, "create_agent");
    await tool.handler({
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
          [PARENT_AGENT_ID_LABEL]: "voice-agent",
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
      cwd: REPO_CWD,
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
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      cwd: existingCwd,
      title: "Injected config test",
      mode: "auto",
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

  it("rejects an explicit mode that is not valid for the target provider", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        cwd: existingCwd,
        title: "Bad mode",
        provider: "opencode/gpt-5.4",
        mode: "bypassPermissions",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow(
      "Invalid mode 'bypassPermissions' for provider 'opencode'. Available modes: build, full-access, plan",
    );
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("inherits the caller mode when the new agent uses the same provider", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "bypassPermissions",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      title: "Child",
      provider: "claude/claude-sonnet-4-20250514",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "bypassPermissions" }),
      undefined,
      expect.any(Object),
    );
  });

  it("refuses cross-provider mode inheritance when caller is not in an unattended mode", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      provider: "claude",
      currentModeId: "default",
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        title: "Child",
        provider: "opencode/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow(
      "cannot inherit mode 'default' from caller (provider 'claude') for new agent (provider 'opencode'). Pass an explicit mode. Available modes for 'opencode': build, full-access, plan",
    );
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("inherits the target provider's unattended mode when caller is unattended cross-provider", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "full-access",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      title: "Child",
      provider: "opencode/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "full-access" }),
      undefined,
      expect.any(Object),
    );
  });

  it("accepts an explicit valid mode across providers", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      title: "Child",
      provider: "opencode/gpt-5.4",
      mode: "build",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "build" }),
      undefined,
      expect.any(Object),
    );
  });
});

describe("create_schedule MCP tool", () => {
  const logger = createTestLogger();

  it("requires provider for new-agent schedules", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const create = vi.fn(async (input: CreateScheduleInput) => createStoredSchedule(input));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      scheduleService: { create } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await expect(
      tool.handler({
        prompt: "say hello",
        every: "5m",
        name: "Default schedule",
      }),
    ).rejects.toThrow("provider is required when target is new-agent");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps create_schedule provider overrides compatible with provider and provider/model forms", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const create = vi.fn(async (input: CreateScheduleInput) => createStoredSchedule(input));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      scheduleService: { create } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await tool.handler({
      prompt: "say hello",
      every: "5m",
      provider: "codex",
    });
    await tool.handler({
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
    const tool = registeredTool(server, "list_providers");
    const response = await tool.handler({});

    expect(response.structuredContent).toEqual({
      providers: [
        {
          id: "claude",
          label: "Claude",
          description: "Test provider",
          enabled: true,
          status: "available",
          modes: [{ id: "default", label: "Default", description: "Built-in mode" }],
        },
        {
          id: "zai",
          label: "ZAI",
          status: "available",
          description: "Custom Claude profile",
          enabled: true,
          modes: [{ id: "default", label: "Default", description: "Custom mode" }],
        },
      ],
    });
  });

  it("returns disabled providers with metadata without checking availability", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const baseProvider = createProviderDefinition({ id: "codex" });
    const client = baseProvider.createClient(logger);
    const isAvailable = vi.fn().mockResolvedValue(true);
    const createClient = vi.fn(() => ({ ...client, isAvailable }));
    const providerRegistry = {
      codex: createProviderDefinition({
        id: "codex",
        label: "Codex",
        description: "OpenAI coding agent",
        enabled: false,
        modes: [{ id: "read-only", label: "Read Only", description: "No edits" }],
        createClient,
      }),
    };

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerRegistry,
      logger,
    });
    const tool = registeredTool(server, "list_providers");
    const response = await tool.handler({});

    expect(response.structuredContent).toEqual({
      providers: [
        {
          id: "codex",
          label: "Codex",
          description: "OpenAI coding agent",
          enabled: false,
          status: "unavailable",
          modes: [{ id: "read-only", label: "Read Only", description: "No edits" }],
        },
      ],
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();
  });

  it("checks availability for enabled providers", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const baseProvider = createProviderDefinition({ id: "claude" });
    const client = baseProvider.createClient(logger);
    const isAvailable = vi.fn().mockResolvedValue(true);
    const providerRegistry = {
      claude: createProviderDefinition({
        createClient: vi.fn(() => ({ ...client, isAvailable })),
      }),
    };

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerRegistry,
      logger,
    });
    const tool = registeredTool(server, "list_providers");

    await tool.handler({});

    expect(providerRegistry.claude.createClient).toHaveBeenCalledTimes(1);
    expect(isAvailable).toHaveBeenCalledTimes(1);
  });
});

describe("model listing MCP tool", () => {
  const logger = createTestLogger();

  it("rejects disabled providers without fetching models", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const fetchModels = vi.fn().mockResolvedValue([
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
    const providerRegistry = {
      codex: createProviderDefinition({
        id: "codex",
        label: "Codex",
        enabled: false,
        fetchModels,
      }),
    };

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerRegistry,
      logger,
    });
    const tool = registeredTool(server, "list_models");

    await expect(tool.handler({ provider: "codex" })).rejects.toThrow(
      "Provider 'codex' is disabled",
    );
    expect(fetchModels).not.toHaveBeenCalled();
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
    const tool = registeredTool(server, "speak");
    expect(tool).toBeDefined();

    await tool.handler({ text: "Hello from voice agent." });
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
    const tool = registeredTool(server, "speak");
    await expect(tool.handler({ text: "Hello." })).rejects.toThrow(
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
    const tool = lookupTool(server, "speak");
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
        cwd: REPO_CWD,
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
        runtimeInfo: { provider: "codex", sessionId: "session-123", model: "gpt-5.4" },
        labels: { role: "researcher" },
      }),
    ]);

    const server = await createAgentMcpServer({ agentManager, agentStorage, logger });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});
    const structured = z
      .object({ agents: z.array(z.record(z.unknown())) })
      .parse(response.structuredContent);

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
          cwd: REPO_CWD,
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
      },
    });
    const tool = registeredTool(server, "get_agent_status");
    const response = await tool.handler({ agentId: "archived-agent" });

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
    const tool = registeredTool(server, "get_agent_status");
    const response = await tool.handler({ agentId: "full-detail-agent" });
    const snapshot = z.record(z.unknown()).parse(response.structuredContent.snapshot);

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
      },
    });
    const tool = registeredTool(server, "get_agent_status");

    await expect(tool.handler({ agentId: "internal-agent" })).rejects.toThrow(
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
      },
      callerAgentId: "caller-agent",
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});

    const agentIds = agentsOf(response).map((agent) => agent.id);
    expect(agentIds).toHaveLength(3);
    expect(new Set(agentIds)).toEqual(new Set(["in-cwd", "in-child-cwd", "stored-in-cwd"]));
  });

  it("allows explicit cwd, status, archive, time, and limit filters for list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    const recent = new Date(now - 60 * 60 * 1000).toISOString();
    const old = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "running-target",
        cwd: TARGET_CWD,
        lifecycle: "running",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "idle-target",
        cwd: TARGET_CWD,
        lifecycle: "idle",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "old-running-target",
        cwd: TARGET_CWD,
        lifecycle: "running",
        createdAt: new Date(old),
        updatedAt: new Date(old),
      }),
    ]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({ id: "recent-archived", cwd: TARGET_CWD, archivedAt: recent }),
      createStoredRecord({ id: "old-archived", cwd: TARGET_CWD, archivedAt: old }),
      createStoredRecord({
        id: "recent-other-cwd",
        cwd: resolvePath("/tmp/other"),
        archivedAt: recent,
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerRegistry: {
        claude: createProviderDefinition({}),
      },
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({
      cwd: TARGET_CWD,
      includeArchived: true,
      sinceHours: 48,
      statuses: ["running", "closed"],
      limit: 3,
    });

    expect(agentsOf(response).map((agent) => agent.id)).toEqual([
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
      },
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ includeArchived: true });
    const agentIds = agentsOf(response).map((agent) => agent.id);

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
        cwd: REPO_CWD,
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
      },
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ cwd: REPO_CWD, includeArchived: true });
    const item = agentsOf(response)[0];

    expect(item).toEqual({
      id: "stored-archived-compact",
      shortId: "stored-",
      title: "Stored agent",
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      status: "closed",
      cwd: REPO_CWD,
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
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});

    expect(agentsOf(response).map((agent) => agent.id)).toEqual([
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
      },
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ includeArchived: true });

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
      },
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "archived-activity-agent" });

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

  it("get_agent_activity limit counts projected messages, not raw deltas", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const snapshot = createManagedAgent({ id: "live-activity-agent", currentModeId: "default" });
    spies.agentManager.getAgent.mockReturnValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      { type: "user_message", text: "Say hi" },
      { type: "assistant_message", text: "Hello " },
      { type: "assistant_message", text: "world" },
      { type: "assistant_message", text: "." },
      { type: "assistant_message", text: " How" },
      { type: "assistant_message", text: " are" },
      { type: "assistant_message", text: " you?" },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger: createTestLogger(),
      providerRegistry: {
        claude: createProviderDefinition({}),
      },
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "live-activity-agent", limit: 1 });

    const content = String(response.structuredContent.content);
    expect(content).toContain("Hello world. How are you?");
  });

  it("get_agent_activity limit=2 returns the last two projected entries whole", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const snapshot = createManagedAgent({ id: "live-activity-agent-2", currentModeId: "default" });
    spies.agentManager.getAgent.mockReturnValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      { type: "user_message", text: "u1" },
      { type: "assistant_message", text: "first " },
      { type: "assistant_message", text: "answer" },
      { type: "user_message", text: "u2" },
      { type: "assistant_message", text: "second " },
      { type: "assistant_message", text: "answer" },
      { type: "user_message", text: "u3" },
      { type: "assistant_message", text: "third " },
      { type: "assistant_message", text: "answer" },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger: createTestLogger(),
      providerRegistry: {
        claude: createProviderDefinition({}),
      },
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "live-activity-agent-2", limit: 2 });

    const content = String(response.structuredContent.content);
    expect(content).toContain("[User] u3");
    expect(content).toContain("third answer");
    expect(content).not.toContain("[User] u2");
    expect(content).not.toContain("second answer");
    expect(content).not.toContain("first answer");
  });
});
