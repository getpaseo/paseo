import { describe, expect, it } from "vitest";
import { deriveProjectPlacementFromCwd, resolveProjectPlacement } from "./project-placement";

describe("project-placement", () => {
  it.each([undefined, null])(
    "keeps unrelated default-root worktrees distinct when placement is %s",
    (projectPlacement) => {
      const cwds = [
        "/home/alice/.paseo/worktrees/project-hash-a/feature-a",
        "/home/alice/.paseo/worktrees/project-hash-b/feature-b",
      ];
      const placements = cwds.map((cwd) => resolveProjectPlacement({ projectPlacement, cwd }));

      expect(placements.map((placement) => placement.projectKey)).toEqual(cwds);
      expect(placements.map((placement) => placement.projectName)).toEqual([
        "feature-a",
        "feature-b",
      ]);
      expect(placements.map((placement) => placement.checkout.cwd)).toEqual(cwds);
    },
  );

  it("derives fallback placement from cwd", () => {
    const placement = deriveProjectPlacementFromCwd("/Users/test/repo");

    expect(placement.projectKey).toBe("/Users/test/repo");
    expect(placement.projectName).toBe("repo");
    expect(placement.checkout.cwd).toBe("/Users/test/repo");
    expect(placement.checkout.isGit).toBe(false);
  });

  it("preserves repo-local worktree paths without authoritative placement", () => {
    const placement = deriveProjectPlacementFromCwd("/Users/test/repo/.paseo/worktrees/feature-x");

    expect(placement.projectKey).toBe("/Users/test/repo/.paseo/worktrees/feature-x");
    expect(placement.projectName).toBe("feature-x");
    expect(placement.checkout.cwd).toBe("/Users/test/repo/.paseo/worktrees/feature-x");
  });

  it("prefers an existing placement when present", () => {
    const existing = {
      projectKey: "remote:github.com/acme/repo",
      projectName: "acme/repo",
      checkout: {
        cwd: "/Users/test/repo",
        isGit: true as const,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/Users/test/repo",
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      },
    };

    const resolved = resolveProjectPlacement({
      projectPlacement: existing,
      cwd: "/Users/test/repo",
    });

    expect(resolved).toBe(existing);
  });
});
