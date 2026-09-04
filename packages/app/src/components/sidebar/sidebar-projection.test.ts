import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection, mergeProjectGroupOrder } from "./sidebar-projection";

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
  group: string | null = null,
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    group,
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

function getProjectViewKey(project: SidebarProjectEntry): string {
  return project.viewKey;
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  const projects = [makeProject([pinned.placement, unpinned.placement])];
  return {
    projects,
    allProjects: projects,
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
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
    collapsedProjectGroupKeys: new Set<string>(),
    projectGroupOrder: [] as string[],
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
});

describe("buildSidebarProjection project groups", () => {
  it("partitions unpinned projects into sorted groups and an ungrouped tail", () => {
    const beta = makeWorkspace("beta-ws", "done", [], "beta-project");
    const alpha = makeWorkspace("alpha-ws", "done", [], "alpha-project");
    const solo = makeWorkspace("solo-ws", "done", [], "solo-project");
    const projection = buildSidebarProjection({
      ...projectionInput(),
      projects: [
        makeProject([beta.placement], "beta-project", "Beta"),
        makeProject([alpha.placement], "alpha-project", "Alpha"),
        makeProject([solo.placement], "solo-project", null),
      ],
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      workspaceEntriesByKey: new Map([
        [beta.entry.workspaceKey, beta.entry],
        [alpha.entry.workspaceKey, alpha.entry],
        [solo.entry.workspaceKey, solo.entry],
      ]),
    });

    expect(projection.projectGroups.map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    const groupProjectViewKeys = projection.projectGroups.map((group) =>
      group.projects.map(getProjectViewKey),
    );
    expect(groupProjectViewKeys).toEqual([["alpha-project"], ["beta-project"]]);
    expect(projection.ungroupedProjects.map((project) => project.viewKey)).toEqual([
      "solo-project",
    ]);
  });

  it("puts groups the stored order names first, in that order, and the rest after by name", () => {
    const workspaces = ["alpha", "beta", "gamma", "delta"].map((name) =>
      makeWorkspace(`${name}-ws`, "done", [], `${name}-project`),
    );
    const projection = buildSidebarProjection({
      ...projectionInput(),
      projects: workspaces.map((workspace, index) =>
        makeProject(
          [workspace.placement],
          workspace.placement.projectViewKey,
          ["Alpha", "Beta", "Gamma", "Delta"][index] ?? null,
        ),
      ),
      allProjects: workspaces.map((workspace, index) =>
        makeProject(
          [workspace.placement],
          workspace.placement.projectViewKey,
          ["Alpha", "Beta", "Gamma", "Delta"][index] ?? null,
        ),
      ),
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      workspaceEntriesByKey: new Map(
        workspaces.map((workspace) => [workspace.entry.workspaceKey, workspace.entry]),
      ),
      // "vanished" names no group and is skipped.
      projectGroupOrder: ["gamma", "vanished", "alpha"],
    });

    expect(projection.projectGroups.map((group) => group.name)).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
      "Delta",
    ]);
  });

  it("merges groups by case-insensitive name, keeping the first-seen casing as the display name", () => {
    const first = makeWorkspace("first-ws", "done", [], "first-project");
    const second = makeWorkspace("second-ws", "done", [], "second-project");
    const projection = buildSidebarProjection({
      ...projectionInput(),
      projects: [
        makeProject([first.placement], "first-project", "Client X"),
        makeProject([second.placement], "second-project", "client x"),
      ],
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      workspaceEntriesByKey: new Map([
        [first.entry.workspaceKey, first.entry],
        [second.entry.workspaceKey, second.entry],
      ]),
    });

    expect(projection.projectGroups).toHaveLength(1);
    expect(projection.projectGroups[0]?.name).toBe("Client X");
    expect(projection.projectGroups[0]?.projects.map((project) => project.viewKey)).toEqual([
      "first-project",
      "second-project",
    ]);
  });

  it("marks every project in a collapsed group collapsed in the shortcut model, regardless of its own state", () => {
    const grouped = makeWorkspace("grouped-ws", "done", [], "grouped-project");
    const solo = makeWorkspace("solo-ws", "done", [], "solo-project");
    const projection = buildSidebarProjection({
      ...projectionInput(),
      projects: [
        makeProject([grouped.placement], "grouped-project", "Client X"),
        makeProject([solo.placement], "solo-project", null),
      ],
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      workspaceEntriesByKey: new Map([
        [grouped.entry.workspaceKey, grouped.entry],
        [solo.entry.workspaceKey, solo.entry],
      ]),
      collapsedProjectGroupKeys: new Set(["client x"]),
    });

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "solo-ws" },
    ]);
  });
});

describe("mergeProjectGroupOrder", () => {
  it("stores the new order of groups that had none", () => {
    expect(
      mergeProjectGroupOrder({
        storedOrder: [],
        allKeys: ["alpha", "bravo"],
        visibleKeys: ["alpha", "bravo"],
        nextKeys: ["bravo", "alpha"],
      }),
    ).toEqual(["bravo", "alpha"]);
  });

  it("keeps a filtered-out group in its slot instead of pushing it to the end", () => {
    expect(
      mergeProjectGroupOrder({
        storedOrder: ["hidden", "alpha", "bravo"],
        allKeys: ["hidden", "alpha", "bravo"],
        visibleKeys: ["alpha", "bravo"],
        nextKeys: ["bravo", "alpha"],
      }),
    ).toEqual(["hidden", "bravo", "alpha"]);
  });

  it("keeps a filtered-out group that has no stored entry in its slot", () => {
    // Nothing was ever dragged, so the groups render alphabetically and Beta is hidden.
    expect(
      mergeProjectGroupOrder({
        storedOrder: [],
        allKeys: ["alpha", "beta", "charlie"],
        visibleKeys: ["alpha", "charlie"],
        nextKeys: ["charlie", "alpha"],
      }),
    ).toEqual(["charlie", "beta", "alpha"]);
  });

  it("gives a group with no stored entry a slot before moving it", () => {
    expect(
      mergeProjectGroupOrder({
        storedOrder: ["alpha"],
        allKeys: ["alpha", "bravo"],
        visibleKeys: ["alpha", "bravo"],
        nextKeys: ["bravo", "alpha"],
      }),
    ).toEqual(["bravo", "alpha"]);
  });

  it("leaves a group key that names no group alone", () => {
    expect(
      mergeProjectGroupOrder({
        storedOrder: ["gone", "alpha", "bravo"],
        allKeys: ["alpha", "bravo"],
        visibleKeys: ["alpha", "bravo"],
        nextKeys: ["bravo", "alpha"],
      }),
    ).toEqual(["gone", "bravo", "alpha"]);
  });
});
