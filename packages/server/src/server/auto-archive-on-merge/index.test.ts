import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DEFERRED_POLL_INTERVAL_MS,
  setupAutoArchiveOnMerge,
  type AutoArchiveOnMergeOptions,
} from "./index.js";
import type { ArchiveIfSafeDependencies } from "./archive-if-safe.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import type { AgentSubscriber } from "../agent/agent-manager.js";

const CWD = "/tmp/paseo/worktrees/repo/branch";
const WORKSPACE_ID = "ws-auto-archive";

function createPullRequest(
  overrides?: Partial<NonNullable<WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"]>>,
): NonNullable<WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"]> {
  return {
    url: "https://github.com/acme/repo/pull/123",
    title: "Merge me",
    state: "open",
    baseRefName: "main",
    headRefName: "feature",
    isMerged: true,
    ...overrides,
  };
}

function createSnapshot(): WorkspaceGitRuntimeSnapshot {
  return {
    cwd: CWD,
    git: {
      isGit: true,
      repoRoot: "/tmp/repo",
      mainRepoRoot: "/tmp/repo",
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: true,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 0, deletions: 0 },
    },
    forge: {
      featuresEnabled: true,
      pullRequest: createPullRequest(),
      error: null,
    },
  };
}

function createLogger(): Logger {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return logger as unknown as Logger;
}

function createTestHarness(input: {
  getSnapshot: ReturnType<typeof vi.fn>;
  agentBusy: () => boolean;
  autoArchiveAfterMerge?: () => boolean;
}) {
  let capturedSubscriber: AgentSubscriber | undefined;
  let snapshotListener: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | undefined;
  const unsubscribeGitSnapshot = vi.fn();
  const unsubscribeAgentEvents = vi.fn();

  const archiveByScope = vi.fn(async () => ({
    archivedAgentIds: [],
    archivedWorkspaceIds: [WORKSPACE_ID],
    removedDirectory: false,
  }));

  const log = createLogger();

  const options: AutoArchiveOnMergeOptions = {
    logger: log,
    paseoHome: "/tmp/paseo",
    daemonConfigStore: {
      get: () => ({ autoArchiveAfterMerge: (input.autoArchiveAfterMerge ?? (() => true))() }),
    } as unknown as AutoArchiveOnMergeOptions["daemonConfigStore"],
    workspaceGitService: {
      getSnapshot: input.getSnapshot,
      onSnapshotUpdated: (listener: (snapshot: WorkspaceGitRuntimeSnapshot) => void) => {
        snapshotListener = listener;
        return { unsubscribe: unsubscribeGitSnapshot };
      },
    } as unknown as AutoArchiveOnMergeOptions["workspaceGitService"],
    github: {} as AutoArchiveOnMergeOptions["github"],
    agentManager: {
      hasInFlightRun: () => input.agentBusy(),
      hasWorkspaceInFlightRun: (workspaceId: string) =>
        workspaceId === WORKSPACE_ID && input.agentBusy(),
      subscribe: (subscriber: AgentSubscriber) => {
        capturedSubscriber = subscriber;
        return unsubscribeAgentEvents;
      },
    } as unknown as AutoArchiveOnMergeOptions["agentManager"],
    agentStorage: {} as AutoArchiveOnMergeOptions["agentStorage"],
    terminalManager: {} as AutoArchiveOnMergeOptions["terminalManager"],
    findWorkspaceIdForCwd: vi.fn(async () => WORKSPACE_ID),
    listActiveWorkspaces: vi.fn(async () => []),
    getAutoArchivedChangeRequestUrl: vi.fn(async () => null),
    archiveWorkspaceRecord: vi.fn(async () => {}),
    markWorkspaceArchiving: vi.fn(),
    clearWorkspaceArchiving: vi.fn(),
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
  };

  const deps: ArchiveIfSafeDependencies = {
    archiveByScope,
    resolveWorkspaceIdAtPath: vi.fn(async () => WORKSPACE_ID),
    isPaseoOwnedWorktreeCwd: vi.fn(async () => ({
      allowed: true,
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/paseo/worktrees/repo",
      worktreePath: CWD,
    })),
    killTerminalsForWorkspace: vi.fn(),
  } as unknown as ArchiveIfSafeDependencies;

  const subscription = setupAutoArchiveOnMerge({ options, deps });

  return {
    archiveByScope,
    log,
    subscription,
    unsubscribeGitSnapshot,
    unsubscribeAgentEvents,
    getSnapshotListener: () => snapshotListener,
    getSubscriber: () => capturedSubscriber,
  };
}

async function waitForDeferral(harness: ReturnType<typeof createTestHarness>): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.log.info).toHaveBeenCalledWith(
      expect.anything(),
      "Deferring auto-archive after merge until attached agent is idle",
    );
  });
}

