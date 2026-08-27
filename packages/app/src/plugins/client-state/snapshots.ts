import type { PluginAgentSnapshot, PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

const workspaceSnapshots = new WeakMap<WorkspaceDescriptor, PluginWorkspaceSnapshot>();
const agentSnapshots = new WeakMap<Agent, Map<string, PluginAgentSnapshot>>();

export function createPluginWorkspaceSnapshot(
  workspace: WorkspaceDescriptor,
): PluginWorkspaceSnapshot {
  const cached = workspaceSnapshots.get(workspace);
  if (cached) return cached;
  const diffStat = workspace.diffStat ? Object.freeze({ ...workspace.diffStat }) : null;
  const snapshot = Object.freeze({
    id: workspace.id,
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    projectRootPath: workspace.projectRootPath,
    directory: workspace.workspaceDirectory,
    projectKind: workspace.projectKind,
    kind: workspace.workspaceKind,
    name: workspace.name,
    title: workspace.title ?? null,
    status: workspace.status,
    statusEnteredAt: workspace.statusEnteredAt?.toISOString() ?? null,
    archivingAt: workspace.archivingAt,
    diffStat,
  });
  workspaceSnapshots.set(workspace, snapshot);
  return snapshot;
}

export function createPluginAgentSnapshot(agent: Agent, workspaceId: string): PluginAgentSnapshot {
  const cached = agentSnapshots.get(agent)?.get(workspaceId);
  if (cached) return cached;
  const snapshot = Object.freeze({
    id: agent.id,
    workspaceId,
    provider: agent.provider,
    status: agent.status,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastActivityAt: agent.lastActivityAt.toISOString(),
    title: agent.title,
    cwd: agent.cwd,
    model: agent.model,
    currentModeId: agent.currentModeId,
    thinkingOptionId: agent.thinkingOptionId ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    parentAgentId: agent.parentAgentId,
    labels: Object.freeze({ ...agent.labels }),
  });
  const byWorkspace = agentSnapshots.get(agent) ?? new Map<string, PluginAgentSnapshot>();
  byWorkspace.set(workspaceId, snapshot);
  agentSnapshots.set(agent, byWorkspace);
  return snapshot;
}
