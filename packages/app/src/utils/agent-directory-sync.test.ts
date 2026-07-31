import { describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { isAgentArchiving, setAgentArchiving } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import { applyAgentDirectoryDelta, replaceFetchedAgentDirectory } from "./agent-directory-sync";

function createAgentPayload(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    id: string;
    labels?: Record<string, string>;
  },
): AgentSnapshotPayload {
  return {
    id: input.id,
    provider: input.provider ?? "codex",
    cwd: input.cwd ?? "/repo",
    model: input.model ?? null,
    createdAt: input.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-20T00:01:00.000Z",
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    status: input.status ?? "idle",
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
    title: input.title ?? null,
    labels: input.labels ?? {},
  };
}

function createEntry(agent: AgentSnapshotPayload): FetchAgentsEntry {
  return {
    agent,
    project: {
      projectKey: agent.cwd,
      projectName: "repo",
      checkout: {
        cwd: agent.cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function permission(id: string): AgentPermissionRequest {
  return { id, provider: "codex", name: id, kind: "tool", title: id };
}

describe("replaceFetchedAgentDirectory", () => {
  it("preserves timeline initialization while replacing directory state", () => {
    const serverId = "server-initializing";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    store.setInitializingAgents(serverId, new Map([["agent", true]]));

    replaceFetchedAgentDirectory({
      serverId,
      entries: [createEntry(createAgentPayload({ id: "agent" }))],
    });

    expect(useSessionStore.getState().sessions[serverId]?.initializingAgents.get("agent")).toBe(
      true,
    );
    store.clearSession(serverId);
  });

  it("re-derives parentAgentId every time an agent snapshot is ingested", () => {
    const serverId = "server-1";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);

    replaceFetchedAgentDirectory({
      serverId,
      entries: [
        createEntry(
          createAgentPayload({
            id: "child-1",
            labels: { [PARENT_AGENT_ID_LABEL]: "parent-a" },
          }),
        ),
      ],
    });

    replaceFetchedAgentDirectory({
      serverId,
      entries: [
        createEntry(
          createAgentPayload({
            id: "child-1",
            labels: { [PARENT_AGENT_ID_LABEL]: "parent-b" },
          }),
        ),
      ],
    });

    expect(
      useSessionStore.getState().sessions[serverId]?.agents.get("child-1")?.parentAgentId,
    ).toBe("parent-b");

    store.clearSession(serverId);
  });

  it("removes every replica-owned artifact for a removed agent", () => {
    const serverId = "server-removal";
    const agentId = "removed-agent";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const agent = {
      ...normalizeAgentSnapshot(createAgentPayload({ id: agentId }), serverId),
      projectPlacement: null,
    };
    store.setAgents(serverId, new Map([[agentId, agent]]));
    store.setAgentDetails(serverId, new Map([[agentId, agent]]));
    store.setQueuedMessages(
      serverId,
      new Map([[agentId, [{ id: "queued", text: "next", attachments: [] }]]]),
    );
    store.setAgentTimelineCursor(
      serverId,
      new Map([[agentId, { epoch: "epoch", startSeq: 1, endSeq: 2 }]]),
    );
    store.setPendingPermissions(
      serverId,
      new Map([["permission", { key: "permission", agentId, request: null as never }]]),
    );
    store.setInitializingAgents(serverId, new Map([[agentId, true]]));
    setAgentArchiving({ queryClient, serverId, agentId, isArchiving: true });

    applyAgentDirectoryDelta({ serverId, delta: { kind: "remove", agentId } });

    const session = useSessionStore.getState().sessions[serverId];
    expect({
      agents: session?.agents.has(agentId),
      details: session?.agentDetails.has(agentId),
      queued: session?.queuedMessages.has(agentId),
      cursor: session?.agentTimelineCursor.has(agentId),
      permissions: session?.pendingPermissions.size,
      initializing: session?.initializingAgents.has(agentId),
      archivePending: isAgentArchiving({ queryClient, serverId, agentId }),
    }).toEqual({
      agents: false,
      details: false,
      queued: false,
      cursor: false,
      permissions: 0,
      initializing: false,
      archivePending: false,
    });

    store.clearSession(serverId);
  });

  it("keeps newer metadata while accepting usage-only updates and legacy workspace ownership", () => {
    const serverId = "server-usage";
    const agentId = "usage-agent";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    store.setWorkspaces(
      serverId,
      new Map([
        [
          "legacy-workspace",
          {
            id: "legacy-workspace",
            projectId: "project",
            projectDisplayName: "Project",
            projectRootPath: "/repo",
            workspaceDirectory: "/repo",
            projectKind: "git",
            workspaceKind: "worktree",
            name: "repo",
            status: "done",
            statusEnteredAt: null,
            archivingAt: null,
            diffStat: null,
            scripts: [],
          },
        ],
      ]),
    );
    const current = createAgentPayload({
      id: agentId,
      title: "current",
      status: "running",
      updatedAt: "2026-07-12T11:00:00.000Z",
      lastUsage: { inputTokens: 10, outputTokens: 5 },
      pendingPermissions: [permission("current-permission")],
    });
    applyAgentDirectoryDelta({
      serverId,
      delta: { kind: "upsert", agent: current, project: createEntry(current).project },
    });
    store.flushAgentLastActivity();
    setAgentArchiving({ queryClient, serverId, agentId, isArchiving: true });

    const staleResult = applyAgentDirectoryDelta({
      serverId,
      delta: {
        kind: "upsert",
        agent: {
          ...current,
          title: "stale",
          status: "idle",
          updatedAt: "2026-07-12T10:00:00.000Z",
          lastUsage: { inputTokens: 20, outputTokens: 8 },
          pendingPermissions: [permission("stale-permission")],
          archivedAt: "2026-07-12T10:00:00.000Z",
        },
        project: createEntry(current).project,
      },
    });
    store.flushAgentLastActivity();

    const state = useSessionStore.getState();
    const agent = state.sessions[serverId]?.agents.get(agentId);
    expect({
      title: agent?.title,
      status: agent?.status,
      usage: agent?.lastUsage,
      workspaceId: agent?.workspaceId,
      stoppedRunning: staleResult.stoppedRunning,
      permissions: Array.from(state.sessions[serverId]?.pendingPermissions.values() ?? []).map(
        ({ request }) => request.id,
      ),
      archivePending: isAgentArchiving({ queryClient, serverId, agentId }),
      activity: state.agentLastActivity.get(agentId)?.toISOString(),
    }).toEqual({
      title: "current",
      status: "running",
      usage: { inputTokens: 20, outputTokens: 8 },
      workspaceId: "legacy-workspace",
      stoppedRunning: false,
      permissions: ["current-permission"],
      archivePending: true,
      activity: "2026-07-12T11:00:00.000Z",
    });

    store.clearSession(serverId);
  });
});
