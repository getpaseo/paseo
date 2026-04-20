import { describe, expect, it } from "vitest";
import {
  buildWorkspaceArchiveRedirectRoute,
  resolveWorkspaceArchiveRedirectWorkspaceId,
} from "@/utils/workspace-archive-navigation";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function workspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project",
    projectRootPath: input.projectRootPath ?? "/repo",
    workspaceDirectory: input.workspaceDirectory ?? input.projectRootPath ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "worktree",
    name: input.name ?? input.id,
    status: input.status ?? "done",
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

describe("resolveWorkspaceArchiveRedirectWorkspaceId", () => {
  it("redirects an archived worktree to the visible local checkout for the same project", () => {
    const workspaces = [
      workspace({ id: "/repo", workspaceKind: "checkout", name: "main" }),
      workspace({ id: "/repo/.paseo/worktrees/feature", name: "feature" }),
    ];

    expect(
      resolveWorkspaceArchiveRedirectWorkspaceId({
        archivedWorkspaceId: "/repo/.paseo/worktrees/feature",
        workspaces,
      }),
    ).toBe("/repo");
  });

  it("falls back to the host root route when no sibling workspace target exists", () => {
    const workspaces = [
      workspace({
        id: "/repo/.paseo/worktrees/feature",
        name: "feature",
        projectRootPath: "/repo",
      }),
    ];

    expect(
      buildWorkspaceArchiveRedirectRoute({
        serverId: "server-1",
        archivedWorkspaceId: "/repo/.paseo/worktrees/feature",
        workspaces,
      }),
    ).toBe("/h/server-1");
  });

  it("falls back to the host root route when no alternate workspace target exists", () => {
    const workspaces = [
      workspace({
        id: "/notes",
        projectId: "notes",
        projectRootPath: "/notes",
        projectKind: "directory",
        workspaceKind: "checkout",
      }),
    ];

    expect(
      buildWorkspaceArchiveRedirectRoute({
        serverId: "server-1",
        archivedWorkspaceId: "/notes",
        workspaces,
      }),
    ).toBe("/h/server-1");
  });
});
