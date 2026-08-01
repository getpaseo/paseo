import { basename } from "node:path";

import { areEquivalentPaths, createRealpathAwarePathMatcher } from "../../../utils/path.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import {
  createWorktree,
  getPaseoWorktreesRoot,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  rollbackCreatedPaseoWorktree,
} from "../../../utils/worktree.js";
import { WorktreeRequestError, toWorktreeRequestError } from "../../worktree-errors.js";
import { withWorkspaceCleanupLock } from "../../workspace-cleanup-lock.js";
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
        | "workspace_directory_replaced"
        | "worktree_branch_missing";
      message: string;
    };

export interface WorkspaceRecoveryService {
  inspect(workspaceId: string): Promise<WorkspaceRecoveryState>;
  restore(workspaceId: string): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }>;
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

    if (workspace.kind !== "worktree") {
      if (await deps.isDirectory(workspace.cwd)) {
        return createRecoveryPlan({ action: "unarchive", workspace });
      }
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_directory_missing",
        message: "The archived workspace directory no longer exists and cannot be recreated.",
      };
    }
    const expectedWorktreePath = workspace.worktreeRoot ?? workspace.cwd;
    const workspaceDirectoryExists = await deps.isDirectory(workspace.cwd);
    const cleanupRecovery = resolveCleanupRecovery(
      workspace,
      expectedWorktreePath,
      workspaceDirectoryExists,
    );
    if (cleanupRecovery) return cleanupRecovery;
    if (workspaceDirectoryExists) {
      const ownership = await isPaseoOwnedWorktreeCwd(workspace.cwd, {
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
      });
      const sourceRepoRoot = workspace.mainRepoRoot ?? project.rootPath;
      if (
        ownership.allowed &&
        ownership.worktreePath &&
        ownership.repoRoot &&
        areEquivalentPaths(ownership.worktreePath, expectedWorktreePath) &&
        areEquivalentPaths(ownership.repoRoot, sourceRepoRoot)
      ) {
        return createRecoveryPlan({ action: "unarchive", workspace });
      }
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_directory_replaced",
        message: "The archived worktree path is occupied by a different directory.",
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
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const resolved = await resolveRecovery(workspaceId);
    if (resolved.kind === "unavailable") {
      throw new Error(resolved.message);
    }

    if (resolved.kind === "restore") {
      const worktreesRoot = await getPaseoWorktreesRoot(
        resolved.sourceRepoRoot,
        deps.paseoHome,
        deps.worktreesRoot,
      );
      await withWorkspaceCleanupLock(worktreesRoot, async () => {
        await recreateArchivedWorktree(resolved.workspace, resolved.sourceRepoRoot);
        await deps.unarchiveWorkspace(resolved.workspace);
      });
    } else {
      await deps.unarchiveWorkspace(resolved.workspace);
    }
    return { workspaceId, action: resolved.kind };
  }

  async function recreateArchivedWorktree(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
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
      return rollbackCreatedPaseoWorktree(
        {
          cwd: sourceRepoRoot,
          worktreePath: recreatedWorktreePath,
          teardownCwds: [],
          paseoHome: deps.paseoHome,
          worktreesBaseRoot: deps.worktreesRoot,
        },
        error,
      );
    }
  }

  return { inspect, restore };
}

function resolveCleanupRecovery(
  workspace: PersistedWorkspaceRecord,
  expectedWorktreePath: string,
  workspaceDirectoryExists: boolean,
): UnavailableRecoveryState | RecoveryPlan | null {
  const receipt = workspace.cleanupPending;
  if (!receipt) return null;
  if (!areEquivalentPaths(receipt.backingPath, expectedWorktreePath)) {
    return {
      kind: "unavailable",
      workspaceId: workspace.workspaceId,
      reason: "workspace_directory_replaced",
      message: "Workspace cleanup moved to a different path and must finish before restoration.",
    };
  }
  if (workspaceDirectoryExists) {
    return createRecoveryPlan({ action: "unarchive", workspace });
  }
  return {
    kind: "unavailable",
    workspaceId: workspace.workspaceId,
    reason: "workspace_directory_replaced",
    message: "Workspace cleanup must finish before this worktree can be restored.",
  };
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
