import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  filterSidebarProjects,
  arrangeSidebarProjects,
  sortSidebarProjectsByName,
} from "./sidebar-arrangement";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
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
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
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
    workspaceSortMode: options?.groupMode === "status" ? ("status" as const) : ("custom" as const),
    workspaceTitleSource: "title" as const,
    statusWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
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
    pinnedKeys: { pinnedWorkspaceKeys: [] as string[], pinnedAtByKey: {} },
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
  it("sorts workspace rows without changing pins, groups, or saved custom order", () => {
    const input = projectionInput();
    const zeta = makeWorkspace("Zeta", "done");
    const alpha = makeWorkspace("Alpha", "running");
    input.projects[0].workspaces.push(zeta.placement, alpha.placement);
    input.workspaceEntriesByKey.set(zeta.entry.workspaceKey, zeta.entry);
    input.workspaceEntriesByKey.set(alpha.entry.workspaceKey, alpha.entry);
    const named = buildSidebarProjection({ ...input, workspaceSortMode: "name" });
    expect(named.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "Alpha",
      "unpinned",
      "Zeta",
    ]);
    expect(named.pinnedGroups.pinnedChats.map((row) => row.name)).toEqual(["pinned"]);
    const status = buildSidebarProjection({ ...input, workspaceSortMode: "status" });
    expect(status.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "unpinned",
      "Alpha",
      "Zeta",
    ]);
    const custom = buildSidebarProjection({ ...input, workspaceSortMode: "custom" });
    expect(custom.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "unpinned",
      "Zeta",
      "Alpha",
    ]);
    expect(input.projects[0].workspaces.map((row) => row.name)).toEqual([
      "pinned",
      "unpinned",
      "Zeta",
      "Alpha",
    ]);
    zeta.entry.title = "Aardvark";
    const renamed = buildSidebarProjection({ ...input, workspaceSortMode: "name" });
    expect(renamed.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "Alpha",
      "unpinned",
      "Zeta",
    ]);
    expect([...renamed.shortcutModel.shortcutIndexByWorkspaceKey.keys()]).toEqual([
      "srv:pinned",
      "srv:Alpha",
      "srv:unpinned",
      "srv:Zeta",
    ]);
  });

  for (const groupMode of ["project", "status"] as const) {
    it(`sorts by visible branches with name fallback in ${groupMode} grouping`, () => {
      const alpha = makeWorkspace("Alpha");
      const zeta = makeWorkspace("Zeta");
      const fallback = makeWorkspace("Middle");
      alpha.entry.currentBranch = "zeta-branch";
      zeta.entry.currentBranch = "alpha-branch";
      zeta.entry.title = "Hidden title";
      const workspaces = [alpha, fallback, zeta];
      const projection = buildSidebarProjection({
        ...projectionInput({ groupMode }),
        projects: [makeProject(workspaces.map((workspace) => workspace.placement))],
        workspaceEntriesByKey: new Map(workspaces.map(({ entry }) => [entry.workspaceKey, entry])),
        workspaceSortMode: "name",
        workspaceTitleSource: "branch",
      });
      expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
        "Zeta",
        "Middle",
        "Alpha",
      ]);
    });
  }

  it("sorts within status groups and restores custom order across projects", () => {
    const input = twoProjectInput("status");
    const zeta = makeWorkspace("Zeta", "running", [], "other-project");
    const alpha = makeWorkspace("Alpha", "running");
    input.projects[0].workspaces.push(alpha.placement);
    input.projects[1].workspaces.push(zeta.placement);
    input.workspaceEntriesByKey.set(zeta.entry.workspaceKey, zeta.entry);
    input.workspaceEntriesByKey.set(alpha.entry.workspaceKey, alpha.entry);
    const named = buildSidebarProjection({ ...input, workspaceSortMode: "name" });
    expect(named.workspaceGroups.map((group) => group.key)).toEqual(["needs_input", "running"]);
    expect(named.workspaceGroups[1].rows.map((row) => row.name)).toEqual([
      "Alpha",
      "first",
      "Zeta",
    ]);
    const custom = buildSidebarProjection({
      ...input,
      workspaceSortMode: "custom",
      statusWorkspaceOrder: ["srv:Zeta", "srv:first", "srv:Alpha"],
    });
    expect(custom.workspaceGroups[1].rows.map((row) => row.name)).toEqual([
      "Zeta",
      "first",
      "Alpha",
    ]);
  });

  it("filters projects by unarchived workspace membership before splitting pins", () => {
    const input = projectionInput();
    const empty = makeProject([], "empty");
    input.projects.push(empty);
    for (const groupMode of ["project", "status"] as const) {
      const projects = filterSidebarProjects(input.projects, "unarchived");
      const projection = buildSidebarProjection({ ...input, projects, groupMode });
      expect(projects.map((project) => project.viewKey)).toEqual(["project"]);
      expect(projection.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual(["pinned"]);
    }
    expect(filterSidebarProjects(input.projects, "all").map((project) => project.viewKey)).toEqual([
      "project",
      "empty",
    ]);
  });

  it("keeps empty projects available in status mode without treating all-pinned projects as empty", () => {
    const input = projectionInput({ groupMode: "status" });
    input.projects = [makeProject([input.projects[0]!.workspaces[0]!]), makeProject([], "empty")];
    const projection = buildSidebarProjection(input);
    const emptyProjects = input.projects.filter((project) => project.workspaces.length === 0);
    expect(emptyProjects.map((project) => project.viewKey)).toEqual(["empty"]);
    expect(projection.projectIconTargets.map((target) => target.projectViewKey)).toEqual([
      "project",
      "empty",
    ]);
  });

  it("alphabetizes empty project headers while retaining their custom order and stable ties", () => {
    const zeta = { ...makeProject([], "zeta"), projectName: "Zeta" };
    const alpha = { ...makeProject([], "alpha"), projectName: "Alpha" };
    const alphaOtherHost = { ...makeProject([], "alpha-other-host"), projectName: "Alpha" };
    const emptyProjects = [zeta, alpha, alphaOtherHost];
    expect(sortSidebarProjectsByName({ projects: emptyProjects })).toEqual([
      alpha,
      alphaOtherHost,
      zeta,
    ]);
    expect(emptyProjects).toEqual([zeta, alpha, alphaOtherHost]);
  });

  it("sorts project headers by name without changing their workspace order", () => {
    const input = twoProjectInput("project");
    const extra = makeWorkspace("extra", "needs_input");
    input.projects[0]!.workspaces.push(extra.placement);
    input.workspaceEntriesByKey.set(extra.entry.workspaceKey, extra.entry);
    const projects = arrangeSidebarProjects({
      projects: input.projects,
      mode: "project",
      entries: input.workspaceEntriesByKey,
      projectNames: input.projectNamesByViewKey,
    });
    expect(projects.map((project) => project.viewKey)).toEqual(["other-project", "project"]);
    expect(projects[1]).toBe(input.projects[0]);
    expect(projects[1]!.workspaces.map((row) => row.workspaceId)).toEqual(["first", "extra"]);
    const projection = buildSidebarProjection({ ...input, projects });
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "second",
      "first",
      "extra",
    ]);
    expect(input.projects.map((project) => project.viewKey)).toEqual(["project", "other-project"]);
  });

  it("sorts projects by aggregate status, including pinned workspaces, and keeps ties stable", () => {
    const input = twoProjectInput("project");
    const urgent = makeWorkspace("urgent", "needs_input");
    input.projects[0]!.workspaces.push(urgent.placement);
    input.workspaceEntriesByKey.set(urgent.entry.workspaceKey, urgent.entry);
    input.pinnedKeys = { pinnedWorkspaceKeys: [urgent.placement.workspaceKey], pinnedAtByKey: {} };
    input.projects.push(makeProject([], "empty"));
    const projects = arrangeSidebarProjects({
      projects: input.projects,
      mode: "status",
      entries: input.workspaceEntriesByKey,
      projectNames: input.projectNamesByViewKey,
    });
    expect(projects.map((project) => project.viewKey)).toEqual([
      "project",
      "other-project",
      "empty",
    ]);
    expect(projects[0]!.workspaces.map((row) => row.workspaceId)).toEqual(["first", "urgent"]);
    input.workspaceEntriesByKey.get("srv:urgent")!.statusBucket = "done";
    expect(
      arrangeSidebarProjects({
        projects: input.projects,
        mode: "status",
        entries: input.workspaceEntriesByKey,
        projectNames: input.projectNamesByViewKey,
      }).map((project) => project.viewKey),
    ).toEqual(["other-project", "project", "empty"]);
    expect(
      arrangeSidebarProjects({
        projects: input.projects,
        mode: "custom",
        entries: input.workspaceEntriesByKey,
        projectNames: input.projectNamesByViewKey,
      }),
    ).toBe(input.projects);
  });

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
});
