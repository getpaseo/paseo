import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { resolveRepositoryDefaultBranch } from "../../../utils/checkout-git.js";
import { runWithRepositoryRoot } from "../../../utils/git-repository-discovery.js";
import { createRealpathAwarePathMatcher } from "../../../utils/path.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import { setPaseoWorktreeUntrustedSource } from "../../../utils/worktree-metadata.js";
import {
  createWorktree,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  rollbackCreatedPaseoWorktree,
  runPluginWorktreeManagerCheckout,
  type WorktreeSource,
} from "../../../utils/worktree.js";
import type { PluginWorktreeManagerRuntime } from "../../plugins/runtime.js";
import type { PluginWorktreeRestoreTarget } from "@getpaseo/plugin/server";
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
  worktreeManagers?: Pick<
    PluginWorktreeManagerRuntime,
    "hasWorktreeManager" | "restoreWorktree" | "removeWorktree"
  >;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProject: (projectId: string) => Promise<PersistedProjectRecord | null>;
  isDirectory: (path: string) => Promise<boolean>;
  unarchiveWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  waitForDeferredPublication?: (workspaceId: string) => Promise<boolean>;
  isCheckoutUntrusted?: (checkoutPath: string) => Promise<boolean>;
  syncCheckoutWorktreeManager?: (input: {
    worktreeRoot: string;
    worktreeManagerPluginId: string | null;
    excludeWorkspaceId: string;
  }) => Promise<void>;
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

    return createRecoveryPlan({ action: "restore", workspace, sourceRepoRoot });
  }

  async function inspect(workspaceId: string): Promise<WorkspaceRecoveryState> {
    await deps.waitForDeferredPublication?.(workspaceId);
    const resolved = await resolveRecovery(workspaceId);
    return resolved.kind === "unavailable" ? resolved : resolved.state;
  }

  async function restore(
    workspaceId: string,
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const waited = (await deps.waitForDeferredPublication?.(workspaceId)) ?? false;
    if (waited) {
      const settled = await deps.getWorkspace(workspaceId);
      if (settled && !settled.archivedAt) {
        return { workspaceId, action: "unarchive" };
      }
    }
    const resolved = await resolveRecovery(workspaceId);
    if (resolved.kind === "unavailable") {
      throw new Error(resolved.message);
    }

    let workspaceToUnarchive = resolved.workspace;
    let recreated: { worktreePath: string; pluginId: string | null } | null = null;
    if (resolved.kind === "restore") {
      const { workspace, sourceRepoRoot } = resolved;
      recreated = await runWithRepositoryRoot(sourceRepoRoot, () =>
        recreateArchivedWorktree(workspace, sourceRepoRoot),
      );
      if ((resolved.workspace.worktreeManagerPluginId ?? null) !== recreated.pluginId) {
        const { worktreeManagerPluginId: _previous, ...withoutManager } = resolved.workspace;
        workspaceToUnarchive = recreated.pluginId
          ? { ...withoutManager, worktreeManagerPluginId: recreated.pluginId }
          : withoutManager;
      }
    }
    await deps.unarchiveWorkspace(workspaceToUnarchive);
    if (recreated) {
      await deps.syncCheckoutWorktreeManager?.({
        worktreeRoot: recreated.worktreePath,
        worktreeManagerPluginId: recreated.pluginId,
        excludeWorkspaceId: workspaceId,
      });
    }
    return { workspaceId, action: resolved.kind };
  }

  async function recreateArchivedWorktree(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
  ): Promise<{ worktreePath: string; pluginId: string | null }> {
    let source: WorktreeSource;
    const checkout = parseWorkspaceHead(workspace);
    if (checkout.kind === "branch") {
      source = {
        kind: "restore",
        branchName: checkout.branch,
        baseRef: workspace.baseBranch,
      };
    } else if (checkout.kind === "commit") {
      source = {
        kind: "restore-commit",
        commit: checkout.commit,
        baseRef: await resolveRecoveryBase(sourceRepoRoot, workspace.baseBranch),
      };
    } else {
      source = {
        kind: "restore-from-base",
        branchName: `restored/${randomUUID().slice(0, 8)}`,
        baseRef: await resolveRecoveryBase(sourceRepoRoot, workspace.baseBranch),
      };
    }

    try {
      await runGitCommand(["worktree", "prune"], { cwd: sourceRepoRoot, timeout: 30_000 });
    } catch {
      // A stale worktree registration is not guaranteed; creation reports any real conflict.
    }

    let previousWorktreePath = workspace.worktreeRoot;
    let hasRecordedWorktreePath = Boolean(previousWorktreePath);
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
      hasRecordedWorktreePath = ownership.allowed;
    }

    const untrusted =
      Boolean(workspace.untrustedSource) ||
      Boolean(await deps.isCheckoutUntrusted?.(previousWorktreePath));
    let recreatedWorktreePath: string;
    let restoredByPluginId: string | null = null;
    try {
      const restored = await recreateWorktreeCheckout({
        workspace,
        sourceRepoRoot,
        source,
        previousWorktreePath,
        hasRecordedWorktreePath,
        untrusted,
      });
      recreatedWorktreePath = restored.worktreePath;
      restoredByPluginId = restored.pluginId;
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
          worktreeManagers: deps.worktreeManagers,
          worktreeManagerPluginId: restoredByPluginId,
          removeReason: "rollback",
          untrusted,
        },
        error,
      );
    }
    if (workspace.untrustedSource) {
      await setPaseoWorktreeUntrustedSource(recreatedWorktreePath, workspace.untrustedSource);
    }
    return { worktreePath: recreatedWorktreePath, pluginId: restoredByPluginId };
  }

  async function recreateWorktreeCheckout(options: {
    workspace: PersistedWorkspaceRecord;
    sourceRepoRoot: string;
    source: Extract<WorktreeSource, { kind: "restore" | "restore-commit" | "restore-from-base" }>;
    previousWorktreePath: string;
    hasRecordedWorktreePath: boolean;
    untrusted: boolean;
  }): Promise<{ worktreePath: string; pluginId: string | null }> {
    const {
      workspace,
      sourceRepoRoot,
      source,
      previousWorktreePath,
      hasRecordedWorktreePath,
      untrusted,
    } = options;
    const managerPluginId = workspace.worktreeManagerPluginId;
    if (managerPluginId && hasRecordedWorktreePath && deps.worktreeManagers) {
      const adopted = await runPluginWorktreeManagerCheckout({
        cwd: sourceRepoRoot,
        source,
        operation: "restore",
        preferredPluginId: managerPluginId,
        untrusted,
        paseoHome: deps.paseoHome,
        worktreesBaseRoot: deps.worktreesRoot,
        worktreeManagers: deps.worktreeManagers,
        run: () =>
          deps.worktreeManagers!.restoreWorktree(
            {
              repoRoot: sourceRepoRoot,
              path: previousWorktreePath,
              target: restoreTargetFromWorktreeSource(source),
              baseRef: workspace.baseBranch,
              untrusted,
            },
            { preferredPluginId: managerPluginId },
          ),
        verifyValidatedPath: (validatedPath, pluginId) => {
          if (!createRealpathAwarePathMatcher(previousWorktreePath)(validatedPath)) {
            throw new WorktreeRequestError({
              code: "unknown",
              message: `Plugin ${pluginId} restored worktree to ${validatedPath}, expected ${previousWorktreePath}`,
            });
          }
        },
      });
      if (adopted) {
        return {
          worktreePath: adopted.worktreePath,
          pluginId: adopted.worktreeManagerPluginId ?? managerPluginId,
        };
      }
    }

    const result = await createWorktree({
      cwd: sourceRepoRoot,
      worktreeSlug: basename(previousWorktreePath),
      source,
      paseoHome: deps.paseoHome,
      worktreesRoot: deps.worktreesRoot,
      ...(hasRecordedWorktreePath ? { worktreePath: previousWorktreePath } : {}),
    });
    return { worktreePath: result.worktreePath, pluginId: null };
  }

  return { inspect, restore };
}

