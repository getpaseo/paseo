import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { Session } from "./session.js";
import type { AgentSnapshotPayload } from "../shared/messages.js";
import type { WorkspaceGitRuntimeSnapshot } from "./workspace-git-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

function makeAgent(input: {
  id: string;
  cwd: string;
  status: AgentSnapshotPayload["status"];
  updatedAt: string;
  pendingPermissions?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentSnapshotPayload["attentionReason"];
}): AgentSnapshotPayload {
  const pendingPermissionCount = input.pendingPermissions ?? 0;
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    lastUserMessageAt: null,
    status: input.status,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: Array.from({ length: pendingPermissionCount }, (_, index) => ({
      id: `perm-${input.id}-${index}`,
      provider: "codex",
      name: "tool",
      kind: "tool",
    })),
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    labels: {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: null,
    archivedAt: null,
  };
}

function createNoopWorkspaceGitService() {
  return {
    subscribe: async (params: { cwd: string }) => ({
      initial: {
        cwd: params.cwd,
        git: {
          isGit: false,
          repoRoot: null,
          mainRepoRoot: null,
          currentBranch: null,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          isDirty: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          diffStat: null,
        },
        github: {
          featuresEnabled: false,
          pullRequest: null,
          error: null,
          refreshedAt: null,
        },
      },
      unsubscribe: () => {},
    }),
    peekSnapshot: (_cwd: string) => null,
    getSnapshot: async (cwd: string) => ({
      cwd,
      git: {
        isGit: false,
        repoRoot: null,
        mainRepoRoot: null,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        isDirty: null,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        diffStat: null,
      },
      github: {
        featuresEnabled: false,
        pullRequest: null,
        error: null,
        refreshedAt: null,
      },
    }),
    resolveRepoRemoteUrl: async () => null,
    resolveRepoRoot: async (cwd: string) => cwd,
    resolveDefaultBranch: async () => "main",
    refresh: async () => {},
    requestWorkingTreeWatch: async (cwd: string) => ({
      repoRoot: cwd,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    dispose: () => {},
  };
}

function createWorkspaceRuntimeSnapshot(
  cwd: string,
  overrides?: {
    git?: Partial<WorkspaceGitRuntimeSnapshot["git"]>;
    github?: Partial<WorkspaceGitRuntimeSnapshot["github"]>;
  },
): WorkspaceGitRuntimeSnapshot {
  const base: WorkspaceGitRuntimeSnapshot = {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 1, deletions: 0 },
    },
    github: {
      featuresEnabled: true,
      pullRequest: {
        url: "https://github.com/acme/repo/pull/123",
        title: "Runtime payloads",
        state: "open",
        baseRefName: "main",
        headRefName: "feature/runtime-payloads",
        isMerged: false,
      },
      error: null,
      refreshedAt: "2026-04-12T00:00:00.000Z",
    },
  };

  return {
    cwd,
    git: {
      ...base.git,
      ...overrides?.git,
    },
    github: {
      ...base.github,
      ...overrides?.github,
      pullRequest:
        overrides?.github && "pullRequest" in overrides.github
          ? (overrides.github.pullRequest ?? null)
          : base.github.pullRequest,
      error:
        overrides?.github && "error" in overrides.github
          ? (overrides.github.error ?? null)
          : base.github.error,
    },
  };
}

function createSessionForWorkspaceTests(
  options: {
    appVersion?: string | null;
    workspaceGitService?: ReturnType<typeof createNoopWorkspaceGitService>;
  } = {},
): Session {
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const session = new Session({
    clientId: "test-client",
    appVersion: options.appVersion ?? null,
    onMessage: vi.fn(),
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: {
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
      archiveSnapshot: async () => ({}),
      clearAgentAttention: async () => {},
      notifyAgentState: () => {},
    } as any,
    agentStorage: {
      list: async () => [],
      get: async () => null,
    } as any,
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    checkoutDiffManager: {
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    } as any,
    workspaceGitService: (options.workspaceGitService ?? createNoopWorkspaceGitService()) as any,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  }) as any;
  return session;
}

