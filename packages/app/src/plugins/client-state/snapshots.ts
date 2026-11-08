import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { i18n } from "@/i18n/i18next";
import type {
  PluginAgentSnapshot,
  PluginWorkspaceSnapshot,
  PluginProjectSnapshot,
} from "@getpaseo/plugin";
import type { Agent, WorkspaceDescriptor, ProjectDescriptor } from "@/stores/session-store";

import { entityRefs } from "./refs";
import { deriveEffectiveWorkspaceStatus } from "@/workspace-status";

interface CachedWorkspace {
  language: string;
  snapshot: PluginWorkspaceSnapshot;
}
const workspaceSnapshots = new WeakMap<WorkspaceDescriptor, Map<string, CachedWorkspace>>();
const agentSnapshots = new WeakMap<Agent, Map<string, PluginAgentSnapshot>>();

export function createPluginWorkspaceSnapshot(
  workspace: WorkspaceDescriptor,
  hostId: string,
  context: Omit<Parameters<typeof deriveEffectiveWorkspaceStatus>[0], "workspace" | "serverId"> & {
    parentAgent?: PluginWorkspaceSnapshot["parentAgent"];
  } = {},
): PluginWorkspaceSnapshot {
  const indicator = deriveEffectiveWorkspaceStatus({
    ...context,
    workspace,
    serverId: hostId,
  }).status;
  const parentAgent = context.parentAgent ?? null;
  const cached = workspaceSnapshots.get(workspace)?.get(hostId);
  if (
    cached &&
    cached.language === i18n.language &&
    cached.snapshot.indicator === indicator &&
    cached.snapshot.parentAgent === parentAgent
  )
    return cached.snapshot;
  const diffStat = workspace.diffStat ? Object.freeze({ ...workspace.diffStat }) : null;
  const snapshot = Object.freeze({
    ref: entityRefs.workspace(hostId, workspace.id),
    hostId,
    project: entityRefs.project(hostId, workspace.projectId),
    pinnedAt: workspace.pinnedAt ?? null,
    labels: Object.freeze([...(workspace.labels ?? [])]),
    background: workspace.background ?? false,
    branch: workspace.gitRuntime?.currentBranch ?? null,
    createdAt: serializeTimestamp(workspace.createdAt),
    lastPromptAt: serializeTimestamp(workspace.lastUserMessageAt),
    parentAgent,
    indicator,
    indicatorLabel: i18n.t(indicatorLabelKeys[indicator]),
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
    statusEnteredAt: serializeTimestamp(workspace.statusEnteredAt),
    archivingAt: workspace.archivingAt,
    diffStat,
  });
  const byHost = workspaceSnapshots.get(workspace) ?? new Map<string, CachedWorkspace>();
  byHost.set(hostId, { language: i18n.language, snapshot });
  workspaceSnapshots.set(workspace, byHost);
  return snapshot;
}

export function createPluginAgentSnapshot(agent: Agent, workspaceId: string): PluginAgentSnapshot {
  const cached = agentSnapshots.get(agent)?.get(workspaceId);
  if (cached) return cached;
  const parent = getParentAddressFromLabels(agent.labels, agent.serverId);
  const snapshot = Object.freeze({
    ref: entityRefs.agent(agent.serverId, agent.id),
    hostId: agent.serverId,
    workspace: entityRefs.workspace(agent.serverId, workspaceId),
    parentAgent: parent ? entityRefs.agent(parent.serverId, parent.agentId) : null,
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

const indicatorLabelKeys = {
  needs_input: "sidebar.statusBucket.needsInput",
  failed: "sidebar.statusBucket.failed",
  running: "sidebar.statusBucket.working",
  attention: "sidebar.statusBucket.readyToReview",
  done: "sidebar.statusBucket.done",
} as const;
const projectSnapshots = new WeakMap<ProjectDescriptor, Map<string, PluginProjectSnapshot>>();

export function createPluginProjectSnapshot(
  project: ProjectDescriptor,
  hostId: string,
): PluginProjectSnapshot {
  const cached = projectSnapshots.get(project)?.get(hostId);
  if (cached) return cached;
  const snapshot = Object.freeze({
    ref: entityRefs.project(hostId, project.projectId),
    hostId,
    displayName: project.projectCustomName ?? project.projectDisplayName,
    rootPath: project.projectRootPath,
    kind: project.projectKind,
    iconRevision: project.projectCustomIconRevision ?? project.projectIconRevision ?? null,
  });
  const byHost = projectSnapshots.get(project) ?? new Map<string, PluginProjectSnapshot>();
  byHost.set(hostId, snapshot);
  projectSnapshots.set(project, byHost);
  return snapshot;
}

function serializeTimestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
