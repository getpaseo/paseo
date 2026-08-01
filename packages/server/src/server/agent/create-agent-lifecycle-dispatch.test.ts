import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { expect, test, vi } from "vitest";

import type { AgentManagerEvent, AgentSubscriber } from "./agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  CreateAgentLifecycleDispatch,
  registerAgentAutoArchive,
} from "./create-agent-lifecycle-dispatch.js";
import {
  requireArchiveCleanupComplete,
  WorkspaceCleanupPendingError,
} from "../workspace-archive-service.js";
import type { PendingAgentCreation, StoredAgentRecord } from "./agent-storage.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { readPaseoWorktreeMetadata } from "../../utils/worktree-metadata.js";

const PENDING_WORKTREE_INCARNATION_ID = "4d2ce498-4c27-4ea2-8ed3-46720de7194e";

function pendingWorktreeTarget(
  targetPath: string,
): Extract<PendingAgentCreation["cleanupTarget"], { kind: "worktree" }> {
  const directoryStat = statSync(targetPath, { bigint: true });
  return {
    kind: "worktree",
    targetPath,
    worktreeIncarnationId: PENDING_WORKTREE_INCARNATION_ID,
    directoryIdentity: {
      device: directoryStat.dev.toString(),
      inode: directoryStat.ino.toString(),
    },
    metadataBaseRefName: "main",
  };
}

class AgentLifecycleEvents {
  private readonly listeners = new Set<AgentSubscriber>();

