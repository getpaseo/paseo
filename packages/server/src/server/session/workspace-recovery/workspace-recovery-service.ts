import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { resolveRepositoryDefaultBranch } from "../../../utils/checkout-git.js";
import { createRealpathAwarePathMatcher } from "../../../utils/path.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import {
  createWorktree,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  rollbackCreatedPaseoWorktree,
  type WorktreeSource,
} from "../../../utils/worktree.js";
import { WorktreeRequestError, toWorktreeRequestError } from "../../worktree-errors.js";
import {
  resolveWorkspaceDisplayName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import { readArchivedHead, type ArchivedHead } from "./archived-head.js";

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
      previousWorktree: PreviousWorktree;
      // Read once here so the state shown to the user and the checkout restore makes agree.
      archivedHead: ArchivedHead | null;
    };

interface PreviousWorktree {
  path: string;
  isRecorded: boolean;
}

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

    const previousWorktree = await resolvePreviousWorktree(workspace);
    const archivedHead = await readArchivedHead({
      repoRoot: sourceRepoRoot,
      worktreePath: previousWorktree.path,
    });
    return createRecoveryPlan({
      action: "restore",
      workspace,
      sourceRepoRoot,
      previousWorktree,
      archivedHead,
    });
  }

  async function resolvePreviousWorktree(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PreviousWorktree> {
    if (workspace.worktreeRoot) return { path: workspace.worktreeRoot, isRecorded: true };
    // COMPAT(worktreeRestoreMissingWorktreeRoot): records created before v0.1.110
    // lack durable backing placement; remove filesystem discovery after 2027-01-17.
    const ownership = await isPaseoOwnedWorktreeCwd(workspace.cwd, {
      paseoHome: deps.paseoHome,
      worktreesRoot: deps.worktreesRoot,
    });
    return ownership.allowed
      ? { path: ownership.worktreePath ?? workspace.cwd, isRecorded: true }
      : { path: workspace.cwd, isRecorded: false };
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
      await recreateArchivedWorktree(resolved);
    }
    await deps.unarchiveWorkspace(resolved.workspace);
    return { workspaceId, action: resolved.kind };
  }

  async function recreateArchivedWorktree(
    plan: Extract<RecoveryPlan, { kind: "restore" }>,
  ): Promise<void> {
    const { workspace, sourceRepoRoot, previousWorktree } = plan;
    const source = await resolveRecoverySource(plan);

    try {
      await runGitCommand(["worktree", "prune"], { cwd: sourceRepoRoot, timeout: 30_000 });
    } catch {
      // A stale worktree registration is not guaranteed; creation reports any real conflict.
    }

    let recreatedWorktreePath: string;
    try {
      const result = await createWorktree({
        cwd: sourceRepoRoot,
        worktreeSlug: basename(previousWorktree.path),
        source,

        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        ...(previousWorktree.isRecorded ? { worktreePath: previousWorktree.path } : {}),
      });
      recreatedWorktreePath = result.worktreePath;
    } catch (error) {
      throw toWorktreeRequestError(error);
    }

    try {
      const recreatedWorkspacePath = mapWorkspaceCwdToWorktree({
        sourceWorktreePath: previousWorktree.path,
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

async function resolveRecoverySource(
  plan: Extract<RecoveryPlan, { kind: "restore" }>,
): Promise<WorktreeSource> {
  const { workspace, sourceRepoRoot, archivedHead } = plan;
  if (archivedHead) {
    return {
      kind: "restore-archived-head",
      ...archivedHead,
      baseRef: workspace.baseBranch ?? (await resolveRepositoryDefaultBranch(sourceRepoRoot)),
    };
  }
  if (workspace.branch) {
    return { kind: "restore", branchName: workspace.branch, baseRef: workspace.baseBranch };
  }
  return {
    kind: "restore-from-base",
    branchName: `restored/${randomUUID().slice(0, 8)}`,
    baseRef: await resolveRecoveryBase(sourceRepoRoot, workspace.baseBranch),
  };
}

async function resolveRecoveryBase(repoRoot: string, recordedBase: string | null): Promise<string> {
  if (recordedBase) {
    try {
      await runGitCommand(["rev-parse", "--verify", `${recordedBase}^{commit}`], { cwd: repoRoot });
      return recordedBase;
    } catch {
      // The saved base was removed; use the repository default for continued work.
    }
  }
  const defaultBranch = await resolveRepositoryDefaultBranch(repoRoot);
  if (!defaultBranch) {
    throw new WorktreeRequestError({
      code: "unknown",
      message:
        "The saved base is unavailable and the repository has no default branch to restore from.",
    });
  }
  return defaultBranch;
}

function createRecoveryPlan(
  input:
    | { action: "unarchive"; workspace: PersistedWorkspaceRecord }
    | (Omit<Extract<RecoveryPlan, { kind: "restore" }>, "kind" | "state"> & { action: "restore" }),
): RecoveryPlan {
  const state = {
    kind: "recoverable" as const,
    workspaceId: input.workspace.workspaceId,
    workspaceName: resolveWorkspaceDisplayName(input.workspace),
    branch: input.workspace.branch,
  };
  if (input.action === "restore") {
    const { action, ...plan } = input;
    return {
      ...plan,
      kind: action,
      // The record's branch is the last one observed, and HEAD may have left it before the
      // archive. With a saved HEAD, git decides at restore what HEAD comes back as.
      state: { ...state, action, branch: input.archivedHead ? null : state.branch },
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
