import { describe, expect, it } from "vitest";
import { getWorkspaceHoverCardDirectoryLabel } from "./workspace-hover-card-model";

describe("getWorkspaceHoverCardDirectoryLabel", () => {
  it("shows the Paseo worktree directory instead of a nested workspace path", () => {
    expect(
      getWorkspaceHoverCardDirectoryLabel({
        workspaceDirectory: "/home/alice/.paseo/worktrees/project/feature/packages/app",
        paseoWorktreeRoot: "/home/alice/.paseo/worktrees/project/feature",
      }),
    ).toBe("feature");
  });

  it("handles a trailing separator in a Windows worktree root", () => {
    expect(
      getWorkspaceHoverCardDirectoryLabel({
        workspaceDirectory: "C:\\Users\\alice\\.paseo\\worktrees\\project\\feature\\packages\\app",
        paseoWorktreeRoot: "C:\\Users\\alice\\.paseo\\worktrees\\project\\feature\\",
      }),
    ).toBe("feature");
  });

  it("keeps the shortened workspace path for a non-Paseo worktree", () => {
    expect(
      getWorkspaceHoverCardDirectoryLabel({
        workspaceDirectory: "/home/alice/dev/project-worktree",
        paseoWorktreeRoot: null,
      }),
    ).toBe("~/dev/project-worktree");
  });
});
