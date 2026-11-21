import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
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
  pinnedProjectKeys?: string[];
  collapsedProjectKeys?: string[];
  collapsedWorkspaceGroupKeys?: string[];
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
    pinnedProjectKeys: options?.pinnedProjectKeys ?? [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set(options?.collapsedProjectKeys ?? []),
    collapsedWorkspaceGroupKeys: new Set(options?.collapsedWorkspaceGroupKeys ?? []),
    t: i18n.t,
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
    pinnedProjectKeys: ["project"],
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
      for (const project of projection.pinnedGroups.pinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("keeps a workspace pin only in Pinned when its project is unpinned", () => {
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

  it("keeps an individually pinned workspace in both its pinned project and Pinned", () => {
    const projection = buildSidebarProjection(projectionInput({ pinnedProjectKeys: ["project"] }));

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    expect(
      projection.pinnedGroups.pinnedProjects[0]?.workspaces.map((entry) => entry.workspaceId),
    ).toEqual(["pinned", "unpinned"]);
  });

  it.each(["project", "status"] as const)(
    "keeps one shortcut target at the first visible occurrence in %s mode",
    (groupMode) => {
      const pinnedExpanded = buildSidebarProjection(
        projectionInput({ groupMode, pinnedProjectKeys: ["project"] }),
      );
      const pinnedCollapsed = buildSidebarProjection(
        projectionInput({
          groupMode,
          pinnedProjectKeys: ["project"],
          pinnedCollapsed: true,
        }),
      );
      const projectCollapsed = buildSidebarProjection(
        projectionInput({
          groupMode,
          pinnedProjectKeys: ["project"],
          collapsedProjectKeys: groupMode === "project" ? ["project"] : [],
          collapsedWorkspaceGroupKeys: groupMode === "status" ? ["pinned-project:project"] : [],
        }),
      );

      const bothWorkspaceTargets = [
        { serverId: "srv", workspaceId: "pinned" },
        { serverId: "srv", workspaceId: "unpinned" },
      ];
      expect(pinnedExpanded.shortcutModel.shortcutTargets).toEqual(bothWorkspaceTargets);
      expect(pinnedExpanded.shortcutModel.shortcutIndexByWorkspaceKey).toEqual(
        new Map([
          ["srv:pinned", 1],
          ["srv:unpinned", 2],
        ]),
      );
      expect(pinnedCollapsed.shortcutModel.shortcutTargets).toEqual(bothWorkspaceTargets);
      expect(projectCollapsed.shortcutModel.shortcutTargets).toEqual([
        { serverId: "srv", workspaceId: "pinned" },
      ]);
    },
  );

  it("orders pinned chats, pinned projects, and other projects in project mode", () => {
    const base = projectionInput({ pinnedProjectKeys: ["project"] });
    const other = makeWorkspace("other", "done", [], "other-project");
    const projection = buildSidebarProjection({
      ...base,
      projects: [...base.projects, makeProject([other.placement], "other-project")],
      workspaceEntriesByKey: new Map([
        ...base.workspaceEntriesByKey,
        [other.entry.workspaceKey, other.entry],
      ]),
      projectNamesByViewKey: new Map([
        ["project", "Project"],
        ["other-project", "Other project"],
      ]),
    });

    expect(projection.pinnedGroups.pinnedProjects.map((project) => project.viewKey)).toEqual([
      "project",
    ]);
    expect(projection.pinnedGroups.unpinnedProjects.map((project) => project.viewKey)).toEqual([
      "other-project",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
      { serverId: "srv", workspaceId: "other" },
    ]);
  });

  it("skips collapsed pinned projects in project shortcuts", () => {
    const base = projectionInput({
      pinnedProjectKeys: ["project"],
      collapsedProjectKeys: ["project"],
    });
    const projection = buildSidebarProjection(base);

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
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

  it("puts pinned project groups before status buckets and follows that order in shortcuts", () => {
    const base = projectionInput({ groupMode: "status", pinnedProjectKeys: ["project"] });
    const other = makeWorkspace("other", "done", [], "other-project");
    const projection = buildSidebarProjection({
      ...base,
      projects: [...base.projects, makeProject([other.placement], "other-project")],
      workspaceEntriesByKey: new Map([
        ...base.workspaceEntriesByKey,
        [other.entry.workspaceKey, other.entry],
      ]),
      projectNamesByViewKey: new Map([
        ["project", "Project"],
        ["other-project", "Other project"],
      ]),
    });

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual([
      "pinned-project:project",
      "done",
    ]);
    expect(projection.workspaceGroups[0]?.leading).toEqual({
      kind: "project",
      projectViewKey: "project",
    });
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
      "unpinned",
    ]);
    expect(projection.workspaceGroups[1]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "other",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
      { serverId: "srv", workspaceId: "other" },
    ]);
  });

  it("keeps pinned workspaces and pinned-project workspaces out of status buckets", () => {
    const base = projectionInput({ groupMode: "status", pinnedProjectKeys: ["project"] });
    const alsoPinned = makeWorkspace("also-pinned", "done", [], "other-project");
    const statusWorkspace = makeWorkspace("status", "done", [], "other-project");
    const pinnedWorkspaceKey = alsoPinned.entry.workspaceKey;
    const projection = buildSidebarProjection({
      ...base,
      projects: [
        ...base.projects,
        makeProject([alsoPinned.placement, statusWorkspace.placement], "other-project"),
      ],
      pinnedKeys: {
        pinnedWorkspaceKeys: [...base.pinnedKeys.pinnedWorkspaceKeys, pinnedWorkspaceKey],
        pinnedAtByKey: {
          ...base.pinnedKeys.pinnedAtByKey,
          [pinnedWorkspaceKey]: "2026-07-12T13:00:00.000Z",
        },
      },
      workspaceEntriesByKey: new Map([
        ...base.workspaceEntriesByKey,
        [alsoPinned.entry.workspaceKey, alsoPinned.entry],
        [statusWorkspace.entry.workspaceKey, statusWorkspace.entry],
      ]),
      projectNamesByViewKey: new Map([
        ["project", "Project"],
        ["other-project", "Other project"],
      ]),
    });

    const pinnedProjectGroup = projection.workspaceGroups.find(
      (group) => group.leading.kind === "project",
    );
    const statusGroups = projection.workspaceGroups.filter(
      (group) => group.leading.kind === "status",
    );
    const statusWorkspaceKeys: string[] = [];
    for (const group of statusGroups) {
      for (const entry of group.rows) {
        statusWorkspaceKeys.push(entry.workspaceKey);
      }
    }

    expect(pinnedProjectGroup?.rows.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
      "unpinned",
    ]);
    expect(statusWorkspaceKeys).toEqual([statusWorkspace.entry.workspaceKey]);
    expect(new Set(statusWorkspaceKeys).size).toBe(statusWorkspaceKeys.length);
    expect(statusWorkspaceKeys).not.toContain("srv:pinned");
    expect(statusWorkspaceKeys).not.toContain(pinnedWorkspaceKey);
  });

  it("drops collapsed pinned project rows from status shortcuts", () => {
    const base = projectionInput({
      groupMode: "status",
      pinnedProjectKeys: ["project"],
      collapsedWorkspaceGroupKeys: ["pinned-project:project"],
    });
    const projection = buildSidebarProjection(base);

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
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
