import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { deriveWorkspaceAgentVisibility } from "@/workspace-tabs/agent-visibility";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";
import { applyLegacyDaemonWorkspaceOwnership } from "./legacy-daemon-workspaces";

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

describe("applyLegacyDaemonWorkspaceOwnership", () => {
  it("keeps old-daemon agent updates attached to the path-backed workspace", () => {
    const snapshot = buildAgentDirectoryState({
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
    const cachedAgent = getSnapshotAgent(snapshot, "agent-running");
    snapshot.agents.set(cachedAgent.id, { ...cachedAgent, workspaceId: "/repo/app" });
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
});
