import { basename } from "node:path";

import { createRealpathAwarePathMatcher } from "../../../utils/path.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import {
  createWorktree,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  removePaseoWorktreeStrict,
} from "../../../utils/worktree.js";
import {
  fingerprintWorkspaceLifecycleRequest,
  type WorkspaceLifecycleOperationOwner,
} from "../../workspace-lifecycle-operation-service.js";
import { WorktreeRequestError, toWorktreeRequestError } from "../../worktree-errors.js";
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
  restore(
    workspaceId: string,
    options?: { lifecycleOperationId?: string },
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }>;
}

type RecoveryPlan =
  | {
      kind: "unarchive";
      state: Extract<WorkspaceRecoveryState, { kind: "recoverable" }>;
      workspace: PersistedWorkspaceRecord;
    }
  | {
      kind: "restore";
      state: Extract<WorkspaceRecoveryState, { kind: "recoverable" }>;
      workspace: PersistedWorkspaceRecord;
      sourceRepoRoot: string;
    };

type UnavailableRecoveryState = Extract<WorkspaceRecoveryState, { kind: "unavailable" }>;

export function createWorkspaceRecoveryService(deps: {
  paseoHome: string;
  worktreesRoot?: string;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProject: (projectId: string) => Promise<PersistedProjectRecord | null>;
  isDirectory: (path: string) => Promise<boolean>;
  unarchiveWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  // The workspace lifecycle operation owner. When present, worktree
  // re-creation runs as a durable lifecycle operation; when absent the direct
  // path applies (kept for direct-dependency tests). Compensation is strict on
  // both paths — a failed restore never falls through to a recursive delete.
  lifecycle?: WorkspaceLifecycleOperationOwner;
}): WorkspaceRecoveryService {
  async function resolveRecovery(
    workspaceId: string,
  ): Promise<UnavailableRecoveryState | RecoveryPlan> {
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
      return createRecoveryPlan({ action: "unarchive", workspace });
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

    // COMPAT(worktreeRestoreMissingMainRepoRoot): records created before v0.1.110
    // lack placement ownership; remove the project-root fallback after 2027-01-17.
    const sourceRepoRoot = workspace.mainRepoRoot ?? project.rootPath;
    if (!(await deps.isDirectory(sourceRepoRoot))) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_directory_missing",
        message: "The source repository needed to restore this worktree no longer exists.",
      };
    }

    return createRecoveryPlan({ action: "restore", workspace, sourceRepoRoot });
  }

  async function inspect(workspaceId: string): Promise<WorkspaceRecoveryState> {
    const resolved = await resolveRecovery(workspaceId);
    return resolved.kind === "unavailable" ? resolved : resolved.state;
  }

  async function restore(
    workspaceId: string,
    options?: { lifecycleOperationId?: string },
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const resolved = await resolveRecovery(workspaceId);
    if (resolved.kind === "unavailable") {
      throw new Error(resolved.message);
    }

    if (resolved.kind === "restore") {
      await recreateArchivedWorktree(
        resolved.workspace,
        resolved.sourceRepoRoot,
        options?.lifecycleOperationId,
      );
    }
    await deps.unarchiveWorkspace(resolved.workspace);
    return { workspaceId, action: resolved.kind };
  }

  async function recreateArchivedWorktree(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
    lifecycleOperationId: string | undefined,
  ): Promise<void> {
    const branch = workspace.branch;
    if (!branch) {
      throw new WorktreeRequestError({
        code: "unknown",
        message: `Workspace ${workspace.workspaceId} has no branch to restore`,
      });
    }

    try {
      await runGitCommand(["worktree", "prune"], { cwd: sourceRepoRoot, timeout: 30_000 });
    } catch {
      // A stale worktree registration is not guaranteed; creation reports any real conflict.
    }

    let previousWorktreePath = workspace.worktreeRoot;
    if (!previousWorktreePath) {
      // COMPAT(worktreeRestoreMissingWorktreeRoot): records created before v0.1.110
      // lack durable backing placement; remove filesystem discovery after 2027-01-17.
      const ownership = await isPaseoOwnedWorktreeCwd(workspace.cwd, {
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
      });
      previousWorktreePath = ownership.allowed
        ? (ownership.worktreePath ?? workspace.cwd)
        : workspace.cwd;
    }

    const lifecycle = deps.lifecycle;
    if (!lifecycle) {
      await recreateWorktreeDirect(workspace, sourceRepoRoot, previousWorktreePath, branch);
      return;
    }

    const operationIdentity = lifecycleOperationId ?? `workspace-restore:${workspace.workspaceId}`;
    await lifecycle.runCreate({
      operationId: `worktree-restore:${operationIdentity}`,
      fingerprint: fingerprintWorkspaceLifecycleRequest({
        workspaceId: workspace.workspaceId,
        branch,
        worktreePath: previousWorktreePath,
      }),
      resourceKey: `worktree:${previousWorktreePath}`,
      create: async () => {
        await recreateWorktreeDirect(workspace, sourceRepoRoot, previousWorktreePath, branch);
        return { worktreePath: previousWorktreePath };
      },
    });
  }

  async function recreateWorktreeDirect(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
    previousWorktreePath: string,
    branch: string,
  ): Promise<void> {
    let recreatedWorktreePath: string;
    try {
      const result = await createWorktree({
        cwd: sourceRepoRoot,
        worktreeSlug: basename(previousWorktreePath),
        source: { kind: "checkout-branch", branchName: branch },
        runSetup: false,
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
      });
      recreatedWorktreePath = result.worktreePath;
    } catch (error) {
      throw toWorktreeRequestError(error);
    }

    try {
      const recreatedWorkspacePath = mapWorkspaceCwdToWorktree({
        sourceWorktreePath: previousWorktreePath,
        workspaceCwd: workspace.cwd,
        targetWorktreePath: recreatedWorktreePath,
      });
      if (!createRealpathAwarePathMatcher(workspace.cwd)(recreatedWorkspacePath)) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Recreated worktree diverged from ${workspace.cwd}: ${recreatedWorkspacePath}`,
        });
      }
      if (!(await deps.isDirectory(recreatedWorkspacePath))) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Selected project directory is missing from the restored worktree: ${recreatedWorkspacePath}`,
        });
      }
    } catch (error) {
      // Strict compensation: git-only removal of the just-created worktree.
      // If that fails the directory is preserved for manual cleanup — never a
      // recursive delete.
      try {
        await removePaseoWorktreeStrict({
          cwd: sourceRepoRoot,
          worktreePath: recreatedWorktreePath,
          paseoHome: deps.paseoHome,
          worktreesBaseRoot: deps.worktreesRoot,
        });
      } catch (compensationError) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `${error instanceof Error ? error.message : "Worktree restore failed"}; strict compensation preserved ${recreatedWorktreePath}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
        });
      }
      throw error;
    }
  }

  return { inspect, restore };
}

function createRecoveryPlan(
  input:
    | { action: "unarchive"; workspace: PersistedWorkspaceRecord }
    | { action: "restore"; workspace: PersistedWorkspaceRecord; sourceRepoRoot: string },
): RecoveryPlan {
  const state = {
    kind: "recoverable" as const,
    workspaceId: input.workspace.workspaceId,
    workspaceName: resolveWorkspaceDisplayName(input.workspace),
    branch: input.workspace.branch,
  };
  if (input.action === "restore") {
    return {
      kind: input.action,
      state: { ...state, action: input.action },
      workspace: input.workspace,
      sourceRepoRoot: input.sourceRepoRoot,
    };
  }
  return {
    kind: input.action,
    state: {
      ...state,
      action: input.action,
    },
    workspace: input.workspace,
  };
}
