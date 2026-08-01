import { expect, test, vi } from "vitest";

import type { AgentManagerEvent, AgentSubscriber } from "./agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  CreateAgentLifecycleDispatch,
  registerAgentAutoArchive,
} from "./create-agent-lifecycle-dispatch.js";
import { requireArchiveCleanupComplete } from "../workspace-archive-service.js";

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

test("auto-archive retries when physical workspace cleanup remains pending", async () => {
  const agentId = "agent-auto-archive-cleanup-pending";
  const agents = new AgentLifecycleEvents();
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
    retryBaseMs: 0,
    retryMaxMs: 0,
  });

  agents.completeTurn(agentId);
  await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
  await registration.cancel();
  expect(archive).toHaveBeenCalledTimes(2);
  expect(agents.listenerCount()).toBe(0);
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
