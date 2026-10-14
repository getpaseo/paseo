import { resolve } from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";
import type { FileObserver } from "../../file-explorer/observer.js";
import type { WorkspaceDescriptorPayload } from "../../messages.js";
import type {
  WorkspaceGitListener,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import { createWorkspaceGitObserverService } from "./workspace-git-observer-service.js";

// Watch targets are keyed by resolve(cwd), which is platform-dependent (POSIX vs Windows
// drive paths). Resolve the test cwds the same way so assertions hold on every platform.
const WS1 = resolve("/repo/ws1");
const WS2 = resolve("/repo/ws2");

// The service reads only WorkspaceGitService.registerWorkspace plus a handful of injected
// session callbacks. The harness below implements exactly that slice as in-memory adapters:
// registerWorkspace captures the per-cwd listener so a test can drive a git snapshot, and the
// callbacks are capture-arrays. No mocks — the seams are the injected ports.

function makeDescriptor(overrides: {
  id: string;
  workspaceDirectory: string;
  projectKind?: string;
  workspaceKind?: "directory" | "local_checkout" | "worktree";
  name?: string | null;
  currentBranch?: string | null;
  diffStat?: { additions: number; deletions: number } | null;
}): WorkspaceDescriptorPayload {
  return {
    id: overrides.id,
    workspaceDirectory: overrides.workspaceDirectory,
    projectKind: overrides.projectKind ?? "git",
    workspaceKind: overrides.workspaceKind ?? "local_checkout",
    name: overrides.name ?? null,
    ...(overrides.currentBranch !== undefined
      ? { gitRuntime: { currentBranch: overrides.currentBranch } }
      : {}),
    diffStat: overrides.diffStat ?? null,
  } as unknown as WorkspaceDescriptorPayload;
}

function makeSnapshot(cwd: string, currentBranch: string | null): WorkspaceGitRuntimeSnapshot {
  return { cwd, git: { currentBranch } } as unknown as WorkspaceGitRuntimeSnapshot;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

function buildHarness(
  opts: { emitCwdRejects?: boolean; configWatchRejects?: boolean; configExists?: boolean } = {},
) {
  const listeners = new Map<string, WorkspaceGitListener>();
  const registerCalls: string[] = [];
  const unsubscribeCalls: string[] = [];
  const emitCwdCalls: string[] = [];
  const statusCalls: Array<{ cwd: string; branch: string | null }> = [];
  const branchChanges: Array<[string, string | null, string | null]> = [];
  const warnCalls: unknown[][] = [];
  const configWatchCalls: Array<{ cwd: string; path: string }> = [];
  const configUnwatchCalls: string[] = [];
  const configListeners = new Map<string, () => void>();
  const pendingConfigWatches: Array<() => void> = [];

  // paseo.json watches stay pending until a test calls resolveConfigWatches(), so a test
  // controls when each watch starts.
  const configObserver: Pick<FileObserver, "subscribe"> = {
    async subscribe(input, listener) {
      configWatchCalls.push(input);
      if (opts.configWatchRejects) throw new Error("watch boom");
      await new Promise<void>((done) => pendingConfigWatches.push(done));
      configListeners.set(input.cwd, () => listener({ status: "missing", ...input }));
      return {
        initial: opts.configExists
          ? { status: "ready", ...input, size: 2, modifiedAt: "2026-01-01T00:00:00.000Z" }
          : { status: "missing", ...input },
        unsubscribe() {
          configUnwatchCalls.push(input.cwd);
          configListeners.delete(input.cwd);
        },
      };
    },
  };

  const workspaceGitService: Pick<WorkspaceGitService, "registerWorkspace"> = {
    registerWorkspace({ cwd }, listener) {
      registerCalls.push(cwd);
      listeners.set(cwd, listener);
      return {
        unsubscribe() {
          unsubscribeCalls.push(cwd);
          listeners.delete(cwd);
        },
      };
    },
  };

  const service = createWorkspaceGitObserverService({
    workspaceGitService,
    emitWorkspaceUpdateForCwd: async (cwd) => {
      emitCwdCalls.push(cwd);
      if (opts.emitCwdRejects) {
        throw new Error("emit boom");
      }
    },
    emitStatusUpdate: (cwd, snapshot) => {
      statusCalls.push({ cwd, branch: snapshot.git.currentBranch ?? null });
    },
    onBranchChanged: (workspaceId, oldBranch, newBranch) => {
      branchChanges.push([workspaceId, oldBranch, newBranch]);
    },
    configObserver,
    logger: { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as pino.Logger,
  });

  function emitSnapshot(cwd: string, branch: string | null): void {
    const listener = listeners.get(cwd);
    if (!listener) {
      throw new Error(`no listener registered for ${cwd}`);
    }
    listener(makeSnapshot(cwd, branch));
  }

  function changeConfig(cwd: string): void {
    const listener = configListeners.get(cwd);
    if (!listener) {
      throw new Error(`no paseo.json listener registered for ${cwd}`);
    }
    listener();
  }

  function resolveConfigWatches(): void {
    for (const done of pendingConfigWatches.splice(0)) done();
  }

  return {
    service,
    emitSnapshot,
    changeConfig,
    resolveConfigWatches,
    configWatchCalls,
    configUnwatchCalls,
    registerCalls,
    unsubscribeCalls,
    emitCwdCalls,
    statusCalls,
    branchChanges,
    warnCalls,
  };
}

describe("syncObservers", () => {
  test("registers a WorkspaceGitService subscription for a git workspace", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    expect(h.registerCalls).toEqual([WS1]);
  });

  test("does not register a non-git workspace", () => {
    const h = buildHarness();
    h.service.syncObservers([
      makeDescriptor({
        id: "ws1",
        workspaceDirectory: WS1,
        projectKind: "directory",
        workspaceKind: "directory",
      }),
    ]);
    expect(h.registerCalls).toEqual([]);
  });

  test("registers a Git workspace even when its owning project is non-Git", () => {
    const h = buildHarness();
    h.service.syncObservers([
      makeDescriptor({ id: "ws1", workspaceDirectory: WS1, projectKind: "non_git" }),
    ]);
    expect(h.registerCalls).toEqual([WS1]);
  });

  test("is idempotent — re-syncing the same git workspace does not re-register", () => {
    const h = buildHarness();
    const descriptor = makeDescriptor({ id: "ws1", workspaceDirectory: WS1 });
    h.service.syncObservers([descriptor]);
    h.service.syncObservers([descriptor]);
    expect(h.registerCalls).toEqual([WS1]);
  });

  test("shares one cwd subscription across distinct workspace identities", () => {
    const h = buildHarness();
    h.service.syncObservers([
      makeDescriptor({ id: "ws1", workspaceDirectory: WS1 }),
      makeDescriptor({ id: "ws2", workspaceDirectory: WS1 }),
    ]);
    expect(h.registerCalls).toEqual([WS1]);
  });

  test("tears down the subscription when a git workspace becomes non-git", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    h.service.syncObservers([
      makeDescriptor({
        id: "ws1",
        workspaceDirectory: WS1,
        projectKind: "directory",
        workspaceKind: "directory",
      }),
    ]);
    expect(h.unsubscribeCalls).toEqual([WS1]);
  });

  test("keeps a shared subscription when one sibling becomes non-git", () => {
    const h = buildHarness();
    h.service.syncObservers([
      makeDescriptor({ id: "ws1", workspaceDirectory: WS1 }),
      makeDescriptor({ id: "ws2", workspaceDirectory: WS1 }),
    ]);
    h.service.syncObservers([
      makeDescriptor({
        id: "ws1",
        workspaceDirectory: WS1,
        workspaceKind: "directory",
      }),
    ]);
    expect(h.unsubscribeCalls).toEqual([]);
    h.emitSnapshot(WS1, "feature");
    expect(h.branchChanges).toEqual([["ws2", null, "feature"]]);
  });

  test("reports observer ownership as workspaces are added and removed", () => {
    const h = buildHarness();
    h.service.syncObservers([
      makeDescriptor({ id: "ws1", workspaceDirectory: WS1 }),
      makeDescriptor({ id: "ws2", workspaceDirectory: WS1 }),
      makeDescriptor({ id: "ws3", workspaceDirectory: WS2 }),
    ]);

    expect(h.service.getMetrics()).toEqual({
      watchedDirectoryCount: 2,
      workspaceRecordCount: 3,
      subscriptionCount: 2,
    });

    h.service.removeForWorkspaceId("ws1");
    expect(h.service.getMetrics()).toEqual({
      watchedDirectoryCount: 2,
      workspaceRecordCount: 2,
      subscriptionCount: 2,
    });

    h.service.dispose();
    expect(h.service.getMetrics()).toEqual({
      watchedDirectoryCount: 0,
      workspaceRecordCount: 0,
      subscriptionCount: 0,
    });
  });
});

describe("git snapshot listener", () => {
  test("fans a snapshot out to branch-change, workspace-update, and status-update", async () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    h.emitSnapshot(WS1, "feature");
    await flushMicrotasks();
    expect(h.branchChanges).toEqual([["ws1", null, "feature"]]);
    expect(h.emitCwdCalls).toEqual([WS1]);
    expect(h.statusCalls).toEqual([{ cwd: WS1, branch: "feature" }]);
  });

  test("does not re-fire onBranchChanged when the branch is unchanged", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    h.emitSnapshot(WS1, "feature");
    h.emitSnapshot(WS1, "feature");
    expect(h.branchChanges).toEqual([["ws1", null, "feature"]]);
  });

  test("logs and swallows an emit failure without skipping the status update", async () => {
    const h = buildHarness({ emitCwdRejects: true });
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    expect(() => h.emitSnapshot(WS1, "feature")).not.toThrow();
    expect(h.statusCalls).toEqual([{ cwd: WS1, branch: "feature" }]);
    await flushMicrotasks();
    expect(h.warnCalls).toHaveLength(1);
  });
});

