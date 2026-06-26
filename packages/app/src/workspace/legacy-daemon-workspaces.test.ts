import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { deriveWorkspaceAgentVisibility } from "@/workspace-tabs/agent-visibility";
import {
  applyLegacyDaemonWorkspaceOwnership,
  backfillLegacyDaemonWorkspaceDirectoryIfEmpty,
  buildLegacyDaemonWorkspaceSnapshot,
} from "./legacy-daemon-workspaces";

const SERVER_ID = "srv_legacy";

function legacyAgent(input: {
  id: string;
  cwd: string;
  status?: FetchAgentsEntry["agent"]["status"];
  updatedAt?: string;
}): FetchAgentsEntry {
  const updatedAt = input.updatedAt ?? "2026-06-18T10:00:00.000Z";
  return {
    agent: {
      id: input.id,
      provider: "mock",
      cwd: input.cwd,
      model: null,
      createdAt: updatedAt,
      updatedAt,
      lastUserMessageAt: null,
      status: input.status ?? "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    },
    project: {
      projectKey: "/repo",
      projectName: "repo",
      workspaceName: "app",
      checkout: {
        cwd: input.cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "git@example.com:repo/app.git",
        worktreeRoot: input.cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/repo",
      },
    },
  };
}

function getSnapshotAgent(snapshot: { agents: Map<string, Agent> }, agentId: string): Agent {
  const agent = snapshot.agents.get(agentId);
  if (!agent) {
    throw new Error(`test agent missing: ${agentId}`);
  }
  return agent;
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("buildLegacyDaemonWorkspaceSnapshot", () => {
  it("creates path-backed workspace rows and stamps legacy agents with their workspace id", () => {
    const snapshot = buildLegacyDaemonWorkspaceSnapshot({
      serverId: SERVER_ID,
      entries: [
        legacyAgent({ id: "agent-running", cwd: "/repo/app", status: "running" }),
        legacyAgent({ id: "agent-idle", cwd: "/repo/app", status: "idle" }),
      ],
    });

    expect(Array.from(snapshot.workspaces.values())).toEqual([
      expect.objectContaining({
        id: "/repo/app",
        projectId: "/repo",
        projectDisplayName: "repo",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo/app",
        projectKind: "git",
        workspaceKind: "checkout",
        name: "app",
        status: "running",
        scripts: [],
      }),
    ]);
    expect(
      Array.from(snapshot.agents.values()).map((agent) => ({
        id: agent.id,
        serverId: agent.serverId,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
      })),
    ).toEqual([
      {
        id: "agent-running",
        serverId: SERVER_ID,
        cwd: "/repo/app",
        workspaceId: "/repo/app",
      },
      {
        id: "agent-idle",
        serverId: SERVER_ID,
        cwd: "/repo/app",
        workspaceId: "/repo/app",
      },
    ]);
  });

  it("keeps old-daemon agent updates attached to the path-backed workspace", () => {
    const snapshot = buildLegacyDaemonWorkspaceSnapshot({
      serverId: SERVER_ID,
      entries: [legacyAgent({ id: "agent-running", cwd: "/repo/app", status: "running" })],
    });
    const store = useSessionStore.getState();
    store.initializeSession(SERVER_ID, null as unknown as DaemonClient);
    store.updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: "0.1.96",
    });
    store.setWorkspaces(SERVER_ID, snapshot.workspaces);
    store.setAgents(SERVER_ID, snapshot.agents);

    const existingAgent = getSnapshotAgent(snapshot, "agent-running");
    const oldDaemonUpdate: Agent = {
      ...existingAgent,
      workspaceId: undefined,
      updatedAt: new Date("2026-06-18T10:01:00.000Z"),
      lastActivityAt: new Date("2026-06-18T10:01:00.000Z"),
    };

    const stampedUpdate = applyLegacyDaemonWorkspaceOwnership({
      serverId: SERVER_ID,
      agent: oldDaemonUpdate,
    });
    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([[stampedUpdate.id, stampedUpdate]]),
      workspaceId: "/repo/app",
    });

    expect(stampedUpdate.workspaceId).toBe("/repo/app");
    expect(visibility.activeAgentIds).toEqual(new Set(["agent-running"]));
  });

  it("does not backfill path-backed workspaces after hydration is cancelled", async () => {
    const store = useSessionStore.getState();
    store.initializeSession(SERVER_ID, null as unknown as DaemonClient);
    store.updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: "0.1.96",
    });
    let cancelled = false;
    let didFetchAgents = false;
    const client: Pick<DaemonClient, "fetchAgents"> = {
      fetchAgents: async () => {
        didFetchAgents = true;
        cancelled = true;
        return {
          requestId: "req_cancelled_backfill",
          subscriptionId: null,
          entries: [legacyAgent({ id: "agent-cancelled", cwd: "/repo/app" })],
          pageInfo: {
            nextCursor: null,
            prevCursor: null,
            hasMore: false,
          },
        };
      },
    };

    const didBackfill = await backfillLegacyDaemonWorkspaceDirectoryIfEmpty({
      client,
      serverId: SERVER_ID,
      workspaces: new Map(),
      emptyProjects: new Map(),
      isCancelled: () => cancelled,
    });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(didFetchAgents).toBe(true);
    expect(didBackfill).toBe(true);
    expect(session?.agents.size).toBe(0);
    expect(session?.workspaces.size).toBe(0);
    expect(session?.hasHydratedWorkspaces).toBe(false);
  });
});