  subscribe(listener: AgentSubscriber): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  completeTurn(agentId: string): void {
    const event: AgentManagerEvent = {
      type: "agent_stream",
      agentId,
      event: { type: "turn_completed", provider: "codex" },
    };
    for (const listener of this.listeners) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

class LifecycleRearmEvents {
  private readonly listeners = new Set<(workspaceId: string) => void>();

  subscribe(listener: (workspaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(workspaceId = "ws-cleanup-pending"): void {
    for (const listener of this.listeners) listener(workspaceId);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function createLifecycleDispatch(
  agents: AgentLifecycleEvents,
  archiveAgentForClose: (agentId: string) => Promise<void>,
  options?: {
    records?: Map<string, StoredAgentRecord>;
    archiveWorkspaceForClose?: (workspaceId: string, signal?: AbortSignal) => Promise<void>;
    drainWorkspaceLifecycleOperations?: () => Promise<void>;
    getWorkspace?: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
    pendingCreations?: Map<string, PendingAgentCreation>;
    workspaces?: PersistedWorkspaceRecord[];
  },
): CreateAgentLifecycleDispatch {
  const records = options?.records ?? new Map<string, StoredAgentRecord>();
  const pendingCreations = options?.pendingCreations ?? new Map<string, PendingAgentCreation>();
  const dependencies = {
    paseoHome: "/tmp/paseo",
    agentManager: agents,
    agentStorage: {
      list: async () => Array.from(records.values()),
      get: async (agentId: string) => records.get(agentId) ?? null,
      listPendingAgentCreations: async () => Array.from(pendingCreations.values()),
      removePendingAgentCreation: async (agentId: string) => {
        pendingCreations.delete(agentId);
      },
      update: async (
        agentId: string,
        mutation: (record: StoredAgentRecord) => StoredAgentRecord,
      ) => {
        const current = records.get(agentId) ?? ({ id: agentId } as StoredAgentRecord);
        const next = mutation(current);
        records.set(agentId, next);
        return next;
      },
    },
    github: {},
    workspaceGitService: {},
    archiveAgentForClose,
    archiveWorkspaceForClose: options?.archiveWorkspaceForClose ?? (async () => undefined),
    drainWorkspaceLifecycleOperations:
      options?.drainWorkspaceLifecycleOperations ?? (async () => undefined),
    findWorkspaceIdForCwd: async () => null,
    listActiveWorkspaces: async () => [],
    archiveWorkspaceRecord: async () => undefined,
    workspaceRegistry: {
      get:
        options?.getWorkspace ??
        (async (workspaceId: string) =>
          ({
            workspaceId,
            archivedAt: "2025-01-01T00:00:00.000Z",
            cleanupPending: null,
          }) as PersistedWorkspaceRecord),
      list: async () => options?.workspaces ?? [],
    },
    emit: () => undefined,
    emitAgentRemove: () => undefined,
    emitWorkspaceUpdatesForWorkspaceIds: async () => undefined,
    markWorkspaceArchiving: () => undefined,
    clearWorkspaceArchiving: () => undefined,
    killTerminalsForWorkspace: async () => undefined,
    logger: createTestLogger(),
  } as unknown as ConstructorParameters<typeof CreateAgentLifecycleDispatch>[0];
  return new CreateAgentLifecycleDispatch(dependencies);
}

test("startup removes a side-effect-free pending creation reservation", async () => {
  const agentId = "agent-pending-no-side-effects";
  const pendingCreations = new Map<string, PendingAgentCreation>([
    [
      agentId,
      {
        agentId,
        createdAt: "2025-01-01T00:00:00.000Z",
        cleanupTarget: { kind: "agent" },
      },
    ],
  ]);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    pendingCreations,
  });

  await dispatch.recoverPendingAgentCreations();

  expect(pendingCreations.size).toBe(0);
});

test("startup leaves persisted agent cleanup to its durable obligation", async () => {
  const agentId = "agent-pending-now-persisted";
  const pendingCreations = new Map<string, PendingAgentCreation>([
    [
      agentId,
      {
        agentId,
        createdAt: "2025-01-01T00:00:00.000Z",
        cleanupTarget: {
          kind: "worktree",
          targetPath: "/tmp/persisted-agent-worktree",
          worktreeIncarnationId: PENDING_WORKTREE_INCARNATION_ID,
          directoryIdentity: { device: "7", inode: "42" },
          metadataBaseRefName: "main",
        },
      },
    ],
  ]);
  const records = new Map<string, StoredAgentRecord>([
    [
      agentId,
      {
        id: agentId,
        autoArchiveObligation: { phase: "armed", target: { kind: "agent" } },
      } as StoredAgentRecord,
    ],
  ]);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    pendingCreations,
    records,
  });
  const archiveWorktreePath = vi.spyOn(
    dispatch as unknown as {
      archiveWorktreePath(worktreePath: string, workspaceId?: string): Promise<void>;
    },
    "archiveWorktreePath",
  );

  await dispatch.recoverPendingAgentCreations();

  expect(archiveWorktreePath).not.toHaveBeenCalled();
  expect(pendingCreations.size).toBe(0);
});

test("startup removes an exact pre-git worktree reservation without archiving", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "paseo-pre-git-reservation-"));
  const agentId = "agent-pending-pre-git-reservation";
  const pendingCreations = new Map<string, PendingAgentCreation>([
    [
      agentId,
      {
        agentId,
        createdAt: "2025-01-01T00:00:00.000Z",
        cleanupTarget: pendingWorktreeTarget(worktreePath),
      },
    ],
  ]);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    pendingCreations,
  });
  const archiveWorktreePath = vi.spyOn(
    dispatch as unknown as {
      archiveWorktreePath(worktreePath: string, workspaceId?: string): Promise<void>;
    },
    "archiveWorktreePath",
  );

  try {
    await dispatch.recoverPendingAgentCreations();

    expect(archiveWorktreePath).not.toHaveBeenCalled();
    expect(pendingCreations.size).toBe(0);
    expect(existsSync(worktreePath)).toBe(false);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("startup retains and retries an orphan worktree pending creation", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "paseo-orphan-worktree-"));
  mkdirSync(join(worktreePath, ".git"));
  const agentId = "agent-pending-orphan-worktree";
  const pendingCreations = new Map<string, PendingAgentCreation>([
    [
      agentId,
      {
        agentId,
        createdAt: "2025-01-01T00:00:00.000Z",
        cleanupTarget: pendingWorktreeTarget(worktreePath),
      },
    ],
  ]);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    pendingCreations,
  });
  const archiveWorktreePath = vi
    .spyOn(
      dispatch as unknown as {
        archiveWorktreePath(worktreePath: string, workspaceId?: string): Promise<void>;
      },
      "archiveWorktreePath",
    )
    .mockRejectedValueOnce(new Error("physical archive failed"))
    .mockResolvedValue(undefined);

  try {
    await dispatch.recoverPendingAgentCreations();
    expect(pendingCreations.has(agentId)).toBe(true);

    await dispatch.recoverPendingAgentCreations();

    expect(archiveWorktreePath).toHaveBeenCalledTimes(2);
    expect(archiveWorktreePath).toHaveBeenLastCalledWith(resolvePath(worktreePath));
    expect(pendingCreations.size).toBe(0);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("startup does not archive a replacement at a reused pending-creation path", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "paseo-replaced-worktree-"));
  const staleTarget = pendingWorktreeTarget(worktreePath);
  rmSync(worktreePath, { recursive: true, force: true });
  mkdirSync(worktreePath);
  const agentId = "agent-pending-replaced-worktree";
  const pendingCreations = new Map<string, PendingAgentCreation>([
    [
      agentId,
      {
        agentId,
        createdAt: "2025-01-01T00:00:00.000Z",
        cleanupTarget: staleTarget,
      },
    ],
  ]);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    pendingCreations,
  });
  const archiveWorktreePath = vi.spyOn(
    dispatch as unknown as {
      archiveWorktreePath(worktreePath: string, workspaceId?: string): Promise<void>;
    },
    "archiveWorktreePath",
  );

  try {
    await dispatch.recoverPendingAgentCreations();

    expect(archiveWorktreePath).not.toHaveBeenCalled();
    expect(pendingCreations.size).toBe(0);
    expect(statSync(worktreePath).isDirectory()).toBe(true);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("startup repairs metadata after git creation and before archive recovery", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "paseo-unrecorded-worktree-"));
  mkdirSync(join(worktreePath, ".git"));
  const agentId = "agent-pending-metadata-gap";
  const pendingCreations = new Map<string, PendingAgentCreation>([
    [
      agentId,
      {
        agentId,
        createdAt: "2025-01-01T00:00:00.000Z",
        cleanupTarget: pendingWorktreeTarget(worktreePath),
      },
    ],
  ]);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    pendingCreations,
  });
  const archiveWorktreePath = vi
    .spyOn(
      dispatch as unknown as {
        archiveWorktreePath(worktreePath: string, workspaceId?: string): Promise<void>;
      },
      "archiveWorktreePath",
    )
    .mockImplementation(async () => {
      expect(readPaseoWorktreeMetadata(worktreePath)).toMatchObject({
        baseRefName: "main",
        incarnationId: PENDING_WORKTREE_INCARNATION_ID,
      });
    });

  try {
    await dispatch.recoverPendingAgentCreations();

    expect(archiveWorktreePath).toHaveBeenCalledWith(resolvePath(worktreePath));
    expect(pendingCreations.size).toBe(0);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});