describe("recordDescriptorState", () => {
  test("does not treat a workspace title as a branch change", () => {
    const h = buildHarness();
    const titledMain = makeDescriptor({
      id: "ws1",
      workspaceDirectory: WS1,
      name: "Paseo main",
      currentBranch: "main",
    });
    h.service.syncObservers([titledMain]);

    h.emitSnapshot(WS1, "main");
    h.service.recordDescriptorState("ws1", titledMain);

    expect(h.branchChanges).toEqual([]);
  });

  test("fires onBranchChanged once per branch name transition", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    const feature = makeDescriptor({
      id: "ws1",
      workspaceDirectory: WS1,
      name: "Feature workspace",
      currentBranch: "feature",
    });
    h.service.recordDescriptorState("ws1", feature);
    h.service.recordDescriptorState("ws1", feature);
    expect(h.branchChanges).toEqual([["ws1", null, "feature"]]);
  });

  test("does nothing for an unknown workspace", () => {
    const h = buildHarness();
    h.service.recordDescriptorState(
      "unknown",
      makeDescriptor({ id: "x", workspaceDirectory: "/x" }),
    );
    expect(h.branchChanges).toEqual([]);
  });
});

describe("teardown", () => {
  test("removeForWorkspaceId unsubscribes the matching observer", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    h.service.removeForWorkspaceId("ws1");
    expect(h.unsubscribeCalls).toEqual([WS1]);
  });

  test("removeForWorkspaceId is a no-op for an unknown workspace", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    h.service.removeForWorkspaceId("nope");
    expect(h.unsubscribeCalls).toEqual([]);
  });

  test("keeps a shared cwd subscription until its last workspace is removed", () => {
    const h = buildHarness();
    h.service.syncObservers([
      makeDescriptor({ id: "ws1", workspaceDirectory: WS1, name: "Main", currentBranch: "main" }),
      makeDescriptor({ id: "ws2", workspaceDirectory: WS1, name: "Main", currentBranch: "main" }),
    ]);

    h.emitSnapshot(WS1, "feature");
    h.service.removeForWorkspaceId("ws1");
    expect(h.unsubscribeCalls).toEqual([]);

    h.emitSnapshot(WS1, "next");
    expect(h.branchChanges).toEqual([
      ["ws1", "main", "feature"],
      ["ws2", "main", "feature"],
      ["ws2", "feature", "next"],
    ]);

    h.service.removeForWorkspaceId("ws2");
    expect(h.unsubscribeCalls).toEqual([WS1]);
    expect(() => h.emitSnapshot(WS1, "x")).toThrow();
  });

  test("dispose releases every live subscription", () => {
    const h = buildHarness();
    h.service.syncObservers([
      makeDescriptor({ id: "ws1", workspaceDirectory: WS1 }),
      makeDescriptor({ id: "ws2", workspaceDirectory: WS2 }),
    ]);
    h.service.dispose();
    expect(h.unsubscribeCalls.sort()).toEqual([WS1, WS2]);
  });

  test("dispose clears watch targets so post-teardown lookups find nothing", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    h.service.dispose();
    const descriptor = makeDescriptor({ id: "ws1", workspaceDirectory: WS1, name: "main" });
    h.service.recordDescriptorState("ws1", descriptor);
    expect(h.branchChanges).toEqual([]);
  });
});