function restoreTargetFromWorktreeSource(
  source: Extract<WorktreeSource, { kind: "restore" | "restore-commit" | "restore-from-base" }>,
): PluginWorktreeRestoreTarget {
  if (source.kind === "restore") {
    return { type: "branch", branch: source.branchName };
  }
  if (source.kind === "restore-commit") {
    return { type: "commit", commit: source.commit };
  }
  return { type: "from-base", branch: source.branchName, baseRef: source.baseRef };
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

function parseWorkspaceHead(
  workspace: PersistedWorkspaceRecord,
): { kind: "branch"; branch: string } | { kind: "commit"; commit: string } | { kind: "missing" } {
  if (workspace.head) {
    const prefix = "refs/heads/";
    return workspace.head.startsWith(prefix)
      ? { kind: "branch", branch: workspace.head.slice(prefix.length) }
      : { kind: "commit", commit: workspace.head };
  }
  return workspace.branch ? { kind: "branch", branch: workspace.branch } : { kind: "missing" };
}

function createRecoveryPlan(
  input:
    | { action: "unarchive"; workspace: PersistedWorkspaceRecord }
    | { action: "restore"; workspace: PersistedWorkspaceRecord; sourceRepoRoot: string },
): RecoveryPlan {
  const checkout = parseWorkspaceHead(input.workspace);
  const state = {
    kind: "recoverable" as const,
    workspaceId: input.workspace.workspaceId,
    workspaceName: resolveWorkspaceDisplayName(input.workspace),
    branch: checkout.kind === "branch" ? checkout.branch : null,
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