test("auto-archive self-releases once and later cancellation waits harmlessly", async () => {
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e3";
  const agents = new AgentLifecycleEvents();
  let archiveCount = 0;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
    },
  });

  agents.completeTurn(agentId);
  await registration.cancel();
  await registration.cancel();
  agents.completeTurn(agentId);

  expect(archiveCount).toBe(1);
  expect(agents.listenerCount()).toBe(0);
});

test("auto-archive retries autonomously after a transient failure", async () => {
  const agentId = "agent-auto-archive-retry";
  const agents = new AgentLifecycleEvents();
  const archive = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("transient archive failure"))
    .mockResolvedValueOnce(undefined);
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive,
    retryBaseMs: 0,
    retryMaxMs: 0,
  });

  agents.completeTurn(agentId);
  await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
  await registration.cancel();
  expect(archive).toHaveBeenCalledTimes(2);
  expect(agents.listenerCount()).toBe(0);
});

test("cleanup pending waits for a lifecycle rearm without a retry loop", async () => {
  vi.useFakeTimers();
  const agentId = "agent-auto-archive-cleanup-pending";
  const agents = new AgentLifecycleEvents();
  const rearmEvents = new LifecycleRearmEvents();
  const archive = vi.fn(async () => {
    const cleanupPendingWorkspaceIds =
      archive.mock.calls.length === 1 ? ["ws-cleanup-pending"] : [];
    requireArchiveCleanupComplete(
      {
        archivedAgentIds: [],
        archivedWorkspaceIds: ["ws-cleanup-pending"],
        removedDirectory: cleanupPendingWorkspaceIds.length === 0,
        cleanupPendingWorkspaceIds,
      },
      "Auto-created worktree archive",
    );
  });
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive,
    shouldRetry: (error) => !(error instanceof WorkspaceCleanupPendingError),
    subscribeToRearm: (rearm) => rearmEvents.subscribe(rearm),
    rearmKeysForError: (error) =>
      error instanceof WorkspaceCleanupPendingError ? error.workspaceIds : [],
  });

  try {
    agents.completeTurn(agentId);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(archive).toHaveBeenCalledTimes(1);
    expect(rearmEvents.listenerCount()).toBe(1);

    rearmEvents.publish();
    await expect(registration.settled).resolves.toBe("completed");

    expect(archive).toHaveBeenCalledTimes(2);
    expect(agents.listenerCount()).toBe(0);
    expect(rearmEvents.listenerCount()).toBe(0);
  } finally {
    await registration.cancel().catch(() => undefined);
    vi.useRealTimers();
  }
});

