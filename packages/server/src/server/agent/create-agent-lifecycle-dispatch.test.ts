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
): CreateAgentLifecycleDispatch {
  const dependencies = {
    paseoHome: "/tmp/paseo",
    agentManager: agents,
    agentStorage: {},
    github: {},
    workspaceGitService: {},
    archiveAgentForClose,
    findWorkspaceIdForCwd: async () => null,
    listActiveWorkspaces: async () => [],
    archiveWorkspaceRecord: async () => undefined,
    workspaceRegistry: {},
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
  const dependencies = {
    agentManager: agents,
    archiveAgentForClose,
    workspaceRegistry: {},
    logger: createTestLogger(),
  } as unknown as ConstructorParameters<typeof CreateAgentLifecycleDispatch>[0];
  const dispatch = new CreateAgentLifecycleDispatch(dependencies);
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
