import { i18n } from "@/i18n/i18next";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
  SidebarWorkspacePlacementModel,
} from "@/hooks/sidebar-workspaces-view-model";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceAgentVisibility } from "@/workspace-tabs/agent-visibility";
import type { CreationAttempt } from "../model";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";

export function workspaceCreationPresentation(
  workspace: WorkspaceDescriptor | null,
  attempt: CreationAttempt | null,
) {
  const workspacePending = attempt !== null && !attempt.workspaceObserved;
  return {
    workspacePending,
    exists: workspace !== null || attempt !== null,
    projectName: attempt?.projectName,
    canInspectRecovery: !workspacePending,
  };
}

export function includeCreatingAgent(
  visibility: WorkspaceAgentVisibility,
  attempt: CreationAttempt | null,
): WorkspaceAgentVisibility {
  if (!attempt) return visibility;
  if (attempt.phase === "complete" && attempt.agentObserved) return visibility;
  return {
    activeAgentIds: new Set([...visibility.activeAgentIds, attempt.agentId]),
    autoOpenAgentIds: new Set([...visibility.autoOpenAgentIds, attempt.agentId]),
  };
}

/** The agent as submitted, until the host publishes it. Its destination cwd is not known yet. */
export function pendingCreationAgent(attempt: CreationAttempt): AgentScreenAgent {
  return {
    serverId: attempt.serverId,
    id: attempt.agentId,
    provider: attempt.provider,
    status: "running",
    cwd: "",
    workspaceId: attempt.workspaceId,
    currentModeId: attempt.config.modeId ?? null,
    model: attempt.config.model ?? null,
    thinkingOptionId: attempt.config.thinkingOptionId ?? null,
    projectPlacement: null,
  };
}

export function addCreatingSidebarWorkspaces(
  model: SidebarWorkspacePlacementModel,
  attempts: readonly CreationAttempt[],
  translate = i18n.t,
): SidebarWorkspacePlacementModel {
  const pending = attempts.filter((attempt) => !attempt.workspaceObserved);
  if (!pending.length) return model;
  const projects = model.projects.map((project) => {
    const creations = pending.filter((attempt) =>
      project.hosts.some(
        (host) => host.serverId === attempt.serverId && host.projectId === attempt.projectId,
      ),
    );
    if (!creations.length) return project;
    const workspaces = [...project.workspaces];
    for (const attempt of creations) {
      if (
        workspaces.some(
          (workspace) =>
            workspace.serverId === attempt.serverId &&
            workspace.workspaceId === attempt.workspaceId,
        )
      )
        continue;
      workspaces.push({
        workspaceKey: `${attempt.serverId}:${attempt.workspaceId}`,
        serverId: attempt.serverId,
        workspaceId: attempt.workspaceId,
        projectViewKey: project.viewKey,
        projectName: project.projectName,
        projectKind: project.projectKind,
        workspaceKind: "checkout",
        name: translate("newWorkspace.creation.creatingWorkspace"),
      });
    }
    return { ...project, workspaces };
  });
  return { ...model, projects, workspaces: projects.flatMap((project) => project.workspaces) };
}
export function creatingSidebarEntry(
  placement: SidebarWorkspacePlacement,
  translate = i18n.t,
): SidebarWorkspaceEntry {
  return {
    ...placement,
    name: translate("newWorkspace.creation.creatingWorkspace"),
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    statusBucket: "running",
    statusEnteredAt: null,
  };
}