test("a registry mutation during cleanup failure cannot be lost before rearm waiting", async () => {
  const agentId = "agent-auto-archive-concurrent-rearm";
  const agents = new AgentLifecycleEvents();
  const rearmEvents = new LifecycleRearmEvents();
  let archiveCount = 0;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
      if (archiveCount === 1) {
        rearmEvents.publish();
        throw new WorkspaceCleanupPendingError("Auto-created worktree archive", [
          "ws-cleanup-pending",
        ]);
      }
    },
    shouldRetry: (error) => !(error instanceof WorkspaceCleanupPendingError),
    subscribeToRearm: (rearm) => rearmEvents.subscribe(rearm),
    rearmKeysForError: (error) =>
      error instanceof WorkspaceCleanupPendingError ? error.workspaceIds : [],
  });

  agents.completeTurn(agentId);
  await expect(registration.settled).resolves.toBe("completed");

  expect(archiveCount).toBe(2);
  expect(agents.listenerCount()).toBe(0);
  expect(rearmEvents.listenerCount()).toBe(0);
});

test("cleanup pending ignores unrelated workspace mutations", async () => {
  const agentId = "agent-auto-archive-filtered-rearm";
  const agents = new AgentLifecycleEvents();
  const rearmEvents = new LifecycleRearmEvents();
  const archive = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(
      new WorkspaceCleanupPendingError("Auto-created worktree archive", ["ws-relevant"]),
    )
    .mockResolvedValueOnce(undefined);
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive,
    shouldRetry: (error) => !(error instanceof WorkspaceCleanupPendingError),
    subscribeToRearm: (rearm) => rearmEvents.subscribe(rearm),
    rearmKeysForError: (error) =>
      error instanceof WorkspaceCleanupPendingError ? error.workspaceIds : [],
  });

  agents.completeTurn(agentId);
  await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));

  rearmEvents.publish("ws-unrelated");
  await Promise.resolve();
  expect(archive).toHaveBeenCalledTimes(1);

  rearmEvents.publish("ws-relevant");
  await expect(registration.settled).resolves.toBe("completed");
  expect(archive).toHaveBeenCalledTimes(2);
});

test("lifecycle shutdown cancels listeners and truthfully awaits an active archive", async () => {
  const agentId = "agent-auto-archive-shutdown-wait";
  const agents = new AgentLifecycleEvents();
  let markArchiveStarted!: () => void;
  let releaseArchive!: () => void;
  const archiveStarted = new Promise<void>((resolve) => {
    markArchiveStarted = resolve;
  });
  const archiveFinished = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const dispatch = createLifecycleDispatch(agents, async () => {
    markArchiveStarted();
    await archiveFinished;
  });
  const registration = dispatch.registerAutoArchiveIfRequested({
    autoArchive: true,
    agentId,
    createdWorktree: null,
  });
  agents.completeTurn(agentId);
  await archiveStarted;

  let shutdownSettled = false;
  const shutdown = dispatch.shutdown({ timeoutMs: 5_000 }).then((result) => {
    shutdownSettled = true;
    return result;
  });
  await Promise.resolve();

  expect(shutdownSettled).toBe(false);
  expect(agents.listenerCount()).toBe(0);

  releaseArchive();
  await expect(shutdown).resolves.toEqual({ completed: true, pendingAgentIds: [] });
  await expect(registration.settled).resolves.toBe("completed");
});

