import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { KanbanTask } from "@/types/kanban";

export interface ResolvedTaskProject {
  projectId: string;
  projectName: string;
}

export function resolveTaskProject(
  task: KanbanTask,
  input: {
    serverId: string;
    workspaces: Iterable<WorkspaceDescriptor>;
  },
): ResolvedTaskProject | null {
  // If the task is explicitly tagged to a DIFFERENT server, skip it.
  // We only skip when serverId is set AND doesn't match — unset means "any server".
  const serverMismatch = Boolean(task.serverId?.trim()) && task.serverId !== input.serverId;

  // When projectId is explicitly stamped on the task, trust it directly.
  // Don't block on serverId here: the projectId is the authoritative link.
  // Server-scoping only matters for workspace-path-based resolution below.
  if (task.projectId?.trim() && !serverMismatch) {
    return {
      projectId: task.projectId.trim(),
      projectName: task.projectName?.trim() || task.projectId.trim(),
    };
  }

  // Workspace-path-based resolution: requires a matching server.
  if (serverMismatch || !task.path?.trim()) {
    return null;
  }

  for (const workspace of input.workspaces) {
    if (workspace.id !== task.path.trim()) {
      continue;
    }
    return {
      projectId: workspace.projectId,
      projectName: workspace.projectDisplayName,
    };
  }

  return null;
}

export function taskBelongsToProject(
  task: KanbanTask,
  input: {
    serverId: string;
    projectId: string;
    workspaces: Iterable<WorkspaceDescriptor>;
  },
): boolean {
  const resolved = resolveTaskProject(task, {
    serverId: input.serverId,
    workspaces: input.workspaces,
  });
  return resolved?.projectId === input.projectId;
}
