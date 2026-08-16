import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  CheckoutExistingBranchResult,
  GitMutationRefreshReason,
} from "../../../utils/checkout-git.js";
import type { WorkspaceGitService, WorkspaceGitWorkspace } from "../../workspace-git-service.js";
import { assertSafeGitRef as assertWorktreeSafeGitRef } from "../../worktree-session.js";

/**
 * The git branch / working-tree mutation primitives a client session performs on a
 * workspace: switch to an existing branch, create a branch from a base, and force a
 * snapshot refresh (plus optional forge cache invalidation) after any mutation.
 *
 * CheckoutSession (the branch/commit/merge commands), the worktree session-config
 * builder, and the auto-naming + worktree-creation paths all funnel their git
 * mutations through this one module, so the validate-ref → clean-tree → execute →
 * refresh sequence lives in a single place instead of being smeared across the
 * session as loose callbacks.
 */
export interface GitMutationService {
  bind(workspaceGit: WorkspaceGitWorkspace): BoundGitMutation;
  /** Explicit compatibility path for callers that do not own a workspace record yet. */
  checkoutExistingBranch(cwd: string, branch: string): Promise<CheckoutExistingBranchResult>;
  createBranchFromBase(params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }): Promise<void>;
  notifyGitMutation(
    cwd: string,
    reason: GitMutationRefreshReason,
    options?: { invalidateForge?: boolean },
  ): Promise<void>;
}

export interface BoundGitMutation {
  checkoutExistingBranch(branch: string): Promise<CheckoutExistingBranchResult>;
  createBranchFromBase(params: { baseBranch: string; newBranchName: string }): Promise<void>;
  notify(reason: GitMutationRefreshReason, options?: { invalidateForge?: boolean }): Promise<void>;
}

type GitMutationGitSource = Pick<
  WorkspaceGitService,
  | "validateBranchRef"
  | "getSnapshot"
  | "hasLocalBranch"
  | "invalidateForge"
  | "switchBranch"
  | "createBranch"
>;

export function createGitMutationService(deps: {
  workspaceGitService: GitMutationGitSource;
  logger: pino.Logger;
}): GitMutationService {
  const { workspaceGitService, logger } = deps;

  function bind(workspaceGit: WorkspaceGitWorkspace): BoundGitMutation {
    async function isBoundWorkingTreeDirty(): Promise<boolean> {
      try {
        const snapshot = await workspaceGit.getSnapshot();
        return snapshot.git.isDirty === true;
      } catch (error) {
        throw new Error(
          `Unable to inspect git status for ${workspaceGit.cwd}: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
    }

    async function ensureBoundWorkingTreeClean(): Promise<void> {
      if (await isBoundWorkingTreeDirty()) {
        throw new Error(
          "Working directory has uncommitted changes. Commit or stash before switching branches.",
        );
      }
    }

    async function notify(
      reason: GitMutationRefreshReason,
      options?: { invalidateForge?: boolean },
    ): Promise<void> {
      if (options?.invalidateForge) {
        workspaceGit.invalidateForge();
      }
      try {
        await workspaceGit.getSnapshot({ force: true, reason });
      } catch (error) {
        logger.warn(
          { err: error, cwd: workspaceGit.cwd, reason },
          "Failed to force-refresh workspace git snapshot after mutation",
        );
      }
    }

    return {
      async checkoutExistingBranch(branch) {
        assertSafeGitRef(branch, "branch");
        const resolution = await workspaceGit.validateBranchRef(branch);
        if (resolution.kind === "not-found") throw new Error(`Branch not found: ${branch}`);
        await ensureBoundWorkingTreeClean();
        const result = await workspaceGit.switchBranch(branch);
        await notify("switch-branch", { invalidateForge: true });
        return result;
      },
      async createBranchFromBase({ baseBranch, newBranchName }) {
        assertSafeGitRef(baseBranch, "base branch");
        assertSafeGitRef(newBranchName, "new branch");
        const baseResolution = await workspaceGit.validateBranchRef(baseBranch);
        if (baseResolution.kind === "not-found") {
          throw new Error(`Base branch not found: ${baseBranch}`);
        }
        if (await workspaceGit.hasLocalBranch(newBranchName)) {
          throw new Error(`Branch already exists: ${newBranchName}`);
        }
        await ensureBoundWorkingTreeClean();
        await workspaceGit.createBranch({ branch: newBranchName, baseRef: baseBranch });
        await notify("create-branch");
      },
      notify,
    };
  }

  function assertSafeGitRef(ref: string, label: string): void {
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
      throw new Error(`Invalid ${label}: ${ref}`);
    }
    assertWorktreeSafeGitRef(ref, label);
  }

  async function isWorkingTreeDirty(cwd: string): Promise<boolean> {
    try {
      const snapshot = await workspaceGitService.getSnapshot(cwd);
      return snapshot.git.isDirty === true;
    } catch (error) {
      throw new Error(`Unable to inspect git status for ${cwd}: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async function ensureCleanWorkingTree(cwd: string): Promise<void> {
    const dirty = await isWorkingTreeDirty(cwd);
    if (dirty) {
      throw new Error(
        "Working directory has uncommitted changes. Commit or stash before switching branches.",
      );
    }
  }

  async function notifyGitMutation(
    cwd: string,
    reason: GitMutationRefreshReason,
    options?: { invalidateForge?: boolean },
  ): Promise<void> {
    if (options?.invalidateForge) {
      workspaceGitService.invalidateForge(cwd);
    }
    try {
      await workspaceGitService.getSnapshot(cwd, { force: true, reason });
    } catch (error) {
      logger.warn(
        { err: error, cwd, reason },
        "Failed to force-refresh workspace git snapshot after mutation",
      );
    }
  }

  return {
    bind,
    async checkoutExistingBranch(cwd, branch) {
      assertSafeGitRef(branch, "branch");
      const resolution = await workspaceGitService.validateBranchRef(cwd, branch);
      if (resolution.kind === "not-found") {
        throw new Error(`Branch not found: ${branch}`);
      }
      await ensureCleanWorkingTree(cwd);
      const result = await workspaceGitService.switchBranch(cwd, branch);
      await notifyGitMutation(cwd, "switch-branch", { invalidateForge: true });
      return result;
    },

    async createBranchFromBase({ cwd, baseBranch, newBranchName }) {
      assertSafeGitRef(baseBranch, "base branch");
      assertSafeGitRef(newBranchName, "new branch");

      const baseResolution = await workspaceGitService.validateBranchRef(cwd, baseBranch);
      if (baseResolution.kind === "not-found") {
        throw new Error(`Base branch not found: ${baseBranch}`);
      }

      const exists = await workspaceGitService.hasLocalBranch(cwd, newBranchName);
      if (exists) {
        throw new Error(`Branch already exists: ${newBranchName}`);
      }

      await ensureCleanWorkingTree(cwd);
      await workspaceGitService.createBranch(cwd, {
        branch: newBranchName,
        baseRef: baseBranch,
      });
      await notifyGitMutation(cwd, "create-branch");
    },

    notifyGitMutation,
  };
}
