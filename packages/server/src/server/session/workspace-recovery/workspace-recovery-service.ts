import {
  resolveWorkspaceDisplayName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";

export type WorkspaceRecoveryAction = "unarchive" | "restore";

export type WorkspaceRecoveryState =
  | {
      kind: "recoverable";
      workspaceId: string;
      workspaceName: string;
      action: WorkspaceRecoveryAction;
      branch: string | null;
    }
  | {
      kind: "unavailable";
      workspaceId: string;
      reason:
        | "workspace_not_found"
        | "workspace_not_archived"
        | "project_not_found"
        | "project_directory_missing"
        | "workspace_directory_missing"
        | "worktree_branch_missing";
      message: string;
    };

export interface WorkspaceRecoveryService {
  inspect(workspaceId: string): Promise<WorkspaceRecoveryState>;
  restore(workspaceId: string): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }>;
}

export function createWorkspaceRecoveryService(deps: {
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProject: (projectId: string) => Promise<PersistedProjectRecord | null>;
  isDirectory: (path: string) => Promise<boolean>;
  recreateWorktree: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  unarchiveWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
}): WorkspaceRecoveryService {
  async function inspect(workspaceId: string): Promise<WorkspaceRecoveryState> {
    const workspace = await deps.getWorkspace(workspaceId);
    if (!workspace) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_not_found",
        message: "This workspace is no longer known to the host.",
      };
    }
    if (!workspace.archivedAt) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_not_archived",
        message: "This workspace is not archived, but it is unavailable from the host.",
      };
    }

    const project = await deps.getProject(workspace.projectId);
    if (!project) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_not_found",
        message: "The project for this archived workspace no longer exists.",
      };
    }

    if (await deps.isDirectory(workspace.cwd)) {
      return {
        kind: "recoverable",
        workspaceId,
        workspaceName: resolveWorkspaceDisplayName(workspace),
        action: "unarchive",
        branch: workspace.branch,
      };
    }

    if (workspace.kind !== "worktree") {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_directory_missing",
        message: "The archived workspace directory no longer exists and cannot be recreated.",
      };
    }
    if (!workspace.branch) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "worktree_branch_missing",
        message: "The archived worktree has no branch recorded, so it cannot be restored.",
      };
    }
    if (!(await deps.isDirectory(project.rootPath))) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_directory_missing",
        message: "The project directory needed to restore this worktree no longer exists.",
      };
    }

    return {
      kind: "recoverable",
      workspaceId,
      workspaceName: resolveWorkspaceDisplayName(workspace),
      action: "restore",
      branch: workspace.branch,
    };
  }

  async function restore(
    workspaceId: string,
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const state = await inspect(workspaceId);
    if (state.kind === "unavailable") {
      throw new Error(state.message);
    }

    const workspace = await deps.getWorkspace(workspaceId);
    if (!workspace?.archivedAt) {
      throw new Error("The archived workspace changed before it could be recovered.");
    }
    if (state.action === "restore") {
      await deps.recreateWorktree(workspace);
    }
    await deps.unarchiveWorkspace(workspace);
    return { workspaceId, action: state.action };
  }

  return { inspect, restore };
}