test("lifecycle shutdown joins failed-create cleanup that starts during drain", async () => {
  const agents = new AgentLifecycleEvents();
  let markDrainStarted!: () => void;
  let releaseDrain!: () => void;
  const drainStarted = new Promise<void>((resolve) => {
    markDrainStarted = resolve;
  });
  const drainFinished = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  let drainCount = 0;
  const dispatch = createLifecycleDispatch(agents, async () => undefined, {
    drainWorkspaceLifecycleOperations: async () => {
      drainCount += 1;
      if (drainCount === 1) {
        markDrainStarted();
        await drainFinished;
      }
    },
  });
  let markCleanupStarted!: () => void;
  let releaseCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const cleanupFinished = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  vi.spyOn(
    dispatch as unknown as {
      archiveAutoCreatedWorktree(options: unknown): Promise<void>;
    },
    "archiveAutoCreatedWorktree",
  ).mockImplementation(async () => {
    markCleanupStarted();
    await cleanupFinished;
  });

  let shutdownSettled = false;
  const shutdown = dispatch.shutdown({ timeoutMs: 5_000 }).then((result) => {
    shutdownSettled = true;
    return result;
  });
  await drainStarted;
  const cleanup = dispatch.cleanupCreatedWorktreeAfterFailedAgentCreate({
    createdAgentId: null,
    createdWorktree: {
      created: true,
      worktree: { worktreePath: "/tmp/paseo/worktrees/repo/failed-create" },
    } as CreatePaseoWorktreeWorkflowResult,
  });
  await cleanupStarted;
  releaseDrain();
  await Promise.resolve();

  expect(shutdownSettled).toBe(false);

  releaseCleanup();
  await expect(cleanup).resolves.toBeUndefined();
  await expect(shutdown).resolves.toEqual({ completed: true, pendingAgentIds: [] });
  expect(drainCount).toBe(2);
});

test("one dispatcher keeps one lifecycle registration across repeated callers", async () => {
  const agentId = "agent-shared-lifecycle-registration";
  const agents = new AgentLifecycleEvents();
  const dispatch = createLifecycleDispatch(agents, async () => undefined);

  const first = dispatch.registerAutoArchiveIfRequested({
    autoArchive: true,
    agentId,
    createdWorktree: null,
  });
  const second = dispatch.registerAutoArchiveIfRequested({
    autoArchive: true,
    agentId,
    createdWorktree: null,
  });

  expect(second).toBe(first);
  expect(agents.listenerCount()).toBe(1);

  await first.cancel();
  expect(agents.listenerCount()).toBe(0);
});

