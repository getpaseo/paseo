import { describe, expect, it } from "vitest";
import {
  deriveProjectPlacementFromCwd,
  resolveProjectPlacement,
} from "./project-placement";

describe("project-placement", () => {
  it("derives fallback placement from cwd", () => {
    const placement = deriveProjectPlacementFromCwd("/Users/test/repo");

    expect(placement.projectKey).toBe("/Users/test/repo");
    expect(placement.projectName).toBe("repo");
    expect(placement.checkout.cwd).toBe("/Users/test/repo");
    expect(placement.checkout.isGit).toBe(false);
  });

  it("normalizes paseo worktree paths into the parent repo key", () => {
    const placement = deriveProjectPlacementFromCwd(
      "/Users/test/repo/.paseo/worktrees/feature-x"
    );

    expect(placement.projectKey).toBe("/Users/test/repo");
    expect(placement.projectName).toBe("repo");
    expect(placement.checkout.cwd).toBe(
      "/Users/test/repo/.paseo/worktrees/feature-x"
    );
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
