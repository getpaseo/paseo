import type { DaemonClient } from "@server/client/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveWorkspaceAgentVisibility,
  type WorkspaceAgentVisibility,
} from "@/screens/workspace/workspace-agent-visibility";
import { buildWorkspaceTabPersistenceKey, useWorkspaceLayoutStore } from "./workspace-layout-store";
import { selectSubagentsForParent } from "@/subagents/subagents";
import { useSessionStore, type Agent } from "./session-store";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";
const WORKSPACE_DIRECTORY = "/repo/worktree";

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  const timestamp = new Date("2026-04-21T10:00:00.000Z");
  return {
    serverId: input.serverId ?? SERVER_ID,
    id: input.id,
    provider: input.provider ?? "codex",
    status: input.status ?? "idle",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    lastActivityAt: input.lastActivityAt ?? timestamp,
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    runtimeInfo: input.runtimeInfo,
    lastUsage: input.lastUsage,
    lastError: input.lastError ?? null,
    title: input.title ?? "Agent",
    cwd: input.cwd ?? WORKSPACE_DIRECTORY,
    model: input.model ?? null,
    features: input.features,
    thinkingOptionId: input.thinkingOptionId,
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: input.attentionTimestamp ?? null,
    archivedAt: input.archivedAt ?? null,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.labels ?? {},
    projectPlacement: input.projectPlacement ?? null,
  };
}

function initializeAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

function appendAgent(agent: Agent): void {
  useSessionStore.getState().setAgents(SERVER_ID, (agents) => {
    const nextAgents = new Map(agents);
    nextAgents.set(agent.id, agent);
    return nextAgents;
  });
}

function deriveVisibilityFromSession(): WorkspaceAgentVisibility {
  const sessionAgents = useSessionStore.getState().sessions[SERVER_ID]?.agents ?? new Map();
  return deriveWorkspaceAgentVisibility({
    sessionAgents,
    workspaceDirectory: WORKSPACE_DIRECTORY,
  });
}

function reconcileWorkspaceTabs(workspaceKey: string, visibility: WorkspaceAgentVisibility): void {
  useWorkspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: visibility.activeAgentIds,
    autoOpenAgentIds: visibility.autoOpenAgentIds,
    knownAgentIds: visibility.knownAgentIds,
    standaloneTerminalIds: [],
    hasActivePendingDraftCreate: false,
  });
}

function getWorkspaceTabIds(workspaceKey: string): string[] {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(workspaceKey)
    .map((tab) => tab.tabId);
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    splitSizesByWorkspace: {},
    pinnedAgentIdsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
  });
});

describe("workspace subagents integration", () => {
  it("keeps a child ingested before its parent out of auto-tabs, then exposes it in the parent section", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const child = makeAgent({
      id: "child-agent",
      parentAgentId: "parent-agent",
      title: "Child agent",
    });
    const parent = makeAgent({
      id: "parent-agent",
      title: "Parent agent",
    });

    initializeAgents([child]);

    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual([]);

    appendAgent(parent);

    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["agent_parent-agent"]);
    expect(
      selectSubagentsForParent(useSessionStore.getState(), {
        serverId: SERVER_ID,
        parentAgentId: "parent-agent",
      }).map((row) => row.id),
    ).toEqual(["child-agent"]);
  });
});
