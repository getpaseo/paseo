import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { GitHubService } from "../../../services/github-service.js";
import {
  checkoutResolvedBranch,
  type CheckoutExistingBranchResult,
  type GitMutationRefreshReason,
} from "../../../utils/checkout-git.js";
import { execCommand } from "../../../utils/spawn.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import { assertSafeGitRef as assertWorktreeSafeGitRef } from "../../worktree-session.js";

/**
 * The git branch / working-tree mutation primitives a client session performs on a
 * workspace: switch to an existing branch, create a branch from a base, and force a
 * snapshot refresh (plus optional GitHub cache invalidation) after any mutation.
 *
 * CheckoutSession (the branch/commit/merge commands), the worktree session-config
 * builder, and the auto-naming + worktree-creation paths all funnel their git
 * mutations through this one module, so the validate-ref → clean-tree → execute →
 * refresh sequence lives in a single place instead of being smeared across the
 * session as loose callbacks.
 */
export interface GitMutationService {
  checkoutExistingBranch(cwd: string, branch: string): Promise<CheckoutExistingBranchResult>;
  createBranchFromBase(params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }): Promise<void>;
  notifyGitMutation(
    cwd: string,
    reason: GitMutationRefreshReason,
    options?: { invalidateGithub?: boolean },
  ): Promise<void>;
}

type GitMutationGitSource = Pick<
  WorkspaceGitService,
  "validateBranchRef" | "getSnapshot" | "hasLocalBranch"
>;

export function createGitMutationService(deps: {
  workspaceGitService: GitMutationGitSource;
  github: Pick<GitHubService, "invalidate">;
  logger: pino.Logger;
}): GitMutationService {
  const { workspaceGitService, github, logger } = deps;

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
    options?: { invalidateGithub?: boolean },
  ): Promise<void> {
    if (options?.invalidateGithub) {
      github.invalidate({ cwd });
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
    async checkoutExistingBranch(cwd, branch) {
      assertSafeGitRef(branch, "branch");
      const resolution = await workspaceGitService.validateBranchRef(cwd, branch);
      if (resolution.kind === "not-found") {
        throw new Error(`Branch not found: ${branch}`);
      }
      await ensureCleanWorkingTree(cwd);
      const result = await checkoutResolvedBranch({ cwd, resolution });
      await notifyGitMutation(cwd, "switch-branch", { invalidateGithub: true });
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
      await execCommand("git", ["checkout", "-b", newBranchName, baseBranch], { cwd });
      await notifyGitMutation(cwd, "create-branch");
    },

    notifyGitMutation,
  };
}