test("lifecycle shutdown reports its active archive at the deadline", async () => {
  vi.useFakeTimers();
  const agentId = "agent-auto-archive-shutdown-deadline";
  const agents = new AgentLifecycleEvents();
  let markArchiveStarted!: () => void;
  let releaseArchive!: () => void;
  const archiveStarted = new Promise<void>((resolve) => {
    markArchiveStarted = resolve;
  });
  const archiveFinished = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const dispatch = createLifecycleDispatch(agents, async () => {
    markArchiveStarted();
    await archiveFinished;
  });
  const registration = dispatch.registerAutoArchiveIfRequested({
    autoArchive: true,
    agentId,
    createdWorktree: null,
  });

  try {
    agents.completeTurn(agentId);
    await archiveStarted;

    const shutdown = dispatch.shutdown({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(shutdown).resolves.toEqual({ completed: false, pendingAgentIds: [agentId] });
    expect(agents.listenerCount()).toBe(0);

    releaseArchive();
    await expect(registration.settled).resolves.toBe("completed");
    await expect(dispatch.shutdown({ timeoutMs: 100 })).resolves.toEqual({
      completed: true,
      pendingAgentIds: [],
    });
  } finally {
    releaseArchive();
    vi.useRealTimers();
  }
});

test("lifecycle shutdown aborts an active workspace archive", async () => {
  const agentId = "agent-auto-archive-workspace-shutdown";
  const agents = new AgentLifecycleEvents();
  let markArchiveStarted = () => {};
  const archiveStarted = new Promise<void>((resolve) => {
    markArchiveStarted = resolve;
  });
  let receivedSignal: AbortSignal | undefined;
  const dispatch = createLifecycleDispatch(agents, async () => undefined, {
    archiveWorkspaceForClose: async (_workspaceId, signal) => {
      receivedSignal = signal;
      markArchiveStarted();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("workspace archive canceled")), {
          once: true,
        });
      });
    },
  });
  dispatch.registerAutoArchive({
    agentId,
    obligation: { phase: "armed", target: { kind: "workspace", workspaceId: "ws-shutdown" } },
  });
  agents.completeTurn(agentId);
  await archiveStarted;

  await expect(dispatch.shutdown()).resolves.toEqual({
    completed: false,
    pendingAgentIds: [agentId],
  });
  expect(receivedSignal?.aborted).toBe(true);
});

test("auto-archive cancellation observes an in-flight archive rejection", async () => {
  const agentId = "agent-auto-archive-cancel-failure";
  const agents = new AgentLifecycleEvents();
  const failure = new Error("archive failed during cancellation");
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      throw failure;
    },
  });

  agents.completeTurn(agentId);
  await expect(registration.cancel()).rejects.toBe(failure);
  await expect(registration.settled).resolves.toBe("unresolved");
  expect(agents.listenerCount()).toBe(0);
});

test("lifecycle shutdown reports cleanup-pending cancellation as unresolved", async () => {
  const agentId = "agent-auto-archive-shutdown-unresolved";
  const agents = new AgentLifecycleEvents();
  const failure = new WorkspaceCleanupPendingError("Auto-created worktree archive", [
    "ws-cleanup-pending",
  ]);
  const dispatch = createLifecycleDispatch(agents, async () => {
    throw failure;
  });
  const registration = dispatch.registerAutoArchiveIfRequested({
    autoArchive: true,
    agentId,
    createdWorktree: null,
  });

  agents.completeTurn(agentId);
  await vi.waitFor(() => expect(agents.listenerCount()).toBe(1));

  await expect(dispatch.shutdown()).resolves.toEqual({
    completed: false,
    pendingAgentIds: [agentId],
  });
  await expect(registration.settled).resolves.toBe("unresolved");
  expect(agents.listenerCount()).toBe(0);
});

test("lifecycle dispatch does not permanently suppress an agent after archive failure", async () => {
  const agentId = "agent-dispatch-auto-archive-retry";
  const agents = new AgentLifecycleEvents();
  const archiveAgentForClose = vi
    .fn<(agentId: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error("transient close failure"))
    .mockResolvedValueOnce(undefined);
  const dispatch = createLifecycleDispatch(agents, archiveAgentForClose);
  const registration = dispatch.registerAutoArchiveIfRequested({
    autoArchive: true,
    agentId,
    createdWorktree: null,
  });

  agents.completeTurn(agentId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  agents.completeTurn(agentId);
  await registration.cancel();

  expect(archiveAgentForClose).toHaveBeenCalledTimes(2);
  expect(agents.listenerCount()).toBe(0);
});

test("startup completes an armed agent-only auto-archive obligation", async () => {
  const agentId = "agent-restart-armed";
  const records = new Map<string, StoredAgentRecord>([
    [
      agentId,
      {
        id: agentId,
        autoArchiveObligation: { phase: "armed", target: { kind: "agent" } },
      } as StoredAgentRecord,
    ],
  ]);
  const archiveAgentForClose = vi.fn(async () => undefined);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), archiveAgentForClose, {
    records,
  });

  await dispatch.recoverPersistedAutoArchives();
  await vi.waitFor(() => expect(archiveAgentForClose).toHaveBeenCalledWith(agentId));

  await vi.waitFor(() => expect(records.get(agentId)?.autoArchiveObligation).toBeUndefined());
});