describe("setupAutoArchiveOnMerge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("retries and archives once the deferring agent goes idle", async () => {
    let agentBusy = true;
    const getSnapshot = vi.fn(async () => createSnapshot());
    const harness = createTestHarness({ getSnapshot, agentBusy: () => agentBusy });

    expect(harness.getSnapshotListener()).toBeDefined();
    expect(harness.getSubscriber()).toBeDefined();

    // Merge event fires while the agent is still busy: must defer, not archive.
    harness.getSnapshotListener()?.(createSnapshot());
    await waitForDeferral(harness);
    expect(harness.archiveByScope).not.toHaveBeenCalled();

    // Agent goes idle: the manager's agent_state event must trigger a recheck
    // that re-evaluates and now succeeds.
    agentBusy = false;
    harness.getSubscriber()?.({
      type: "agent_state",
      agent: { id: "agent-1", workspaceId: WORKSPACE_ID } as never,
    });

    await vi.waitFor(() => {
      expect(harness.archiveByScope).toHaveBeenCalledTimes(1);
    });
  });

  test("ignores agent_state events while the agent is still busy", async () => {
    const getSnapshot = vi.fn(async () => createSnapshot());
    const harness = createTestHarness({ getSnapshot, agentBusy: () => true });

    harness.getSnapshotListener()?.(createSnapshot());
    await waitForDeferral(harness);
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    // A busy-state update (e.g. token usage) fires agent_state without the
    // agent going idle: must not trigger the expensive recheck.
    harness.getSubscriber()?.({
      type: "agent_state",
      agent: { id: "agent-1", workspaceId: WORKSPACE_ID } as never,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.archiveByScope).not.toHaveBeenCalled();
  });

  test("does not crash the daemon when the recheck's own snapshot read fails", async () => {
    let agentBusy = true;
    const getSnapshot = vi.fn(async () => {
      if (getSnapshot.mock.calls.length === 1) {
        return createSnapshot();
      }
      throw new Error("git read failed");
    });
    const harness = createTestHarness({ getSnapshot, agentBusy: () => agentBusy });

    harness.getSnapshotListener()?.(createSnapshot());
    await waitForDeferral(harness);
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      // Agent goes idle: the recheck's own snapshot read throws. This must
      // not surface as an unhandled rejection, and must not crash — the
      // periodic poll (or a later agent_state event) will retry it.
      agentBusy = false;
      harness.getSubscriber()?.({
        type: "agent_state",
        agent: { id: "agent-1", workspaceId: WORKSPACE_ID } as never,
      });
      await vi.waitFor(() => {
        expect(getSnapshot).toHaveBeenCalledTimes(2);
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
    expect(harness.archiveByScope).not.toHaveBeenCalled();
    expect(harness.log.debug).toHaveBeenCalledWith(
      { err: expect.any(Error), cwd: CWD },
      "Failed to read snapshot while rechecking a deferred auto-archive; will retry",
    );
  });

  test("recovers from a single transient snapshot-read failure inside archiveIfSafe's own fetch", async () => {
    let agentBusy = true;
    let callCount = 0;
    const getSnapshot = vi.fn(async () => {
      callCount += 1;
      // Call 1: initial defer. Call 2: recheck's own fetch (succeeds, feeds
      // attemptArchive). Call 3: archiveIfSafe's own internal fetch fails
      // transiently. Call 4: archiveIfSafe's immediate re-retry succeeds.
      if (callCount === 3) {
        throw new Error("transient git read failure");
      }
      return createSnapshot();
    });
    const harness = createTestHarness({ getSnapshot, agentBusy: () => agentBusy });

    harness.getSnapshotListener()?.(createSnapshot());
    await waitForDeferral(harness);

    agentBusy = false;
    harness.getSubscriber()?.({
      type: "agent_state",
      agent: { id: "agent-1", workspaceId: WORKSPACE_ID } as never,
    });

    await vi.waitFor(() => {
      expect(harness.archiveByScope).toHaveBeenCalledTimes(1);
    });
    expect(getSnapshot).toHaveBeenCalledTimes(4);
  });

  test("keeps watching (does not abandon) a workspace whose archiveIfSafe check was inconclusive", async () => {
    // If archiveIfSafe's own snapshot fetch fails on both the first attempt
    // and its immediate retry, that's not a verdict about the workspace
    // (#2886) — the workspace must stay watched so a later poll tick still
    // retries it, instead of being silently abandoned forever.
    vi.useFakeTimers();
    let agentBusy = true;
    let callCount = 0;
    const getSnapshot = vi.fn(async () => {
      callCount += 1;
      // Call 1: initial defer. Call 2: recheck's own fetch (feeds
      // attemptArchive). Calls 3-4: archiveIfSafe's own fetch and its
      // immediate retry both fail — "inconclusive". Call 5+ (next poll
      // tick): everything succeeds.
      if (callCount === 3 || callCount === 4) {
        throw new Error("transient git read failure");
      }
      return createSnapshot();
    });
    const harness = createTestHarness({ getSnapshot, agentBusy: () => agentBusy });

    harness.getSnapshotListener()?.(createSnapshot());
    await vi.waitFor(
      () => {
        expect(harness.log.info).toHaveBeenCalledWith(
          expect.anything(),
          "Deferring auto-archive after merge until attached agent is idle",
        );
      },
      { timeout: 1000 },
    );

    agentBusy = false;
    harness.getSubscriber()?.({
      type: "agent_state",
      agent: { id: "agent-1", workspaceId: WORKSPACE_ID } as never,
    });
    await vi.waitFor(
      () => {
        expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(4);
      },
      { timeout: 1000 },
    );
    expect(harness.archiveByScope).not.toHaveBeenCalled();

    // The next poll tick must still retry this cwd instead of having
    // abandoned it.
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_INTERVAL_MS);
    expect(harness.archiveByScope).toHaveBeenCalledTimes(1);
  });

  test("the periodic poll archives a deferred workspace even when no agent_state event ever fires for it", async () => {
    // Mirrors a workspace deferred solely because of an internal agent
    // (branch-name/git-metadata generator): AgentManager.dispatch() hides
    // internal agents' agent_state events from global subscribers, so the
    // fast path in this module never fires for them (#2886). The periodic
    // poll must still catch and archive the workspace once it's idle.
    vi.useFakeTimers();
    let agentBusy = true;
    const getSnapshot = vi.fn(async () => createSnapshot());
    const harness = createTestHarness({ getSnapshot, agentBusy: () => agentBusy });

    harness.getSnapshotListener()?.(createSnapshot());
    await vi.waitFor(
      () => {
        expect(harness.log.info).toHaveBeenCalledWith(
          expect.anything(),
          "Deferring auto-archive after merge until attached agent is idle",
        );
      },
      { timeout: 1000 },
    );
    expect(harness.archiveByScope).not.toHaveBeenCalled();

    // The internal agent goes idle, but — unlike every other test in this
    // file — no agent_state event is ever delivered for it. Only the timer
    // can unstick this workspace now.
    agentBusy = false;

    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_INTERVAL_MS);

    expect(harness.archiveByScope).toHaveBeenCalledTimes(1);
  });

  test("stops polling a workspace once it becomes permanently ineligible instead of polling it forever", async () => {
    vi.useFakeTimers();
    let agentBusy = true;
    let autoArchiveAfterMerge = true;
    const getSnapshot = vi.fn(async () => createSnapshot());
    const harness = createTestHarness({
      getSnapshot,
      agentBusy: () => agentBusy,
      autoArchiveAfterMerge: () => autoArchiveAfterMerge,
    });

    harness.getSnapshotListener()?.(createSnapshot());
    await vi.waitFor(
      () => {
        expect(harness.log.info).toHaveBeenCalledWith(
          expect.anything(),
          "Deferring auto-archive after merge until attached agent is idle",
        );
      },
      { timeout: 1000 },
    );
    const callsAtDefer = getSnapshot.mock.calls.length;

    // The feature gets disabled entirely before the agent goes idle. The
    // recheck now permanently skips (not a transient collision), so this
    // workspace must stop being watched — otherwise it polls forever.
    autoArchiveAfterMerge = false;
    agentBusy = false;
    harness.getSubscriber()?.({
      type: "agent_state",
      agent: { id: "agent-1", workspaceId: WORKSPACE_ID } as never,
    });
    await vi.waitFor(
      () => {
        expect(getSnapshot.mock.calls.length).toBeGreaterThan(callsAtDefer);
      },
      { timeout: 1000 },
    );
    const callsAfterPermanentSkip = getSnapshot.mock.calls.length;
    expect(harness.archiveByScope).not.toHaveBeenCalled();

    // A later poll tick must not touch this cwd again.
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_INTERVAL_MS);
    expect(getSnapshot.mock.calls.length).toBe(callsAfterPermanentSkip);
  });

  test("unsubscribe() tears down the poll timer and both underlying subscriptions", async () => {
    // The daemon must be able to fully stop this feature (e.g. on shutdown,
    // or in a test harness that starts/stops multiple daemon instances in
    // one process) — a leaked poll timer would keep firing forever.
    vi.useFakeTimers();
    let agentBusy = true;
    const getSnapshot = vi.fn(async () => createSnapshot());
    const harness = createTestHarness({ getSnapshot, agentBusy: () => agentBusy });

    harness.getSnapshotListener()?.(createSnapshot());
    await vi.waitFor(
      () => {
        expect(harness.log.info).toHaveBeenCalledWith(
          expect.anything(),
          "Deferring auto-archive after merge until attached agent is idle",
        );
      },
      { timeout: 1000 },
    );
    const callsBeforeUnsubscribe = getSnapshot.mock.calls.length;

    harness.subscription.unsubscribe();

    expect(harness.unsubscribeGitSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.unsubscribeAgentEvents).toHaveBeenCalledTimes(1);

    // The poll timer must be cleared too: advancing past an interval must
    // not touch the still-deferred (but now orphaned) workspace.
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_INTERVAL_MS * 2);
    expect(getSnapshot.mock.calls.length).toBe(callsBeforeUnsubscribe);
  });
});
