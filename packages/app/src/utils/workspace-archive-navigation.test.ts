import type { Href } from "expo-router";
import { describe, expect, it } from "vitest";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  redirectIfArchivingActiveWorkspace,
  type RedirectIfArchivingActiveWorkspaceDeps,
} from "@/utils/workspace-archive-redirect";

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
    archivingAt: input.archivingAt ?? null,
    statusEnteredAt: null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

describe("buildWorkspaceArchiveRedirectRoute", () => {
  it("redirects an archived worktree to the new workspace screen for the same project", () => {
    const workspaces = [
      workspace({ id: "/repo", workspaceKind: "checkout", name: "main" }),
      workspace({ id: "/repo/.paseo/worktrees/feature", name: "feature" }),
    ];

    expect(
      buildWorkspaceArchiveRedirectRoute({
        serverId: "server-1",
        archivedWorkspaceId: "/repo/.paseo/worktrees/feature",
        workspaces,
      }),
    ).toBe("/h/server-1/new?dir=%2Frepo&name=Project&projectId=project-1");
  });

  it("redirects to the new workspace route when no sibling workspace target exists", () => {
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
    ).toBe("/h/server-1/new?dir=%2Frepo&name=Project&projectId=project-1");
  });

  it("redirects to the new workspace route instead of another workspace", () => {
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
    ).toBe("/h/server-1/new?dir=%2Fnotes&name=Project&projectId=notes");
  });
});

function createFakeRouter(workspaces: WorkspaceDescriptor[]): {
  deps: RedirectIfArchivingActiveWorkspaceDeps;
  routes: Href[];
} {
  const routes: Href[] = [];
  return {
    routes,
    deps: {
      navigateToRoute: (route) => {
        routes.push(route);
      },
      readWorkspaces: () => workspaces,
    },
  };
}

describe("redirectIfArchivingActiveWorkspace", () => {
  it("does not replace the route when archiving an inactive workspace", () => {
    const { deps, routes } = createFakeRouter([
      workspace({ id: "main", workspaceKind: "local_checkout" }),
      workspace({ id: "feature", name: "feature" }),
    ]);

    expect(
      redirectIfArchivingActiveWorkspace(
        {
          serverId: "server-1",
          workspaceId: "feature",
          activeWorkspaceSelection: { serverId: "server-1", workspaceId: "main" },
        },
        deps,
      ),
    ).toBe(false);

    expect(routes).toEqual([]);
  });

  it("replaces the route at action time when archiving the active workspace", () => {
    const { deps, routes } = createFakeRouter([
      workspace({ id: "main", workspaceKind: "local_checkout" }),
      workspace({ id: "feature", name: "feature" }),
    ]);

    expect(
      redirectIfArchivingActiveWorkspace(
        {
          serverId: "server-1",
          workspaceId: "feature",
          activeWorkspaceSelection: { serverId: "server-1", workspaceId: "feature" },
        },
        deps,
      ),
    ).toBe(true);

    expect(routes).toEqual(["/h/server-1/new?dir=%2Frepo&name=Project&projectId=project-1"]);
  });
});
