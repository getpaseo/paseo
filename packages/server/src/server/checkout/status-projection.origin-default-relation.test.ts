import { describe, expect, it } from "vitest";
import { buildCheckoutStatusPayloadFromSnapshot } from "./status-projection.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

function gitSnapshot(
  overrides?: Partial<WorkspaceGitRuntimeSnapshot["git"]>,
): WorkspaceGitRuntimeSnapshot {
  return {
    cwd: "/tmp/repo",
    git: {
      isGit: true,
      repoRoot: "/tmp/repo",
      mainRepoRoot: null,
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 1, behind: 0 },
      aheadOfOrigin: 1,
      behindOfOrigin: 0,
      originDefaultRelation: {
        state: "included",
        resolvedRef: "origin/main",
        ahead: 0,
        behind: 3,
        uniquePatchCount: 0,
      },
      hasRemote: true,
      diffStat: null,
      ...overrides,
    },
    forge: {
      featuresEnabled: false,
      authState: "no_remote",
      pullRequest: null,
      error: null,
    },
  };
}

describe("buildCheckoutStatusPayloadFromSnapshot originDefaultRelation", () => {
  it("propagates originDefaultRelation on git checkout status", () => {
    const payload = buildCheckoutStatusPayloadFromSnapshot({
      cwd: "/tmp/repo",
      requestId: "r1",
      snapshot: gitSnapshot(),
    });

    expect(payload).toMatchObject({
      isGit: true,
      aheadOfOrigin: 1,
      behindOfOrigin: 0,
      originDefaultRelation: {
        state: "included",
        resolvedRef: "origin/main",
        ahead: 0,
        behind: 3,
        uniquePatchCount: 0,
      },
    });
  });

  it("omits originDefaultRelation when snapshot lacks the field (old shape)", () => {
    const snapshot = gitSnapshot();
    delete snapshot.git.originDefaultRelation;

    const payload = buildCheckoutStatusPayloadFromSnapshot({
      cwd: "/tmp/repo",
      requestId: "r2",
      snapshot,
    });

    expect(payload.isGit).toBe(true);
    if (payload.isGit) {
      expect(payload.originDefaultRelation).toBeUndefined();
      expect(payload.aheadOfOrigin).toBe(1);
    }
  });

  it("propagates originDefaultRelation for paseo-owned worktrees", () => {
    const payload = buildCheckoutStatusPayloadFromSnapshot({
      cwd: "/tmp/wt",
      requestId: "r3",
      snapshot: gitSnapshot({
        isPaseoOwnedWorktree: true,
        repoRoot: "/tmp/wt",
        mainRepoRoot: "/tmp/repo",
        baseRef: "main",
      }),
    });

    expect(payload).toMatchObject({
      isGit: true,
      isPaseoOwnedWorktree: true,
      originDefaultRelation: {
        state: "included",
        resolvedRef: "origin/main",
      },
    });
  });
});
