import { describe, expect, it } from "vitest";
import {
  resolveSidebarWorkspaceAccessibilityLabel,
  resolveSidebarWorkspacePrimaryLabel,
} from "@/components/sidebar/sidebar-workspace-title";

describe("resolveSidebarWorkspacePrimaryLabel", () => {
  it("uses the workspace name in title mode", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search" },
      workspaceTitleSource: "title",
    });

    expect(label).toBe("Investigate search");
  });

  it("uses the branch name in branch mode", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search" },
      workspaceTitleSource: "branch",
    });

    expect(label).toBe("fix/search");
  });

  it("falls back to the workspace name in branch mode without a branch", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { name: "Local folder", currentBranch: null },
      workspaceTitleSource: "branch",
    });

    expect(label).toBe("Local folder");
  });
});

describe("resolveSidebarWorkspaceAccessibilityLabel", () => {
  it("includes the visible host badge with the workspace title", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search", statusBucket: "done" },
      workspaceTitleSource: "title",
      hostBadgeLabel: "Build host",
    });

    expect(label).toBe("Investigate search, Build host");
  });

  it("owns every visual row contributor in one accessible label", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: {
        name: "Investigate search",
        currentBranch: "fix/search",
        statusBucket: "running",
      },
      workspaceTitleSource: "branch",
      leadingProjectName: "Search project",
      hostBadgeLabel: "Build host",
      pullRequestLabel: "Pull request 42",
      serviceLabel: "Service web running",
    });

    expect(label).toBe(
      "Search project, fix/search, Build host, Pull request 42, Service web running, Working",
    );
  });

  it("omits the idle status from the workspace label", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search", statusBucket: "done" },
      workspaceTitleSource: "title",
      leadingProjectName: "Search project",
      hostBadgeLabel: "Build host",
    });

    expect(label).toBe("Search project, Investigate search, Build host");
  });
});
