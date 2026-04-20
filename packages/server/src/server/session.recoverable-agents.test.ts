import { describe, expect, test, vi } from "vitest";

vi.mock("../utils/checkout-git.js", () => ({
  getCheckoutDiff: vi.fn(),
  getCheckoutStatus: vi.fn(),
  listBranchSuggestions: vi.fn(),
  commitChanges: vi.fn(),
  mergeToBase: vi.fn(),
  mergeFromBase: vi.fn(),
  pullCurrentBranch: vi.fn(),
  pushCurrentBranch: vi.fn(),
  createPullRequest: vi.fn(),
}));

import { Session } from "./session.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";

function createRecord(overrides: Partial<StoredAgentRecord>): StoredAgentRecord {
  const id = overrides.id ?? "agent-record";
  const cwd = overrides.cwd ?? `/tmp/${id}`;
  const now = "2026-04-01T00:00:00.000Z";

  return {
    id,
    provider: overrides.provider ?? "codex",
    cwd,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastActivityAt: overrides.lastActivityAt,
    lastUserMessageAt: overrides.lastUserMessageAt ?? null,
    title: overrides.title ?? null,
    labels: overrides.labels ?? {},
    lastStatus: overrides.lastStatus ?? "closed",
    lastModeId: overrides.lastModeId ?? null,
    config: overrides.config ?? {},
    runtimeInfo: overrides.runtimeInfo,
    features: overrides.features,
    persistence:
      Object.prototype.hasOwnProperty.call(overrides, "persistence") &&
      overrides.persistence === null
        ? null
        : (overrides.persistence ?? {
            provider: overrides.provider ?? "codex",
            sessionId: `session-${id}`,
          }),
    requiresAttention: overrides.requiresAttention,
    attentionReason: overrides.attentionReason,
    attentionTimestamp: overrides.attentionTimestamp,
    internal: overrides.internal,
    archivedAt: overrides.archivedAt ?? null,
  };
}

function createSessionForRecoverableTests(input: {
  emitted: Array<{ type: string; payload: unknown }>;
  records: StoredAgentRecord[];
  liveAgentIds?: string[];
}): Session {
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
    onMessage: (message) => input.emitted.push(message as any),
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: {
      subscribe: () => () => {},
      listAgents: () => (input.liveAgentIds ?? []).map((id) => ({ id })),
      getAgent: () => null,
    } as any,
    agentStorage: {
      list: async () => input.records,
      get: async (agentId: string) => input.records.find((record) => record.id === agentId) ?? null,
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
    workspaceGitService: {
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
      peekSnapshot: () => null,
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
      refresh: async () => {},
      dispose: () => {},
    } as any,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  }) as any;

  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: cwd,
    projectName: cwd.split("/").pop() ?? cwd,
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

  return session;
}

describe("recoverable agent directory", () => {
  test("fetch_recoverable_agents_request only returns closed non-archived persisted agents", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const session = createSessionForRecoverableTests({
      emitted,
      liveAgentIds: ["agent-live-duplicate"],
      records: [
        createRecord({
          id: "agent-recoverable",
          updatedAt: "2026-04-10T12:00:00.000Z",
        }),
        createRecord({
          id: "agent-archived",
          archivedAt: "2026-04-10T13:00:00.000Z",
        }),
        createRecord({
          id: "agent-open",
          lastStatus: "idle",
        }),
        createRecord({
          id: "agent-without-persistence",
          persistence: null,
        }),
        createRecord({
          id: "agent-internal",
          internal: true,
        }),
        createRecord({
          id: "agent-live-duplicate",
        }),
        createRecord({
          id: "agent-invalid-persistence",
          persistence: {
            provider: "unknown-provider",
            sessionId: "bad-session",
          },
        }),
      ],
    });

    await session.handleMessage({
      type: "fetch_recoverable_agents_request",
      requestId: "req-recoverable-1",
    } as any);

    const response = emitted.find(
      (message) => message.type === "fetch_recoverable_agents_response",
    ) as { type: string; payload: any } | undefined;

    expect(response?.payload.requestId).toBe("req-recoverable-1");
    expect(response?.payload.entries.map((entry: any) => entry.agent.id)).toEqual([
      "agent-recoverable",
    ]);
    expect(response?.payload.entries[0].agent.persistence).toMatchObject({
      provider: "codex",
      sessionId: "session-agent-recoverable",
    });
    expect(response?.payload.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
  });

  test("fetch_recoverable_agents_request paginates by updated_at desc", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const session = createSessionForRecoverableTests({
      emitted,
      records: [
        createRecord({
          id: "agent-old",
          updatedAt: "2026-04-01T09:00:00.000Z",
        }),
        createRecord({
          id: "agent-new",
          updatedAt: "2026-04-02T09:00:00.000Z",
        }),
      ],
    });

    await session.handleMessage({
      type: "fetch_recoverable_agents_request",
      requestId: "req-recoverable-page-1",
      page: { limit: 1 },
    } as any);

    const firstResponse = emitted.find(
      (message) =>
        message.type === "fetch_recoverable_agents_response" &&
        message.payload.requestId === "req-recoverable-page-1",
    ) as { type: string; payload: any };

    expect(firstResponse.payload.entries.map((entry: any) => entry.agent.id)).toEqual([
      "agent-new",
    ]);
    expect(firstResponse.payload.pageInfo.hasMore).toBe(true);
    expect(typeof firstResponse.payload.pageInfo.nextCursor).toBe("string");

    await session.handleMessage({
      type: "fetch_recoverable_agents_request",
      requestId: "req-recoverable-page-2",
      page: {
        limit: 1,
        cursor: firstResponse.payload.pageInfo.nextCursor,
      },
    } as any);

    const secondResponse = emitted.find(
      (message) =>
        message.type === "fetch_recoverable_agents_response" &&
        message.payload.requestId === "req-recoverable-page-2",
    ) as { type: string; payload: any };

    expect(secondResponse.payload.entries.map((entry: any) => entry.agent.id)).toEqual([
      "agent-old",
    ]);
    expect(secondResponse.payload.pageInfo.hasMore).toBe(false);
    expect(secondResponse.payload.pageInfo.nextCursor).toBeNull();
  });
});
