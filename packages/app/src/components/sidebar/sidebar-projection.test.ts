import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import { buildSidebarProjection } from "./sidebar-projection";

function projectWorkspaceIds(projects: readonly SidebarProjectEntry[]): string[] {
  return projects.flatMap((project) =>
    project.workspaces.map((workspace) => workspace.workspaceId),
  );
}

function groupKeys(groups: readonly SidebarWorkspaceGroup[]): string[] {
  return groups.map((group) => group.key);
}

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
  serverId = "srv",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `${serverId}:${id}`,
    serverId,
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
  serverId = "srv",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId,
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    hostLabelsByServerId: new Map([["srv", "Server"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("leaves a single-host sidebar unsectioned", () => {
    expect(buildSidebarProjection(projectionInput()).hostSections).toEqual([]);
    expect(buildSidebarProjection(projectionInput({ groupMode: "status" })).hostSections).toEqual(
      [],
    );
  });

  it("always renders one host section per host, ordered by label", () => {
    const local = makeWorkspace("local", "done", [], "project", "local-host");
    const remote = makeWorkspace("remote", "done", [], "project", "remote-host");
    const projection = buildSidebarProjection({
      ...projectionInput(),
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      projects: [
        makeProject([local.placement], "project", "local-host"),
        makeProject([remote.placement], "project", "remote-host"),
      ],
      workspaceEntriesByKey: new Map([
        [local.entry.workspaceKey, local.entry],
        [remote.entry.workspaceKey, remote.entry],
      ]),
      hostLabelsByServerId: new Map([
        ["local-host", "Laptop"],
        ["remote-host", "Workstation"],
      ]),
    });

    expect(projection.hostSections.map((section) => section.label)).toEqual([
      "Laptop",
      "Workstation",
    ]);
    expect(projection.hostSections.map((section) => projectWorkspaceIds(section.projects))).toEqual(
      [["local"], ["remote"]],
    );
  });

  it("carries the status grouping inside each host section", () => {
    const local = makeWorkspace("local", "running", [], "project", "local-host");
    const remote = makeWorkspace("remote", "failed", [], "project", "remote-host");
    const projection = buildSidebarProjection({
      ...projectionInput({ groupMode: "status" }),
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      projects: [
        makeProject([local.placement], "project", "local-host"),
        makeProject([remote.placement], "project", "remote-host"),
      ],
      workspaceEntriesByKey: new Map([
        [local.entry.workspaceKey, local.entry],
        [remote.entry.workspaceKey, remote.entry],
      ]),
      hostLabelsByServerId: new Map([
        ["local-host", "Laptop"],
        ["remote-host", "Workstation"],
      ]),
    });

    expect(
      projection.hostSections.map((section) => ({
        label: section.label,
        buckets: groupKeys(section.workspaceGroups),
      })),
    ).toEqual([
      { label: "Laptop", buckets: ["running"] },
      { label: "Workstation", buckets: ["failed"] },
    ]);
  });
});
