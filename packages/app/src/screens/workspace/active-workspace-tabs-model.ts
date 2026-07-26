import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

export type ActiveSessionStatus = "needs_input" | "failed" | "running";

export interface ActiveWorkspaceSessionTab {
  agentId: string;
  label: string;
  status: ActiveSessionStatus;
  lastActivityAt: Date;
}

export interface ActiveWorkspaceTab {
  key: string;
  serverId: string;
  workspaceId: string;
  projectKey: string;
  projectRootPath: string;
  projectLabel: string;
  workspaceLabel: string;
  status: ActiveSessionStatus;
  sessions: ActiveWorkspaceSessionTab[];
  needsInputCount: number;
}

interface ActiveWorkspaceSessionState {
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
  agents: ReadonlyMap<string, Agent>;
}

interface ActiveWorkspaceTabsState {
  sessions: Record<string, ActiveWorkspaceSessionState | undefined>;
}

const STATUS_PRIORITY: Record<ActiveSessionStatus, number> = {
  needs_input: 0,
  failed: 1,
  running: 2,
};

function deriveActiveSessionStatus(agent: Agent): ActiveSessionStatus | null {
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
    return "needs_input";
  }
  if (agent.status === "error" || agent.attentionReason === "error") {
    return "failed";
  }
  if (agent.status === "running" || agent.status === "initializing") {
    return "running";
  }
  return null;
}

function compareSessions(
  left: ActiveWorkspaceSessionTab,
  right: ActiveWorkspaceSessionTab,
): number {
  const statusDifference = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
  if (statusDifference !== 0) {
    return statusDifference;
  }
  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function workspaceProjectLabel(workspace: WorkspaceDescriptor): string {
  return workspace.projectCustomName?.trim() || workspace.projectDisplayName;
}

function workspaceLabel(workspace: WorkspaceDescriptor): string {
  return workspace.title?.trim() || workspace.name;
}

export function selectActiveWorkspaceTabs(state: ActiveWorkspaceTabsState): ActiveWorkspaceTab[] {
  const tabs: ActiveWorkspaceTab[] = [];

  for (const [serverId, session] of Object.entries(state.sessions)) {
    if (!session) {
      continue;
    }

    const sessionsByWorkspaceId = new Map<string, ActiveWorkspaceSessionTab[]>();
    for (const agent of session.agents.values()) {
      if (agent.archivedAt || !agent.workspaceId) {
        continue;
      }
      const status = deriveActiveSessionStatus(agent);
      if (!status) {
        continue;
      }
      const sessions = sessionsByWorkspaceId.get(agent.workspaceId) ?? [];
      sessions.push({
        agentId: agent.id,
        label: agent.title?.trim() || agent.id.slice(0, 7),
        status,
        lastActivityAt: agent.lastActivityAt,
      });
      sessionsByWorkspaceId.set(agent.workspaceId, sessions);
    }

    for (const workspace of session.workspaces.values()) {
      const sessions = sessionsByWorkspaceId.get(workspace.id);
      if (!sessions || sessions.length === 0) {
        continue;
      }
      sessions.sort(compareSessions);
      tabs.push({
        key: `${serverId}:${workspace.id}`,
        serverId,
        workspaceId: workspace.id,
        projectKey: workspace.project?.projectKey ?? workspace.projectId,
        projectRootPath: workspace.projectRootPath,
        projectLabel: workspaceProjectLabel(workspace),
        workspaceLabel: workspaceLabel(workspace),
        status: sessions[0]?.status ?? "running",
        sessions,
        needsInputCount: sessions.filter((agent) => agent.status === "needs_input").length,
      });
    }
  }

  return tabs.sort((left, right) => {
    const projectDifference = left.projectLabel.localeCompare(right.projectLabel);
    if (projectDifference !== 0) {
      return projectDifference;
    }
    return left.workspaceLabel.localeCompare(right.workspaceLabel);
  });
}
