import type { Href } from "expo-router";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
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
    ).toBe("/new?serverId=server-1&dir=%2Frepo&name=Project&projectId=project-1");
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
    ).toBe("/new?serverId=server-1&dir=%2Frepo&name=Project&projectId=project-1");
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
    ).toBe("/new?serverId=server-1&dir=%2Fnotes&name=Project&projectId=notes");
  });
});

function createFakeRouter(
  workspaces: WorkspaceDescriptor[],
  targets: ActiveWorkspaceSelection[] = [],
): {
  deps: RedirectIfArchivingActiveWorkspaceDeps;
  routes: Href[];
  selections: ActiveWorkspaceSelection[];
} {
  const routes: Href[] = [];
  const selections: ActiveWorkspaceSelection[] = [];
  return {
    routes,
    selections,
    deps: {
      navigateToRoute: (route) => {
        routes.push(route);
      },
      readWorkspaces: () => workspaces,
      readSidebarWorkspaceTargets: () => targets,
      navigateToWorkspace: (target) => {
        selections.push(target);
      },
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

    expect(routes).toEqual(["/new?serverId=server-1&dir=%2Frepo&name=Project&projectId=project-1"]);
  });
});

describe("archive selection in sidebar order", () => {
  const target = (workspaceId: string, serverId = "server-1"): ActiveWorkspaceSelection => ({
    serverId,
    workspaceId,
  });

  it.each([
    {
      name: "next row",
      current: "first",
      targets: [target("first"), target("second"), target("third")],
      expected: target("second"),
    },
    {
      name: "previous row at the end",
      current: "third",
      targets: [target("first"), target("second"), target("third")],
      expected: target("second"),
    },
    {
      name: "another host",
      current: "first",
      targets: [target("first"), target("second", "server-2")],
      expected: target("second", "server-2"),
    },
    {
      name: "first visible row when selection is filtered out",
      current: "third",
      targets: [target("second"), target("first")],
      expected: target("second"),
    },
    {
      name: "past missing and archiving rows",
      current: "first",
      targets: [target("first"), target("missing"), target("archiving"), target("third")],
      expected: target("third"),
    },
  ])("selects $name", ({ current, targets, expected }) => {
    const { deps, routes, selections } = createFakeRouter(
      [
        workspace({ id: "third" }),
        workspace({ id: "second" }),
        workspace({ id: "first" }),
        workspace({ id: "archiving", archivingAt: "2026-09-14T00:00:00.000Z" }),
      ],
      targets,
    );
    expect(
      redirectIfArchivingActiveWorkspace(
        { ...target(current), activeWorkspaceSelection: target(current) },
        deps,
      ),
    ).toBe(true);
    expect(selections).toEqual([expected]);
    expect(routes).toEqual([]);
  });

  it("keeps the selection when another host has the same workspace id", () => {
    const { deps, routes, selections } = createFakeRouter(
      [workspace({ id: "first" })],
      [target("first")],
    );
    expect(
      redirectIfArchivingActiveWorkspace(
        { ...target("first"), activeWorkspaceSelection: target("first", "server-2") },
        deps,
      ),
    ).toBe(false);
    expect(selections).toEqual([]);
    expect(routes).toEqual([]);
  });

  it("opens the new workspace screen after the last available row", () => {
    const { deps, routes, selections } = createFakeRouter(
      [workspace({ id: "first" })],
      [target("first"), target("missing")],
    );
    redirectIfArchivingActiveWorkspace(
      { ...target("first"), activeWorkspaceSelection: target("first") },
      deps,
    );
    expect(selections).toEqual([]);
    expect(routes).toEqual(["/new?serverId=server-1&dir=%2Frepo&name=Project&projectId=project-1"]);
  });
});
