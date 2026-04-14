import { homedir } from "node:os";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { getCheckoutDiffFileMock } = vi.hoisted(() => ({
  getCheckoutDiffFileMock: vi.fn(),
}));

vi.mock("../utils/checkout-git.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/checkout-git.js")>(
    "../utils/checkout-git.js",
  );
  return {
    ...actual,
    getCheckoutDiffFile: getCheckoutDiffFileMock,
  };
});

import { Session } from "./session.js";

function createSessionForCheckoutDiffTests(options?: {
  checkoutDiffManager?: {
    subscribe: ReturnType<typeof vi.fn>;
    subscribeLazy: ReturnType<typeof vi.fn>;
    getFileHunks: ReturnType<typeof vi.fn>;
    scheduleRefreshForCwd: ReturnType<typeof vi.fn>;
    getMetrics: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}) {
  const emitted: any[] = [];
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const checkoutDiffManager =
    options?.checkoutDiffManager ??
    ({
      subscribe: vi.fn(async () => ({
        initial: { cwd: "/tmp/repo", files: [], error: null },
        unsubscribe: vi.fn(),
      })),
      subscribeLazy: vi.fn(async () => ({
        initial: { cwd: "/tmp/repo", files: [], error: null },
        unsubscribe: vi.fn(),
      })),
      getFileHunks: vi.fn(() => null),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    } as const);

  const session = new Session({
    clientId: "test-client",
    appVersion: null,
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
    checkoutDiffManager: checkoutDiffManager as any,
    workspaceGitService: {
      subscribe: async () => ({
        initial: {
          cwd: "/tmp/repo",
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
        unsubscribe: vi.fn(),
      }),
      peekSnapshot: () => null,
      getSnapshot: async () => null,
      refresh: async () => {},
      dispose: () => {},
    } as any,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  }) as any;

  session.emit = (message: any) => emitted.push(message);

  return { session, emitted, checkoutDiffManager };
}

describe("Session checkout lazy diff handlers", () => {
  beforeEach(() => {
    getCheckoutDiffFileMock.mockReset();
  });

  test("checkout/subscribe_diff emits initial metadata snapshot and replaces existing subscription", async () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    const subscribeLazy = vi
      .fn()
      .mockResolvedValueOnce({
        initial: {
          cwd: "/tmp/repo",
          files: [
            {
              path: "src/example.ts",
              isNew: false,
              isDeleted: false,
              additions: 1,
              deletions: 0,
              fingerprint: "fp-1",
            },
          ],
          error: null,
        },
        unsubscribe: firstUnsubscribe,
      })
      .mockResolvedValueOnce({
        initial: { cwd: "/tmp/repo", files: [], error: null },
        unsubscribe: secondUnsubscribe,
      });

    const { session, emitted } = createSessionForCheckoutDiffTests({
      checkoutDiffManager: {
        subscribe: vi.fn(),
        subscribeLazy,
        getFileHunks: vi.fn(),
        scheduleRefreshForCwd: vi.fn(),
        getMetrics: vi.fn(() => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        })),
        dispose: vi.fn(),
      },
    });

    await session.handleMessage({
      type: "checkout/subscribe_diff",
      requestId: "req-1",
      subscriptionId: "sub-1",
      cwd: "~/repo",
      compare: { mode: "uncommitted" },
    });
    await session.handleMessage({
      type: "checkout/subscribe_diff",
      requestId: "req-2",
      subscriptionId: "sub-1",
      cwd: "~/repo",
      compare: { mode: "uncommitted" },
    });

    expect(subscribeLazy).toHaveBeenNthCalledWith(
      1,
      { cwd: `${homedir()}/repo`, compare: { mode: "uncommitted" } },
      expect.any(Function),
    );
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({
      type: "checkout/diff_snapshot",
      payload: {
        subscriptionId: "sub-1",
        requestId: "req-1",
        cwd: "/tmp/repo",
      },
    });
  });

  test("checkout/get_file_hunks serves cached hunks before falling back to git", async () => {
    const cachedHunks = [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [{ type: "header", content: "@@ -1,1 +1,2 @@" }],
      },
    ];
    const getFileHunks = vi.fn(() => cachedHunks);
    const { session, emitted } = createSessionForCheckoutDiffTests({
      checkoutDiffManager: {
        subscribe: vi.fn(),
        subscribeLazy: vi.fn(),
        getFileHunks,
        scheduleRefreshForCwd: vi.fn(),
        getMetrics: vi.fn(() => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        })),
        dispose: vi.fn(),
      },
    });

    await session.handleMessage({
      type: "checkout/get_file_hunks",
      requestId: "req-hunks",
      cwd: "/tmp/repo",
      path: "src/example.ts",
      compare: { mode: "uncommitted" },
    });

    expect(getFileHunks).toHaveBeenCalledWith(
      "/tmp/repo",
      { mode: "uncommitted" },
      "src/example.ts",
    );
    expect(getCheckoutDiffFileMock).not.toHaveBeenCalled();
    expect(emitted[0]).toMatchObject({
      type: "checkout/file_hunks_response",
      payload: {
        requestId: "req-hunks",
        path: "src/example.ts",
        hunks: cachedHunks,
        error: null,
      },
    });
  });

  test("checkout/get_file_hunks falls back to single-file diff and unsubscribe cleans up", async () => {
    const unsubscribe = vi.fn();
    getCheckoutDiffFileMock.mockResolvedValueOnce({
      path: "src/example.ts",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 2,
          lines: [{ type: "header", content: "@@ -1,1 +1,2 @@" }],
        },
      ],
      status: "ok",
    });

    const { session, emitted } = createSessionForCheckoutDiffTests({
      checkoutDiffManager: {
        subscribe: vi.fn(),
        subscribeLazy: vi.fn(async () => ({
          initial: { cwd: "/tmp/repo", files: [], error: null },
          unsubscribe,
        })),
        getFileHunks: vi.fn(() => null),
        scheduleRefreshForCwd: vi.fn(),
        getMetrics: vi.fn(() => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        })),
        dispose: vi.fn(),
      },
    });

    await session.handleMessage({
      type: "checkout/subscribe_diff",
      requestId: "req-sub",
      subscriptionId: "sub-1",
      cwd: "/tmp/repo",
      compare: { mode: "base", baseRef: "main" },
    });
    await session.handleMessage({
      type: "checkout/get_file_hunks",
      requestId: "req-hunks",
      cwd: "/tmp/repo",
      path: "src/example.ts",
      compare: { mode: "base", baseRef: "main" },
    });
    await session.handleMessage({
      type: "checkout/unsubscribe_diff",
      subscriptionId: "sub-1",
    });

    expect(getCheckoutDiffFileMock).toHaveBeenCalledWith(
      "/tmp/repo",
      {
        mode: "base",
        baseRef: "main",
        ignoreWhitespace: undefined,
        includeStructured: true,
      },
      "src/example.ts",
      { paseoHome: "/tmp/paseo-test" },
    );
    expect(emitted[1]).toMatchObject({
      type: "checkout/file_hunks_response",
      payload: {
        requestId: "req-hunks",
        path: "src/example.ts",
        error: null,
      },
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