test("startup completes a persisted workspace auto-archive obligation", async () => {
  const agentId = "agent-restart-workspace";
  const records = new Map<string, StoredAgentRecord>([
    [
      agentId,
      {
        id: agentId,
        autoArchiveObligation: {
          phase: "pending",
          target: { kind: "workspace", workspaceId: "ws-restart" },
        },
      } as StoredAgentRecord,
    ],
  ]);
  const archiveWorkspaceForClose = vi.fn(async () => undefined);
  const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    records,
    archiveWorkspaceForClose,
  });

  await dispatch.recoverPersistedAutoArchives();
  await vi.waitFor(() =>
    expect(archiveWorkspaceForClose).toHaveBeenCalledWith("ws-restart", expect.any(AbortSignal)),
  );

  await vi.waitFor(() => expect(records.get(agentId)?.autoArchiveObligation).toBeUndefined());
});

test.each([
  ["missing", async () => null],
  [
    "still active",
    async (workspaceId: string) =>
      ({ workspaceId, archivedAt: null, cleanupPending: null }) as PersistedWorkspaceRecord,
  ],
  [
    "cleanup pending",
    async (workspaceId: string) =>
      ({
        workspaceId,
        archivedAt: "2025-01-01T00:00:00.000Z",
        cleanupPending: { directoryPath: "/tmp/worktree" },
      }) as PersistedWorkspaceRecord,
  ],
])(
  "startup retains a workspace obligation when archive readback is %s",
  async (_name, getWorkspace) => {
    const agentId = "agent-restart-workspace-unverified";
    const obligation = {
      phase: "pending",
      target: { kind: "workspace", workspaceId: "ws-unverified" },
    } as const;
    const records = new Map<string, StoredAgentRecord>([
      [agentId, { id: agentId, autoArchiveObligation: obligation } as StoredAgentRecord],
    ]);
    const getWorkspaceSpy = vi.fn(getWorkspace);
    const dispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
      records,
      getWorkspace: getWorkspaceSpy,
    });

    await dispatch.recoverPersistedAutoArchives();
    await vi.waitFor(() => expect(getWorkspaceSpy).toHaveBeenCalledWith("ws-unverified"));
    expect(records.get(agentId)?.autoArchiveObligation).toEqual(obligation);
  },
);

test.each([
  ["workspace cleanup failure", new WorkspaceCleanupPendingError("archive", ["ws-restart"])],
  ["failure before cleanup-pending persistence", new Error("git removal failed early")],
])("startup retains and retries a workspace obligation after %s", async (_name, failure) => {
  const agentId = "agent-restart-workspace-failure";
  const records = new Map<string, StoredAgentRecord>([
    [
      agentId,
      {
        id: agentId,
        autoArchiveObligation: {
          phase: "armed",
          target: { kind: "workspace", workspaceId: "ws-restart" },
        },
      } as StoredAgentRecord,
    ],
  ]);
  const firstArchive = vi.fn(async () => {
    throw failure;
  });
  const firstDispatch = createLifecycleDispatch(new AgentLifecycleEvents(), async () => undefined, {
    records,
    archiveWorkspaceForClose: firstArchive,
  });

  await firstDispatch.recoverPersistedAutoArchives();
  await vi.waitFor(() => expect(firstArchive).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(records.get(agentId)?.autoArchiveObligation).toEqual({
      phase: "pending",
      target: { kind: "workspace", workspaceId: "ws-restart" },
    }),
  );

  const retryArchive = vi.fn(async () => undefined);
  const restartedDispatch = createLifecycleDispatch(
    new AgentLifecycleEvents(),
    async () => undefined,
    { records, archiveWorkspaceForClose: retryArchive },
  );
  await restartedDispatch.recoverPersistedAutoArchives();
  await vi.waitFor(() =>
    expect(retryArchive).toHaveBeenCalledWith("ws-restart", expect.any(AbortSignal)),
  );
  await vi.waitFor(() => expect(records.get(agentId)?.autoArchiveObligation).toBeUndefined());
});