describe("paseo.json observation", () => {
  const directory = (id: string, workspaceDirectory: string) =>
    makeDescriptor({
      id,
      workspaceDirectory,
      projectKind: "directory",
      workspaceKind: "directory",
    });

  test("watches paseo.json for Git and directory workspaces and refreshes on start and change", async () => {
    const h = buildHarness({ configExists: true });
    h.service.syncObservers([
      directory("ws1", WS1),
      makeDescriptor({ id: "ws2", workspaceDirectory: WS2 }),
    ]);
    expect(h.configWatchCalls).toEqual([
      { cwd: WS1, path: "paseo.json" },
      { cwd: WS2, path: "paseo.json" },
    ]);

    h.resolveConfigWatches();
    await flushMicrotasks();
    expect(h.emitCwdCalls).toEqual([WS1, WS2]);

    h.changeConfig(WS1);
    await flushMicrotasks();
    expect(h.emitCwdCalls).toEqual([WS1, WS2, WS1]);
  });

  test("shares one watch per directory until its last workspace is removed", async () => {
    const h = buildHarness();
    h.service.syncObservers([directory("ws1", WS1), directory("ws2", WS1)]);
    h.service.syncObservers([directory("ws1", WS1)]);
    h.resolveConfigWatches();
    await flushMicrotasks();
    expect(h.configWatchCalls).toHaveLength(1);
    expect(h.emitCwdCalls).toEqual([]);

    h.service.removeForWorkspaceId("ws1");
    expect(h.configUnwatchCalls).toEqual([]);
    h.service.removeForWorkspaceId("ws2");
    expect(h.configUnwatchCalls).toEqual([WS1]);
  });

  test("moves the watch when a workspace changes directory", async () => {
    const h = buildHarness();
    h.service.syncObservers([directory("ws1", WS1)]);
    h.resolveConfigWatches();
    await flushMicrotasks();
    h.service.syncObservers([directory("ws1", WS2)]);
    expect(h.configUnwatchCalls).toEqual([WS1]);
    expect(h.configWatchCalls.map((call) => call.cwd)).toEqual([WS1, WS2]);
  });

  test("releases a watch removed before its subscription resolves", async () => {
    const h = buildHarness();
    h.service.syncObservers([directory("ws1", WS1)]);
    h.service.removeForWorkspaceId("ws1");
    expect(h.configUnwatchCalls).toEqual([]);

    h.resolveConfigWatches();
    await flushMicrotasks();
    expect(h.configUnwatchCalls).toEqual([WS1]);
  });

  test("reconcile and dispose release watches", async () => {
    const h = buildHarness();
    h.service.syncObservers([directory("ws1", WS1), directory("ws2", WS2)]);
    h.resolveConfigWatches();
    await flushMicrotasks();

    h.service.reconcileObservers([directory("ws2", WS2)]);
    expect(h.configUnwatchCalls).toEqual([WS1]);
    h.service.dispose();
    expect(h.configUnwatchCalls).toEqual([WS1, WS2]);
  });

  test("logs a failed watch without failing the sync", async () => {
    const h = buildHarness({ configWatchRejects: true });
    expect(() => h.service.syncObservers([directory("ws1", WS1)])).not.toThrow();
    await flushMicrotasks();
    expect(h.warnCalls).toHaveLength(1);
  });
});