describe("workspace aggregation", () => {
  test("archive emits an authoritative agent_update upsert for subscribed clients", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const archivedRecord = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/repo",
      createdAt: "2026-03-30T15:00:00.000Z",
      updatedAt: "2026-03-30T15:00:00.000Z",
      lastActivityAt: "2026-03-30T15:00:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "idle",
      lastModeId: null,
      runtimeInfo: null,
      config: {
        provider: "codex",
        cwd: "/tmp/repo",
      },
      persistence: null,
      title: "Archive me",
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
    };

    const logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: logger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: async () => {
          const archivedAt = new Date().toISOString();
          Object.assign(archivedRecord, {
            archivedAt,
            updatedAt: archivedAt,
          });
          return { archivedAt };
        },
        archiveSnapshot: async (_agentId: string, archivedAt: string) => {
          Object.assign(archivedRecord, { archivedAt, updatedAt: archivedAt });
          return archivedRecord;
        },
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as any,
      agentStorage: {
        list: async () => [archivedRecord],
        get: async (agentId: string) => (agentId === archivedRecord.id ? archivedRecord : null),
        upsert: async (record: typeof archivedRecord) => {
          Object.assign(archivedRecord, record);
        },
      } as any,
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-1",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-1" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-1",
          projectId: "proj-1",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-1" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp/repo", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: null,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };

    await session.handleArchiveAgentRequest("agent-1", "req-archive");

    const update = emitted.find((message) => message.type === "agent_update");
    expect(update?.payload).toMatchObject({
      kind: "upsert",
      agent: {
        id: "agent-1",
        archivedAt: expect.any(String),
      },
    });
    expect(emitted.find((message) => message.type === "agent_archived")?.payload).toMatchObject({
      agentId: "agent-1",
      archivedAt: expect.any(String),
      requestId: "req-archive",
    });
  });

  test("close_items_request archives agents and kills terminals in one batch", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const archivedAt = "2026-04-01T00:00:00.000Z";
    const sessionLogger = {
      child: () => sessionLogger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const archivedRecord = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/repo",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      title: null,
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
    };
    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: sessionLogger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-1" ? { id: agentId } : null),
        archiveAgent: async () => ({ archivedAt }),
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as any,
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId !== "agent-1") {
            return null;
          }
          archivedRecord.archivedAt = archivedAt;
          archivedRecord.updatedAt = archivedAt;
          return archivedRecord;
        },
      } as any,
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-close",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-close" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-close",
          projectId: "proj-close",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-close" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as any,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };
    session.interruptAgentIfRunning = vi.fn();

    await session.handleMessage({
      type: "close_items_request",
      agentIds: ["agent-1"],
      terminalIds: ["term-1"],
      requestId: "req-close-items",
    });

    expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-1");
    expect(session.terminalManager.killTerminal).toHaveBeenCalledWith("term-1");
    expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
      agents: [{ agentId: "agent-1", archivedAt }],
      terminals: [{ terminalId: "term-1", success: true }],
      requestId: "req-close-items",
    });
    expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
      kind: "upsert",
      agent: {
        id: "agent-1",
        archivedAt,
      },
    });
  });

  test("close_items_request archives stored agents that are not currently loaded", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const sessionLogger = {
      child: () => sessionLogger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const liveArchivedAt = "2026-04-01T00:00:00.000Z";
    const storedAgentId = "agent-stored";
    const liveRecord = {
      ...makeAgent({
        id: "agent-live",
        cwd: "/tmp/repo",
        status: "idle",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
      archivedAt: null as string | null,
    };
    const storedRecord = {
      ...makeAgent({
        id: storedAgentId,
        cwd: "/tmp/repo",
        status: "idle",
        updatedAt: "2026-03-01T12:05:00.000Z",
      }),
      archivedAt: null as string | null,
    };
    const upsertStoredRecord = vi.fn(async (record: typeof storedRecord) => {
      if (record.id === storedAgentId) {
        storedRecord.archivedAt = record.archivedAt;
        storedRecord.updatedAt = record.updatedAt;
        storedRecord.status = record.status;
        storedRecord.requiresAttention = record.requiresAttention;
        storedRecord.attentionReason = record.attentionReason;
        storedRecord.attentionTimestamp = record.attentionTimestamp;
      }
    });

    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: sessionLogger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-live" ? { id: agentId } : null),
        archiveAgent: async (agentId: string) => {
          if (agentId !== "agent-live") {
            throw new Error(`Unexpected live archive: ${agentId}`);
          }
          liveRecord.archivedAt = liveArchivedAt;
          liveRecord.updatedAt = liveArchivedAt;
          return { archivedAt: liveArchivedAt };
        },
        archiveSnapshot: async (_agentId: string, archivedAt: string) => {
          storedRecord.archivedAt = archivedAt;
          storedRecord.updatedAt = archivedAt;
          storedRecord.status = "completed";
          storedRecord.requiresAttention = false;
          storedRecord.attentionReason = null;
          storedRecord.attentionTimestamp = null;
          return storedRecord;
        },
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as any,
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId === "agent-live") {
            return liveRecord;
          }
          if (agentId === storedAgentId) {
            return storedRecord;
          }
          return null;
        },
        upsert: upsertStoredRecord,
      } as any,
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-stored",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-stored" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-stored",
          projectId: "proj-stored",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-stored" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as any,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };
    session.interruptAgentIfRunning = vi.fn();

    await session.handleMessage({
      type: "close_items_request",
      agentIds: ["agent-live", storedAgentId],
      terminalIds: [],
      requestId: "req-close-stored",
    });

    expect(storedRecord.archivedAt).toEqual(expect.any(String));
    expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
      agents: [
        { agentId: "agent-live", archivedAt: liveArchivedAt },
        { agentId: storedAgentId, archivedAt: storedRecord.archivedAt },
      ],
      terminals: [],
      requestId: "req-close-stored",
    });
    expect(sessionLogger.warn).not.toHaveBeenCalled();
  });

  test("close_items_request continues after an archive failure", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const sessionLogger = {
      child: () => sessionLogger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const archivedAt = "2026-04-01T00:00:00.000Z";
    const goodRecord = {
      ...makeAgent({
        id: "agent-good",
        cwd: "/tmp/repo",
        status: "idle",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
      archivedAt: null as string | null,
    };
    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: sessionLogger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) =>
          agentId === "agent-bad" || agentId === "agent-good" ? { id: agentId } : null,
        archiveAgent: async (agentId: string) => {
          if (agentId === "agent-bad") {
            throw new Error("archive failed");
          }
          return { archivedAt };
        },
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as any,
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId !== "agent-good") {
            return null;
          }
          goodRecord.archivedAt = archivedAt;
          goodRecord.updatedAt = archivedAt;
          return goodRecord;
        },
      } as any,
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-err",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-err" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-err",
          projectId: "proj-err",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-err" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as any,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };
    session.interruptAgentIfRunning = vi.fn();

    await session.handleMessage({
      type: "close_items_request",
      agentIds: ["agent-bad", "agent-good"],
      terminalIds: ["term-1"],
      requestId: "req-close-best-effort",
    });

    expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-bad");
    expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-good");
    expect(session.terminalManager.killTerminal).toHaveBeenCalledWith("term-1");
    expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
      agents: [{ agentId: "agent-good", archivedAt }],
      terminals: [{ terminalId: "term-1", success: true }],
      requestId: "req-close-best-effort",
    });
    expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
      kind: "upsert",
      agent: {
        id: "agent-good",
        archivedAt,
      },
    });
    expect(sessionLogger.warn).toHaveBeenCalled();
  });

  test("non-git workspace uses deterministic directory name and no unknown branch fallback", async () => {
    const session = createSessionForWorkspaceTests() as any;
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: "ws-non-git",
        projectId: "proj-non-git",
        cwd: "/tmp/non-git",
        kind: "directory",
        displayName: "non-git",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "a1",
        cwd: "/tmp/non-git",
        status: "idle",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];
    const result = await session.listFetchWorkspacesEntries({
      type: "fetch_workspaces_request",
      requestId: "req-1",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("non-git");
    expect(result.entries[0]?.name).not.toBe("Unknown branch");
  });

  test("git branch workspace uses branch as canonical name", async () => {
    const session = createSessionForWorkspaceTests() as any;
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: "ws-repo-branch",
        projectId: "proj-repo-branch",
        cwd: "/tmp/repo-branch",
        kind: "local_checkout",
        displayName: "feature/name-from-server",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "a1",
        cwd: "/tmp/repo-branch",
        status: "running",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: "repo-branch",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "feature/name-from-server",
        remoteUrl: "https://github.com/acme/repo-branch.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
    const result = await session.listFetchWorkspacesEntries({
      type: "fetch_workspaces_request",
      requestId: "req-branch",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("feature/name-from-server");
  });

  test("branch/detached policies and dominant status bucket are deterministic", async () => {
    const session = createSessionForWorkspaceTests() as any;
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: "ws-repo-status",
        projectId: "proj-repo-status",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "repo",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "a1",
        cwd: "/tmp/repo",
        status: "running",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
      makeAgent({
        id: "a2",
        cwd: "/tmp/repo",
        status: "error",
        updatedAt: "2026-03-01T12:01:00.000Z",
      }),
      makeAgent({
        id: "a3",
        cwd: "/tmp/repo",
        status: "idle",
        updatedAt: "2026-03-01T12:02:00.000Z",
        pendingPermissions: 1,
      }),
    ];
    const result = await session.listFetchWorkspacesEntries({
      type: "fetch_workspaces_request",
      requestId: "req-2",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("repo");
    expect(result.entries[0]?.status).toBe("needs_input");
  });

  test("subdirectory agents map to an existing parent workspace descriptor", async () => {
    const session = createSessionForWorkspaceTests() as any;
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: "ws-repo-subdir",
        projectId: "proj-repo-subdir",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "a1",
        cwd: "/tmp/repo/packages/app",
        status: "running",
        updatedAt: "2026-03-01T12:03:00.000Z",
      }),
    ];

    const result = await session.listFetchWorkspacesEntries({
      type: "fetch_workspaces_request",
      requestId: "req-subdir-agent",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: "ws-repo-subdir",
      status: "done",
      activityAt: null,
    });
  });

  test("workspace update stream keeps persisted workspace visible after agents stop", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: logger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
      } as any,
      agentStorage: {
        list: async () => [],
        get: async () => null,
      } as any,
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: null,
    }) as any;

    session.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };
    session.reconcileActiveWorkspaceRecords = async () => new Set();

    session.buildWorkspaceDescriptorMap = async () =>
      new Map([
        [
          "/tmp/repo",
          {
            id: "ws-repo-running",
            projectId: "proj-repo-running",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            projectKind: "non_git",
            workspaceKind: "directory",
            name: "repo",
            status: "running",
            activityAt: "2026-03-01T12:00:00.000Z",
          },
        ],
      ]);
    await session.emitWorkspaceUpdateForCwd("/tmp/repo");

    session.buildWorkspaceDescriptorMap = async () =>
      new Map([
        [
          "/tmp/repo",
          {
            id: "ws-repo-running",
            projectId: "proj-repo-running",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            projectKind: "non_git",
            workspaceKind: "directory",
            name: "repo",
            status: "done",
            activityAt: null,
          },
        ],
      ]);
    await session.emitWorkspaceUpdateForCwd("/tmp/repo");

    const workspaceUpdates = emitted.filter((message) => message.type === "workspace_update");
    expect(workspaceUpdates).toHaveLength(2);
    expect((workspaceUpdates[0] as any).payload.kind).toBe("upsert");
    expect((workspaceUpdates[1] as any).payload).toEqual({
      kind: "upsert",
      workspace: {
        id: "ws-repo-running",
        projectId: "proj-repo-running",
        projectDisplayName: "repo",
        projectRootPath: "/tmp/repo",
        projectKind: "non_git",
        workspaceKind: "directory",
        name: "repo",
        status: "done",
        activityAt: null,
      },
    });
  });

  test("create paseo worktree request returns a registered workspace descriptor", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-worktree-test-")));
    const repoDir = path.join(tempDir, "repo");
    const paseoHome = path.join(tempDir, "paseo-home");
    execSync(`mkdir -p ${repoDir}`);
    execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
    const workspaceGitService = createNoopWorkspaceGitService();
    workspaceGitService.getSnapshot = vi.fn(async (cwd: string) => {
      if (cwd === repoDir) {
        return createWorkspaceRuntimeSnapshot(cwd, {
          git: {
            repoRoot: repoDir,
            currentBranch: "main",
            remoteUrl: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
          },
        });
      }

      if (cwd.includes("worktree-123")) {
        return createWorkspaceRuntimeSnapshot(cwd, {
          git: {
            repoRoot: cwd,
            currentBranch: "worktree-123",
            remoteUrl: null,
            isPaseoOwnedWorktree: true,
            mainRepoRoot: repoDir,
          },
        });
      }

      return createWorkspaceRuntimeSnapshot(cwd, {
        git: {
          repoRoot: cwd,
          currentBranch: "main",
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      });
    });
    const session = createSessionForWorkspaceTests({
      workspaceGitService,
    }) as any;

    const workspaces = new Map();
    const projects = new Map();
    session.paseoHome = paseoHome;
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());
    session.workspaceRegistry.upsert = async (record: any) => {
      workspaces.set(record.workspaceId, record);
    };
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.projectRegistry.upsert = async (record: any) => {
      projects.set(record.projectId, record);
    };
    session.emit = (message: { type: string; payload: unknown }) => {
      emitted.push(message);
    };
    try {
      await session.handleCreatePaseoWorktreeRequest({
        type: "create_paseo_worktree_request",
        cwd: repoDir,
        worktreeSlug: "worktree-123",
        requestId: "req-worktree",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const response = emitted.find((message) => message.type === "create_paseo_worktree_response") as
      | { type: "create_paseo_worktree_response"; payload: any }
      | undefined;

    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace).toMatchObject({
      projectDisplayName: "repo",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "worktree-123",
      status: "done",
    });
    expect(response?.payload.workspace?.id).toContain(path.join("worktree-123"));
    expect(workspaces.has(response?.payload.workspace?.id)).toBe(true);
    expect(projects.has(response?.payload.workspace?.projectId)).toBe(true);
  });

  test("workspace update fanout for multiple cwd values is deduplicated", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests() as any;
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: "ws-repo-main",
        projectId: "proj-repo-main",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
      createPersistedWorkspaceRecord({
        workspaceId: "ws-repo-feature",
        projectId: "proj-repo-main",
        cwd: "/tmp/repo/worktree",
        kind: "worktree",
        displayName: "feature",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];
    session.workspaceUpdatesSubscription = {
      subscriptionId: "sub-dedup",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };
    session.reconcileActiveWorkspaceRecords = async () =>
      new Set(["ws-repo-main", "ws-repo-feature"]);
    session.buildWorkspaceDescriptorMap = async () =>
      new Map([
        [
          "ws-repo-main",
          {
            id: "ws-repo-main",
            projectId: "proj-repo-main",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            projectKind: "git",
            workspaceKind: "local_checkout",
            name: "main",
            status: "done",
            activityAt: null,
          },
        ],
        [
          "ws-repo-feature",
          {
            id: "ws-repo-feature",
            projectId: "proj-repo-main",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            projectKind: "git",
            workspaceKind: "worktree",
            name: "feature",
            status: "running",
            activityAt: "2026-03-01T12:00:00.000Z",
          },
        ],
      ]);
    session.onMessage = (message: { type: string; payload: unknown }) => {
      emitted.push(message);
    };

    await session.emitWorkspaceUpdateForCwd("/tmp/repo/worktree");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as any[];
    expect(workspaceUpdates).toHaveLength(2);
    expect(workspaceUpdates.map((entry) => entry.payload.kind)).toEqual(["upsert", "upsert"]);
    expect(workspaceUpdates.map((entry) => entry.payload.workspace.id).sort()).toEqual([
      "ws-repo-feature",
      "ws-repo-main",
    ]);
  });

  test("open_project_request registers a workspace before any agent exists", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests() as any;
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

    session.emit = (message: any) => emitted.push(message);
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
    session.projectRegistry.upsert = async (
      record: ReturnType<typeof createPersistedProjectRecord>,
    ) => {
      projects.set(record.projectId, record);
    };
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>,
    ) => {
      workspaces.set(record.workspaceId, record);
    };
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    await session.handleMessage({
      type: "open_project_request",
      cwd: "/tmp/repo",
      requestId: "req-open",
    });

    expect(workspaces.get("/tmp/repo")).toBeTruthy();
    const response = emitted.find((message) => message.type === "open_project_response") as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.id).toBe("/tmp/repo");
  });

  test("open_project_request unarchives an existing archived workspace and project", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests() as any;
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

    const cwd = "/tmp/repo";
    projects.set(
      cwd,
      createPersistedProjectRecord({
        projectId: cwd,
        rootPath: cwd,
        kind: "non_git",
        displayName: "repo",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
        archivedAt: "2026-03-10T00:00:00.000Z",
      }),
    );
    workspaces.set(
      cwd,
      createPersistedWorkspaceRecord({
        workspaceId: cwd,
        projectId: cwd,
        cwd,
        kind: "directory",
        displayName: "repo",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
        archivedAt: "2026-03-10T00:00:00.000Z",
      }),
    );

    session.emit = (message: any) => emitted.push(message);
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
    session.projectRegistry.upsert = async (
      record: ReturnType<typeof createPersistedProjectRecord>,
    ) => {
      projects.set(record.projectId, record);
    };
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>,
    ) => {
      workspaces.set(record.workspaceId, record);
    };
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());

    await session.handleMessage({
      type: "open_project_request",
      cwd,
      requestId: "req-open-unarchive",
    });

    expect(workspaces.get(cwd)?.archivedAt).toBeNull();
    expect(projects.get(cwd)?.archivedAt).toBeNull();
    const response = emitted.find((message) => message.type === "open_project_response") as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.id).toBe(cwd);
  });

  test.skip("open_project_request collapses a git subdirectory onto the repo root workspace", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests() as any;
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
    const repoRoot = "/tmp/repo";
    const subdir = "/tmp/repo/packages/app";

    session.emit = (message: any) => emitted.push(message);
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
    session.projectRegistry.upsert = async (
      record: ReturnType<typeof createPersistedProjectRecord>,
    ) => {
      projects.set(record.projectId, record);
    };
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>,
    ) => {
      workspaces.set(record.workspaceId, record);
    };
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: repoRoot,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: repoRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    await session.handleMessage({
      type: "open_project_request",
      cwd: subdir,
      requestId: "req-open-subdir",
    });

    expect(workspaces.get(repoRoot)).toBeTruthy();
    expect(workspaces.has(subdir)).toBe(false);
    const response = emitted.find((message) => message.type === "open_project_response") as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.id).toBe(repoRoot);
  });

  test("list_available_editors_request returns available targets", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests({ appVersion: "0.1.50" }) as any;

    session.emit = (message: any) => emitted.push(message);
    session.getAvailableEditorTargets = async () =>
      session.filterEditorsForClient([
        { id: "cursor", label: "Cursor" },
        { id: "webstorm", label: "WebStorm" },
        { id: "finder", label: "Finder" },
        { id: "unknown-editor", label: "Unknown Editor" },
      ]);

    await session.handleMessage({
      type: "list_available_editors_request",
      requestId: "req-editors",
    });

    const response = emitted.find(
      (message) => message.type === "list_available_editors_response",
    ) as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.editors).toEqual([
      { id: "cursor", label: "Cursor" },
      { id: "webstorm", label: "WebStorm" },
      { id: "finder", label: "Finder" },
      { id: "unknown-editor", label: "Unknown Editor" },
    ]);
  });

  test("list_available_editors_request filters unsupported ids for legacy clients", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests({ appVersion: "0.1.49" }) as any;

    session.emit = (message: any) => emitted.push(message);
    session.getAvailableEditorTargets = async () =>
      session.filterEditorsForClient([
        { id: "cursor", label: "Cursor" },
        { id: "webstorm", label: "WebStorm" },
        { id: "unknown-editor", label: "Unknown Editor" },
        { id: "finder", label: "Finder" },
      ]);

    await session.handleMessage({
      type: "list_available_editors_request",
      requestId: "req-editors-legacy",
    });

    const response = emitted.find(
      (message) => message.type === "list_available_editors_response",
    ) as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.editors).toEqual([
      { id: "cursor", label: "Cursor" },
      { id: "finder", label: "Finder" },
    ]);
  });

  test("open_in_editor_request launches the selected target", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests() as any;
    const calls: Array<{ editorId: string; path: string }> = [];

    session.emit = (message: any) => emitted.push(message);
    session.openEditorTarget = async (input: { editorId: string; path: string }) => {
      calls.push(input);
    };

    await session.handleMessage({
      type: "open_in_editor_request",
      requestId: "req-open-editor",
      editorId: "vscode",
      path: "/tmp/repo",
    });

    expect(calls).toEqual([{ editorId: "vscode", path: "/tmp/repo" }]);
    const response = emitted.find((message) => message.type === "open_in_editor_response") as any;
    expect(response?.payload.error).toBeNull();
  });

  test("archive_workspace_request hides non-destructive workspace records", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests() as any;
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-archive",
      projectId: "proj-repo-archive",
      cwd: "/tmp/repo",
      kind: "directory",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });

    session.emit = (message: any) => emitted.push(message);
    session.workspaceRegistry.get = async () => workspace;
    session.workspaceRegistry.archive = async (_workspaceId: string, archivedAt: string) => {
      workspace.archivedAt = archivedAt;
    };
    session.workspaceRegistry.list = async () => [workspace];
    session.projectRegistry.archive = async () => {};

    await session.handleMessage({
      type: "archive_workspace_request",
      workspaceId: "ws-repo-archive",
      requestId: "req-archive",
    });

    expect(workspace.archivedAt).toBeTruthy();
    const response = emitted.find(
      (message) => message.type === "archive_workspace_response",
    ) as any;
    expect(response?.payload.error).toBeNull();
  });

  test.skip("opening a new worktree reconciles older local workspaces into the remote project", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const session = createSessionForWorkspaceTests() as any;
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-reconcile-")));
    const mainWorkspaceId = path.join(tempDir, "inkwell");
    const worktreeWorkspaceId = path.join(mainWorkspaceId, ".paseo", "worktrees", "feature-a");
    const localProjectId = mainWorkspaceId;
    const remoteProjectId = "remote:github.com/zimakki/inkwell";

    execSync(`mkdir -p ${JSON.stringify(worktreeWorkspaceId)}`);

    projects.set(
      localProjectId,
      createPersistedProjectRecord({
        projectId: localProjectId,
        rootPath: mainWorkspaceId,
        kind: "git",
        displayName: "inkwell",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );
    workspaces.set(
      mainWorkspaceId,
      createPersistedWorkspaceRecord({
        workspaceId: mainWorkspaceId,
        projectId: localProjectId,
        cwd: mainWorkspaceId,
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );

    session.emit = (message: any) => emitted.push(message);
    session.workspaceUpdatesSubscription = {
      subscriptionId: "sub-reconcile",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };
    session.listAgentPayloads = async () => [];
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.projectRegistry.upsert = async (
      record: ReturnType<typeof createPersistedProjectRecord>,
    ) => {
      projects.set(record.projectId, record);
    };
    session.projectRegistry.archive = async (projectId: string, archivedAt: string) => {
      const existing = projects.get(projectId);
      if (!existing) return;
      projects.set(projectId, { ...existing, archivedAt, updatedAt: archivedAt });
    };
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>,
    ) => {
      workspaces.set(record.workspaceId, record);
    };
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: remoteProjectId,
      projectName: "zimakki/inkwell",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: cwd === mainWorkspaceId ? "main" : "feature-a",
        remoteUrl: "https://github.com/zimakki/inkwell.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: cwd !== mainWorkspaceId,
        mainRepoRoot: cwd === mainWorkspaceId ? null : mainWorkspaceId,
      },
    });

    try {
      await session.handleMessage({
        type: "open_project_request",
        cwd: worktreeWorkspaceId,
        requestId: "req-open-worktree",
      });

      const mainWorkspaceProjectId = workspaces.get(mainWorkspaceId)?.projectId;
      expect([localProjectId, remoteProjectId]).toContain(mainWorkspaceProjectId);
      expect(workspaces.get(worktreeWorkspaceId)?.projectId).toBe(remoteProjectId);
      expect(Boolean(projects.get(localProjectId)?.archivedAt)).toBe(
        mainWorkspaceProjectId === remoteProjectId,
      );

      const workspaceUpdates = emitted.filter(
        (message) => message.type === "workspace_update",
      ) as any[];
      expect(workspaceUpdates).toHaveLength(1);
      expect(workspaceUpdates[0]?.payload.workspace.id).toBe(worktreeWorkspaceId);
      expect(workspaceUpdates[0]?.payload.workspace.projectId).toBe(remoteProjectId);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.skip("fetch_workspaces_request reconciles remote URL changes for existing workspaces", async () => {
    const session = createSessionForWorkspaceTests() as any;
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-fetch-")));
    const mainWorkspaceId = path.join(tempDir, "inkwell");
    const worktreeWorkspaceId = path.join(mainWorkspaceId, ".paseo", "worktrees", "feature-a");
    const oldProjectId = "remote:github.com/old-owner/inkwell";
    const newProjectId = "remote:github.com/new-owner/inkwell";

    execSync(`mkdir -p ${JSON.stringify(worktreeWorkspaceId)}`);

    projects.set(
      oldProjectId,
      createPersistedProjectRecord({
        projectId: oldProjectId,
        rootPath: mainWorkspaceId,
        kind: "git",
        displayName: "old-owner/inkwell",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );

    for (const [workspaceId, displayName] of [
      [mainWorkspaceId, "main"],
      [worktreeWorkspaceId, "feature-a"],
    ] as const) {
      workspaces.set(
        workspaceId,
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: oldProjectId,
          cwd: workspaceId,
          kind: workspaceId === mainWorkspaceId ? "local_checkout" : "worktree",
          displayName,
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        }),
      );
    }

    session.listAgentPayloads = async () => [];
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.projectRegistry.upsert = async (
      record: ReturnType<typeof createPersistedProjectRecord>,
    ) => {
      projects.set(record.projectId, record);
    };
    session.projectRegistry.archive = async (projectId: string, archivedAt: string) => {
      const existing = projects.get(projectId);
      if (!existing) return;
      projects.set(projectId, { ...existing, archivedAt, updatedAt: archivedAt });
    };
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>,
    ) => {
      workspaces.set(record.workspaceId, record);
    };
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: newProjectId,
      projectName: "new-owner/inkwell",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: cwd === mainWorkspaceId ? "main" : "feature-a",
        remoteUrl: "https://github.com/new-owner/inkwell.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: cwd !== mainWorkspaceId,
        mainRepoRoot: cwd === mainWorkspaceId ? null : mainWorkspaceId,
      },
    });

    try {
      await session.reconcileWorkspaceRecord(mainWorkspaceId);
      await session.reconcileWorkspaceRecord(worktreeWorkspaceId);

      const result = await session.listFetchWorkspacesEntries({
        type: "fetch_workspaces_request",
        requestId: "req-fetch-reconcile",
      });

      expect(result.entries.map((entry: any) => entry.projectId)).toEqual([
        newProjectId,
        newProjectId,
      ]);
      expect(workspaces.get(mainWorkspaceId)?.projectId).toBe(newProjectId);
      expect(workspaces.get(worktreeWorkspaceId)?.projectId).toBe(newProjectId);
      expect(projects.get(oldProjectId)?.archivedAt).toBeTruthy();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.skip("reconcile archives stale subdirectory workspace records when collapsing to the repo root", async () => {
    const session = createSessionForWorkspaceTests() as any;
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-collapse-")));
    const repoRoot = path.join(tempDir, "repo");
    const subdirWorkspaceId = path.join(repoRoot, "packages", "app");
    const projectId = "remote:github.com/acme/repo";

    execSync(`mkdir -p ${JSON.stringify(subdirWorkspaceId)}`);

    projects.set(
      projectId,
      createPersistedProjectRecord({
        projectId,
        rootPath: repoRoot,
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );
    workspaces.set(
      repoRoot,
      createPersistedWorkspaceRecord({
        workspaceId: repoRoot,
        projectId,
        cwd: repoRoot,
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );
    workspaces.set(
      subdirWorkspaceId,
      createPersistedWorkspaceRecord({
        workspaceId: subdirWorkspaceId,
        projectId,
        cwd: subdirWorkspaceId,
        kind: "directory",
        displayName: "app",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );

    session.projectRegistry.get = async (nextProjectId: string) =>
      projects.get(nextProjectId) ?? null;
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.projectRegistry.upsert = async (
      record: ReturnType<typeof createPersistedProjectRecord>,
    ) => {
      projects.set(record.projectId, record);
    };
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>,
    ) => {
      workspaces.set(record.workspaceId, record);
    };
    session.workspaceRegistry.archive = async (workspaceId: string, archivedAt: string) => {
      const existing = workspaces.get(workspaceId);
      if (!existing) return;
      workspaces.set(workspaceId, { ...existing, archivedAt, updatedAt: archivedAt });
    };
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: projectId,
      projectName: "acme/repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: repoRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    try {
      const result = await session.reconcileWorkspaceRecord(subdirWorkspaceId);

      expect(result.changed).toBe(true);
      expect(result.workspace.workspaceId).toBe(repoRoot);
      expect(result.removedWorkspaceId).toBe(subdirWorkspaceId);
      expect(workspaces.get(repoRoot)?.archivedAt).toBeNull();
      expect(workspaces.get(subdirWorkspaceId)?.archivedAt).toBeTruthy();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("listWorkspaceDescriptorsSnapshot keeps git workspaces on the baseline descriptor path", async () => {
    const session = createSessionForWorkspaceTests() as any;
    const project = createPersistedProjectRecord({
      projectId: "proj-baseline",
      rootPath: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-baseline",
      projectId: project.projectId,
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });

    session.listAgentPayloads = async () => [];
    session.projectRegistry.list = async () => [project];
    session.workspaceRegistry.list = async () => [workspace];

    const baselineDescriptor = {
      id: workspace.workspaceId,
      projectId: project.projectId,
      projectDisplayName: project.displayName,
      projectRootPath: project.rootPath,
      projectKind: project.kind,
      workspaceKind: workspace.kind,
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
    } as const;
    const gitDescriptor = {
      ...baselineDescriptor,
      diffStat: { additions: 3, deletions: 1 },
    } as const;

    session.describeWorkspaceRecord = vi.fn(async () => baselineDescriptor);
    session.describeWorkspaceRecordWithGitData = vi.fn(async () => gitDescriptor);

    const descriptors = Array.from(
      (
        await session.buildWorkspaceDescriptorMap({
          includeGitData: false,
        })
      ).values(),
    );

    expect(session.describeWorkspaceRecord).toHaveBeenCalledWith(workspace, project);
    expect(session.describeWorkspaceRecordWithGitData).not.toHaveBeenCalled();
    expect(descriptors).toEqual([baselineDescriptor]);
  });

  test("fetch_workspaces_response reads runtime fields from passive workspace git service snapshots", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const runtimeSnapshot = createWorkspaceRuntimeSnapshot("/tmp/repo", {
      git: {
        currentBranch: "runtime-branch",
        isDirty: true,
        aheadBehind: { ahead: 3, behind: 1 },
        aheadOfOrigin: 3,
        behindOfOrigin: 1,
      },
      github: {
        pullRequest: {
          url: "https://github.com/acme/repo/pull/456",
          title: "Ship runtime payloads",
          state: "open",
          baseRefName: "main",
          headRefName: "runtime-branch",
          isMerged: false,
        },
        refreshedAt: "2026-04-12T00:05:00.000Z",
      },
    });
    const workspaceGitService = createNoopWorkspaceGitService();
    workspaceGitService.peekSnapshot = vi.fn(() => runtimeSnapshot);
    workspaceGitService.subscribe = vi.fn(async () => ({
      initial: runtimeSnapshot,
      unsubscribe: () => {},
    }));

    const session = createSessionForWorkspaceTests({
      workspaceGitService,
    }) as any;
    const project = createPersistedProjectRecord({
      projectId: "proj-runtime-fetch",
      rootPath: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-runtime-fetch",
      projectId: project.projectId,
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });

    session.emit = (message: any) => emitted.push(message);
    session.listAgentPayloads = async () => [];
    session.projectRegistry.list = async () => [project];
    session.workspaceRegistry.list = async () => [workspace];
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: runtimeSnapshot.git.currentBranch,
        remoteUrl: runtimeSnapshot.git.remoteUrl,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "req-fetch-workspaces-runtime",
    });

    const response = emitted.find((message) => message.type === "fetch_workspaces_response") as
      | { type: "fetch_workspaces_response"; payload: any }
      | undefined;

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/repo");
    expect(response?.payload.entries).toEqual([
      expect.objectContaining({
        id: "ws-runtime-fetch",
        gitRuntime: {
          currentBranch: "runtime-branch",
          remoteUrl: "https://github.com/acme/repo.git",
          isPaseoOwnedWorktree: false,
          isDirty: true,
          aheadBehind: { ahead: 3, behind: 1 },
          aheadOfOrigin: 3,
          behindOfOrigin: 1,
        },
        githubRuntime: {
          featuresEnabled: true,
          pullRequest: {
            url: "https://github.com/acme/repo/pull/456",
            title: "Ship runtime payloads",
            state: "open",
            baseRefName: "main",
            headRefName: "runtime-branch",
            isMerged: false,
          },
          error: null,
          refreshedAt: "2026-04-12T00:05:00.000Z",
        },
      }),
    ]);
  });

  test("workspace_update includes updated runtime fields", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const runtimeSnapshot = createWorkspaceRuntimeSnapshot("/tmp/repo", {
      git: {
        currentBranch: "feature/runtime-payloads",
        isDirty: true,
      },
      github: {
        pullRequest: {
          url: "https://github.com/acme/repo/pull/789",
          title: "Updated runtime payloads",
          state: "merged",
          baseRefName: "main",
          headRefName: "feature/runtime-payloads",
          isMerged: true,
        },
        refreshedAt: "2026-04-12T00:10:00.000Z",
      },
    });
    const workspaceGitService = createNoopWorkspaceGitService();
    workspaceGitService.peekSnapshot = vi.fn(() => runtimeSnapshot);

    const session = createSessionForWorkspaceTests({
      workspaceGitService,
    }) as any;
    const project = createPersistedProjectRecord({
      projectId: "proj-runtime-update",
      rootPath: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-runtime-update",
      projectId: project.projectId,
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });

    session.emit = (message: any) => emitted.push(message);
    session.workspaceUpdatesSubscription = {
      subscriptionId: "sub-runtime",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };
    session.reconcileActiveWorkspaceRecords = async () => new Set();
    session.listAgentPayloads = async () => [];
    session.projectRegistry.list = async () => [project];
    session.workspaceRegistry.list = async () => [workspace];
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: runtimeSnapshot.git.currentBranch,
        remoteUrl: runtimeSnapshot.git.remoteUrl,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    await session.emitWorkspaceUpdateForCwd("/tmp/repo", {
      skipReconcile: true,
    });

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/repo");
    expect(emitted).toContainEqual({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: expect.objectContaining({
          id: "ws-runtime-update",
          gitRuntime: expect.objectContaining({
            currentBranch: "feature/runtime-payloads",
            isDirty: true,
          }),
          githubRuntime: expect.objectContaining({
            featuresEnabled: true,
            pullRequest: expect.objectContaining({
              title: "Updated runtime payloads",
              isMerged: true,
            }),
            refreshedAt: "2026-04-12T00:10:00.000Z",
          }),
        }),
      },
    });
  });

  test("subscribed fetch_workspaces includes git enrichment in the initial snapshot", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const session = createSessionForWorkspaceTests() as any;
    const gitProject = createPersistedProjectRecord({
      projectId: "proj-git-subscribe",
      rootPath: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const directoryProject = createPersistedProjectRecord({
      projectId: "proj-docs-subscribe",
      rootPath: "/tmp/docs",
      kind: "non_git",
      displayName: "docs",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const gitWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-git-subscribe",
      projectId: gitProject.projectId,
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const directoryWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-docs-subscribe",
      projectId: directoryProject.projectId,
      cwd: "/tmp/docs",
      kind: "directory",
      displayName: "docs",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const baselineGitDescriptor = {
      id: gitWorkspace.workspaceId,
      projectId: gitProject.projectId,
      projectDisplayName: gitProject.displayName,
      projectRootPath: gitProject.rootPath,
      projectKind: gitProject.kind,
      workspaceKind: gitWorkspace.kind,
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
    } as const;
    const enrichedGitDescriptor = {
      ...baselineGitDescriptor,
      diffStat: { additions: 3, deletions: 1 },
    } as const;
    const directoryDescriptor = {
      id: directoryWorkspace.workspaceId,
      projectId: directoryProject.projectId,
      projectDisplayName: directoryProject.displayName,
      projectRootPath: directoryProject.rootPath,
      projectKind: directoryProject.kind,
      workspaceKind: directoryWorkspace.kind,
      name: "docs",
      status: "done",
      activityAt: null,
      diffStat: null,
    } as const;

    session.emit = (message: any) => emitted.push(message);
    session.listAgentPayloads = async () => [];
    session.projectRegistry.list = async () => [gitProject, directoryProject];
    session.workspaceRegistry.list = async () => [gitWorkspace, directoryWorkspace];
    session.reconcileAndEmitWorkspaceUpdates = vi.fn(async () => {});
    session.describeWorkspaceRecord = vi.fn(
      async (workspace: typeof gitWorkspace | typeof directoryWorkspace, project: any) => {
        if (workspace.workspaceId === gitWorkspace.workspaceId) {
          expect(project).toEqual(gitProject);
          return baselineGitDescriptor;
        }
        expect(project).toEqual(directoryProject);
        return directoryDescriptor;
      },
    );
    session.describeWorkspaceRecordWithGitData = vi.fn(async () => enrichedGitDescriptor);

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "req-fetch-workspaces",
      subscribe: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = emitted.find((message) => message.type === "fetch_workspaces_response") as
      | { type: "fetch_workspaces_response"; payload: any }
      | undefined;
    expect(
      response?.payload.entries.map(
        (entry: typeof baselineGitDescriptor | typeof directoryDescriptor) => [
          entry.id,
          entry.diffStat,
        ],
      ),
    ).toEqual([
      [directoryDescriptor.id, directoryDescriptor.diffStat],
      [enrichedGitDescriptor.id, enrichedGitDescriptor.diffStat],
    ]);

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as Array<{ type: "workspace_update"; payload: any }>;
    expect(workspaceUpdates).toEqual([]);
    expect(session.describeWorkspaceRecordWithGitData).toHaveBeenCalledWith(
      gitWorkspace,
      gitProject,
    );
  });
});
