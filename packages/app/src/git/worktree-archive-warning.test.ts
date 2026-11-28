import { describe, expect, it } from "vitest";

import type { CheckoutStatusClient, CheckoutStatusPayload } from "@/git/checkout-status-cache";
import {
  buildWorktreeArchiveConfirmationMessage,
  buildWorktreeArchiveRiskReasons,
  readWorktreeArchiveRisk,
  toWorktreeArchiveRisk,
} from "@/git/worktree-archive-warning";

const WORKTREE = "/home/me/.paseo/worktrees/repo/feature";

function hostAnswering(status: CheckoutStatusPayload): CheckoutStatusClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getCheckoutStatus: async (cwd) => {
      asked.push(cwd);
      return status;
    },
  };
}

const NOT_GIT = {
  cwd: WORKTREE,
  requestId: "status",
  isGit: false,
  isPaseoOwnedWorktree: false,
  repoRoot: null,
  currentBranch: null,
  isDirty: null,
  baseRef: null,
  aheadBehind: null,
  aheadOfOrigin: null,
  behindOfOrigin: null,
  hasRemote: false,
  remoteUrl: null,
  error: null,
} satisfies CheckoutStatusPayload;

describe("reading a worktree's archive risk from its host", () => {
  it("reads uncommitted changes and unpushed commits from the worktree's checkout status", async () => {
    const host = hostAnswering({
      cwd: WORKTREE,
      requestId: "status",
      isGit: true,
      isPaseoOwnedWorktree: true,
      repoRoot: WORKTREE,
      mainRepoRoot: "/home/me/repo",
      currentBranch: "feature",
      isDirty: true,
      baseRef: "main",
      aheadBehind: { ahead: 2, behind: 0 },
      aheadOfOrigin: 2,
      behindOfOrigin: 0,
      hasRemote: true,
      remoteUrl: "git@example.com:me/repo.git",
      error: null,
    });

    expect(await readWorktreeArchiveRisk(host, WORKTREE)).toEqual({
      isDirty: true,
      aheadOfOrigin: 2,
    });
    expect(host.asked).toEqual([WORKTREE]);
  });

  it("finds nothing to lose in a directory that is no longer a git checkout", async () => {
    expect(await readWorktreeArchiveRisk(hostAnswering(NOT_GIT), WORKTREE)).toEqual({
      isDirty: false,
      aheadOfOrigin: null,
    });
  });

  it("rejects with the host's error when it can't read the worktree", async () => {
    const host = hostAnswering({
      ...NOT_GIT,
      error: { code: "UNKNOWN", message: "git status failed" },
    });

    await expect(readWorktreeArchiveRisk(host, WORKTREE)).rejects.toThrow("git status failed");
  });
});

describe("workspace archive warning for worktree backing", () => {
  it("does not require a confirmation for clean and pushed worktrees", () => {
    expect(
      buildWorktreeArchiveConfirmationMessage({
        workspaceName: "feature",
        isDirty: false,
        aheadOfOrigin: 0,
        diffStat: null,
      }),
    ).toBeNull();
  });

  it("explains uncommitted line changes", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: true,
        aheadOfOrigin: 0,
        diffStat: { additions: 12, deletions: 1 },
      }),
    ).toEqual(["Uncommitted changes (12 added lines, 1 deleted line)"]);
  });

  it("treats nonzero diff stats as dirty when dirty state is missing", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: undefined,
        aheadOfOrigin: 0,
        diffStat: { additions: 4, deletions: 0 },
      }),
    ).toEqual(["Uncommitted changes (4 added lines)"]);
  });

  it("explains unpushed commits", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: false,
        aheadOfOrigin: 2,
        diffStat: null,
      }),
    ).toEqual(["2 unpushed commits"]);
  });

  it("includes every archive risk in the confirmation copy", () => {
    expect(
      buildWorktreeArchiveConfirmationMessage({
        workspaceName: "risky-feature",
        isDirty: true,
        aheadOfOrigin: 1,
        diffStat: { additions: 1, deletions: 3 },
      }),
    ).toBe("Uncommitted changes (1 added line, 3 deleted lines)\n1 unpushed commit");
  });

  it("maps archive workspace fields into the shared worktree risk shape", () => {
    expect(
      toWorktreeArchiveRisk({
        archiveHasUncommittedChanges: true,
        archiveUnpushedCommitCount: 3,
        diffStat: { additions: 2, deletions: 1 },
      }),
    ).toEqual({
      isDirty: true,
      aheadOfOrigin: 3,
      diffStat: { additions: 2, deletions: 1 },
    });
  });
});
