import { resolve } from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";
import type { WorkspaceDescriptorPayload } from "../../messages.js";
import type {
  WorkspaceGitListener,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";
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
  diffStat?: { additions: number; deletions: number } | null;
}): WorkspaceDescriptorPayload {
  return {
    id: overrides.id,
    workspaceDirectory: overrides.workspaceDirectory,
    projectKind: overrides.projectKind ?? "git",
    workspaceKind: overrides.workspaceKind ?? "local_checkout",
    name: overrides.name ?? null,
    diffStat: overrides.diffStat ?? null,
  } as unknown as WorkspaceDescriptorPayload;
}

function makeSnapshot(cwd: string, currentBranch: string | null): WorkspaceGitRuntimeSnapshot {
  return { cwd, git: { currentBranch } } as unknown as WorkspaceGitRuntimeSnapshot;
}

function makeRecord(workspaceId: string): PersistedWorkspaceRecord {
  return { workspaceId } as unknown as PersistedWorkspaceRecord;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

function buildHarness(opts: { emitCwdRejects?: boolean } = {}) {
  const listeners = new Map<string, WorkspaceGitListener>();
  const registerCalls: string[] = [];
  const unsubscribeCalls: string[] = [];
  const emitCwdCalls: string[] = [];
  const emitWorkspaceIdCalls: string[] = [];
  const statusCalls: Array<{ cwd: string; branch: string | null }> = [];
  const branchChanges: Array<[string, string | null, string | null]> = [];
  const warnCalls: unknown[][] = [];
  const describeCalls: PersistedWorkspaceRecord[] = [];
  let describeResult: WorkspaceDescriptorPayload | null = null;

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
    describeWorkspaceRecordWithGitData: async (workspace) => {
      describeCalls.push(workspace);
      if (!describeResult) {
        throw new Error("describeResult not set");
      }
      return describeResult;
    },
    emitWorkspaceUpdateForCwd: async (cwd) => {
      emitCwdCalls.push(cwd);
      if (opts.emitCwdRejects) {
        throw new Error("emit boom");
      }
    },
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      emitWorkspaceIdCalls.push(workspaceId);
    },
    emitStatusUpdate: (cwd, snapshot) => {
      statusCalls.push({ cwd, branch: snapshot.git.currentBranch ?? null });
    },
    onBranchChanged: (workspaceId, oldBranch, newBranch) => {
      branchChanges.push([workspaceId, oldBranch, newBranch]);
    },
    logger: { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as pino.Logger,
  });

  function emitSnapshot(cwd: string, branch: string | null): void {
    const listener = listeners.get(cwd);
    if (!listener) {
      throw new Error(`no listener registered for ${cwd}`);
    }
    listener(makeSnapshot(cwd, branch));
  }

  return {
    service,
    emitSnapshot,
    registerCalls,
    unsubscribeCalls,
    emitCwdCalls,
    emitWorkspaceIdCalls,
    statusCalls,
    branchChanges,
    warnCalls,
    describeCalls,
    setDescribeResult: (descriptor: WorkspaceDescriptorPayload) => {
      describeResult = descriptor;
    },
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

describe("shouldSkipUpdate", () => {
  test("returns false when no observer exists for the workspace", () => {
    const h = buildHarness();
    expect(h.service.shouldSkipUpdate("unknown", null)).toBe(false);
  });

  test("skips a repeat descriptor state and re-emits when it changes", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    const a = makeDescriptor({ id: "ws1", workspaceDirectory: WS1, name: "main" });
    const b = makeDescriptor({ id: "ws1", workspaceDirectory: WS1, name: "feature" });
    expect(h.service.shouldSkipUpdate("ws1", a)).toBe(false);
    expect(h.service.shouldSkipUpdate("ws1", a)).toBe(true);
    expect(h.service.shouldSkipUpdate("ws1", b)).toBe(false);
  });

  test("starts from the descriptor state recorded during observer sync", () => {
    const h = buildHarness();
    const descriptor = makeDescriptor({ id: "ws1", workspaceDirectory: WS1, name: "main" });
    h.service.syncObservers([descriptor]);
    expect(h.service.shouldSkipUpdate("ws1", descriptor)).toBe(true);
  });
});

describe("recordDescriptorState", () => {
  test("fires onBranchChanged once per branch name transition", () => {
    const h = buildHarness();
    h.service.syncObservers([makeDescriptor({ id: "ws1", workspaceDirectory: WS1 })]);
    const feature = makeDescriptor({ id: "ws1", workspaceDirectory: WS1, name: "feature" });
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
      makeDescriptor({ id: "ws1", workspaceDirectory: WS1, name: "main" }),
      makeDescriptor({ id: "ws2", workspaceDirectory: WS1, name: "main" }),
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
    expect(h.service.shouldSkipUpdate("ws1", descriptor)).toBe(false);
    h.service.recordDescriptorState("ws1", descriptor);
    expect(h.branchChanges).toEqual([]);
  });
});

describe("syncObserverForWorkspace / warmGitData", () => {
  test("describes the record then registers the observer", async () => {
    const h = buildHarness();
    h.setDescribeResult(makeDescriptor({ id: "ws1", workspaceDirectory: WS1 }));
    await h.service.syncObserverForWorkspace(makeRecord("ws1"));
    expect(h.describeCalls).toEqual([makeRecord("ws1")]);
    expect(h.registerCalls).toEqual([WS1]);
  });

  test("warmGitData registers the observer and emits a workspace update", async () => {
    const h = buildHarness();
    h.setDescribeResult(makeDescriptor({ id: "ws1", workspaceDirectory: WS1 }));
    await h.service.warmGitData(makeRecord("ws1"));
    expect(h.registerCalls).toEqual([WS1]);
    expect(h.emitWorkspaceIdCalls).toEqual(["ws1"]);
  });
});
