import { describe, expect, it, vi } from "vitest";
import { WorkspaceAutoTitleUpdateScheduler } from "./workspace-auto-title-scheduler.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import type { WorkspaceRegistry, PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { createTestLogger } from "../test-utils/test-logger.js";

function createMockWorkspaceRegistry(records: PersistedWorkspaceRecord[]): WorkspaceRegistry {
  const map = new Map(records.map((r) => [r.workspaceId, r]));
  return {
    get: async (workspaceId: string) => map.get(workspaceId) ?? null,
    upsert: async (record: PersistedWorkspaceRecord) => {
      map.set(record.workspaceId, record);
    },
  } as unknown as WorkspaceRegistry;
}

function createMockWorkspaceGitService(): Pick<WorkspaceGitService, "resolveRepoRoot"> {
  return {
    resolveRepoRoot: async () => null,
  };
}

function baseRecord(workspaceId: string): PersistedWorkspaceRecord {
  return {
    workspaceId,
    projectId: "proj-1",
    cwd: "/repo",
    kind: "local_checkout",
    displayName: "main",
    title: null,
    branch: null,
    baseBranch: null,
    autoUpdateTitle: true,
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    archivedAt: null,
  };
}

interface AgentManagerEvent {
  type: "agent_stream";
  agentId: string;
  event: AgentStreamEvent;
}

function createMockAgentManagerWithSubscribe(input: {
  agents?: Array<{
    id: string;
    workspaceId: string;
    cwd: string;
    internal?: boolean;
    title?: string;
  }>;
}): AgentManager {
  const agents =
    input.agents?.map((a) => ({
      id: a.id,
      workspaceId: a.workspaceId,
      cwd: a.cwd,
      internal: a.internal ?? false,
      title: a.title ?? a.id,
      config: {
        provider: "claude" as const,
        cwd: a.cwd,
        title: a.title ?? a.id,
      },
      updatedAt: new Date(),
    })) ?? [];
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  return {
    listAgents: () => agents,
    getAgent: (agentId: string) => agents.find((a) => a.id === agentId) ?? null,
    subscribe: (callback: (event: AgentManagerEvent) => void) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    emit: (event: AgentManagerEvent) => {
      for (const subscriber of subscribers) {
        subscriber(event);
      }
    },
  } as unknown as AgentManager;
}

describe("WorkspaceAutoTitleUpdateScheduler", () => {
  it("ignores non-turn stream events", async () => {
    const registry = createMockWorkspaceRegistry([baseRecord("ws-1")]);
    const agentManager = createMockAgentManagerWithSubscribe({
      agents: [{ id: "agent-1", workspaceId: "ws-1", cwd: "/repo" }],
    });
    const scheduler = new WorkspaceAutoTitleUpdateScheduler({
      agentManager,
      workspaceRegistry: registry,
      workspaceGitService: createMockWorkspaceGitService(),
      logger: createTestLogger(),
    });

    agentManager.emit({
      agentId: "agent-1",
      type: "agent_stream",
      event: {
        type: "message",
        item: { type: "user_message", text: "hello" },
      } as AgentStreamEvent,
    });

    scheduler.destroy();
    // No async work scheduled; registry unchanged.
    await expect(registry.get("ws-1")).resolves.toEqual(baseRecord("ws-1"));
  });

  it("does not update when autoUpdateTitle is disabled", async () => {
    vi.useFakeTimers();
    const record = { ...baseRecord("ws-1"), autoUpdateTitle: false };
    const registry = createMockWorkspaceRegistry([record]);
    const onTitleGenerated = vi.fn();
    const agentManager = createMockAgentManagerWithSubscribe({
      agents: [{ id: "agent-1", workspaceId: "ws-1", cwd: "/repo" }],
    });
    const scheduler = new WorkspaceAutoTitleUpdateScheduler({
      agentManager,
      workspaceRegistry: registry,
      workspaceGitService: createMockWorkspaceGitService(),
      logger: createTestLogger(),
      onTitleGenerated,
    });

    agentManager.emit({
      agentId: "agent-1",
      type: "agent_stream",
      event: { type: "turn_completed" } as AgentStreamEvent,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    scheduler.destroy();
    vi.useRealTimers();

    expect(onTitleGenerated).not.toHaveBeenCalled();
    const current = await registry.get("ws-1");
    expect(current?.title).toBeNull();
  });

  it("calls onTitleGenerated after a generated title is applied", async () => {
    vi.useFakeTimers();
    const registry = createMockWorkspaceRegistry([baseRecord("ws-1")]);
    const onTitleGenerated = vi.fn();
    const agentManager = createMockAgentManagerWithSubscribe({
      agents: [{ id: "agent-1", workspaceId: "ws-1", cwd: "/repo" }],
    });
    const scheduler = new WorkspaceAutoTitleUpdateScheduler({
      agentManager,
      workspaceRegistry: registry,
      workspaceGitService: createMockWorkspaceGitService(),
      logger: createTestLogger(),
      onTitleGenerated,
      deps: {
        generateWorkspaceTitleFromActivity: async () => "Generated title",
      },
    });

    agentManager.emit({
      agentId: "agent-1",
      type: "agent_stream",
      event: { type: "turn_completed" } as AgentStreamEvent,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    scheduler.destroy();
    vi.useRealTimers();

    expect(onTitleGenerated).toHaveBeenCalledTimes(1);
    expect(onTitleGenerated).toHaveBeenCalledWith("ws-1");

    const current = await registry.get("ws-1");
    expect(current?.title).toBe("Generated title");
  });

  it("clears pending timers on destroy", () => {
    vi.useFakeTimers();
    const agentManager = createMockAgentManagerWithSubscribe({
      agents: [{ id: "agent-1", workspaceId: "ws-1", cwd: "/repo" }],
    });
    const scheduler = new WorkspaceAutoTitleUpdateScheduler({
      agentManager,
      workspaceRegistry: createMockWorkspaceRegistry([baseRecord("ws-1")]),
      workspaceGitService: createMockWorkspaceGitService(),
      logger: createTestLogger(),
    });

    agentManager.emit({
      agentId: "agent-1",
      type: "agent_stream",
      event: { type: "turn_completed" } as AgentStreamEvent,
    });
    scheduler.destroy();

    // No pending timers should remain after destroy.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("runs only one update at a time per workspace", async () => {
    vi.useFakeTimers();
    const registry = createMockWorkspaceRegistry([baseRecord("ws-1")]);
    const onTitleGenerated = vi.fn();

    const agentManager = createMockAgentManagerWithSubscribe({
      agents: [{ id: "agent-1", workspaceId: "ws-1", cwd: "/repo" }],
    });
    const scheduler = new WorkspaceAutoTitleUpdateScheduler({
      agentManager,
      workspaceRegistry: registry,
      workspaceGitService: createMockWorkspaceGitService(),
      logger: createTestLogger(),
      onTitleGenerated,
    });

    agentManager.emit({
      agentId: "agent-1",
      type: "agent_stream",
      event: { type: "turn_completed" } as AgentStreamEvent,
    });
    agentManager.emit({
      agentId: "agent-1",
      type: "agent_stream",
      event: { type: "turn_completed" } as AgentStreamEvent,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    scheduler.destroy();
    vi.useRealTimers();

    const current = await registry.get("ws-1");
    expect(current).not.toBeNull();
  });
});
