import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";
import { sortSidebarProjects } from "@/hooks/sidebar-workspaces-view-model";

describe("recent workspace ordering", () => {
  it("retains structural references when sorting does not change the visible order", () => {
    const workspace = makeWorkspace("one");
    const projects = [makeProject([workspace.placement])];
    const entries = new Map([[workspace.entry.workspaceKey, workspace.entry]]);
    expect(
      sortSidebarProjects(projects, entries, { workspaces: "manual", projects: "manual" }),
    ).toBe(projects);
    expect(
      sortSidebarProjects(projects, entries, { workspaces: "recent", projects: "manual" })[0],
    ).toBe(projects[0]);
    expect(
      sortSidebarProjects(projects, entries, { workspaces: "manual", projects: "name" })[0]
        .workspaces,
    ).toBe(projects[0].workspaces);
  });

  it.each([
    { workspaces: "manual", projects: "manual" },
    { workspaces: "recent", projects: "manual" },
    { workspaces: "manual", projects: "recent" },
    { workspaces: "recent", projects: "recent" },
  ] as const)("sorts only the enabled levels: %j", (levels) => {
    const first = makeWorkspace("first");
    const second = makeWorkspace("second", "done", [], "second-project");
    const active = makeWorkspace("active", "done", [], "second-project");
    first.entry.lastStartedAt = new Date(10);
    second.entry.lastStartedAt = new Date(20);
    active.entry.lastStartedAt = new Date(30);
    const projects = [
      makeProject([first.placement]),
      makeProject([second.placement, active.placement], "second-project"),
    ];
    const entries = new Map(
      [first, second, active].map(({ entry }) => [entry.workspaceKey, entry]),
    );
    const result = sortSidebarProjects(projects, entries, levels);
    expect(result.map((project) => project.viewKey)).toEqual(
      levels.projects === "recent" ? ["second-project", "project"] : ["project", "second-project"],
    );
    expect(
      result
        .find((project) => project.viewKey === "second-project")!
        .workspaces.map((workspace) => workspace.workspaceId),
    ).toEqual(levels.workspaces === "recent" ? ["active", "second"] : ["second", "active"]);
    expect(projects[1].workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "second",
      "active",
    ]);
  });
  it("sorts projects and workspace names naturally and preserves equal-name order", () => {
    const z = makeWorkspace("Workspace 10");
    const a = makeWorkspace("workspace 2");
    const equal = makeWorkspace("WORKSPACE 2");
    const projects = [
      { ...makeProject([z.placement, a.placement, equal.placement]), projectName: "Project 10" },
      { ...makeProject([], "other"), projectName: "project 2" },
    ];
    const result = sortSidebarProjects(projects, new Map(), {
      workspaces: "name",
      projects: "name",
    });
    expect(result.map((p) => p.projectName)).toEqual(["project 2", "Project 10"]);
    expect(result[1].workspaces.map((w) => w.name)).toEqual([
      "workspace 2",
      "WORKSPACE 2",
      "Workspace 10",
    ]);
    expect(projects[0].workspaces[0].name).toBe("Workspace 10");
  });

  it("drops a finished agent only for the levels with running-first enabled", () => {
    const older = makeWorkspace("older");
    const latest = makeWorkspace("latest", "done", [], "latest-project");
    older.entry.lastStartedAt = new Date(10);
    older.entry.hasRunningAgent = true;
    latest.entry.lastStartedAt = new Date(20);
    latest.entry.hasRunningAgent = true;
    const projects = [
      makeProject([older.placement]),
      makeProject([latest.placement], "latest-project"),
    ];
    const entries = new Map([older, latest].map(({ entry }) => [entry.workspaceKey, entry]));
    const order = (runningFirst: boolean) =>
      sortSidebarProjects(projects, entries, {
        workspaces: "recent",
        projects: "recent",
        projectRunningFirst: runningFirst,
      }).map((p) => p.viewKey);
    expect(order(true)).toEqual(["latest-project", "project"]);
    latest.entry.hasRunningAgent = false;
    expect(order(true)).toEqual(["project", "latest-project"]);
    expect(order(false)).toEqual(["latest-project", "project"]);
    const sameProject = [makeProject([older.placement, latest.placement])];
    for (const workspaceRunningFirst of [false, true]) {
      const result = sortSidebarProjects(sameProject, entries, {
        workspaces: "recent",
        projects: "recent",
        workspaceRunningFirst,
        projectRunningFirst: !workspaceRunningFirst,
      });
      expect(result[0].workspaces.map((w) => w.name)).toEqual(
        workspaceRunningFirst ? ["older", "latest"] : ["latest", "older"],
      );
    }
    const empty = { ...latest.entry, lastStartedAt: null };
    expect(
      sortSidebarProjects(
        [makeProject([latest.placement, older.placement])],
        new Map([
          [empty.workspaceKey, empty],
          [older.entry.workspaceKey, older.entry],
        ]),
        { workspaces: "recent", projects: "manual" },
      )[0].workspaces[0].workspaceId,
    ).toBe("older");
  });

  it("moves recently active workspaces and their projects above older and unused ones", () => {
    const older = makeWorkspace("older");
    const recent = makeWorkspace("recent", "done", [], "other-project");
    const unused = makeWorkspace("unused", "done", [], "empty-project");
    const unusedSibling = makeWorkspace("unused-sibling", "done", [], "other-project");
    older.entry.lastStartedAt = new Date("2026-10-10T12:00:00Z");
    recent.entry.lastStartedAt = new Date("2026-10-14T12:00:00Z");
    const projects = [
      makeProject([unused.placement], "empty-project"),
      makeProject([older.placement]),
      makeProject([unusedSibling.placement, recent.placement], "other-project"),
    ];
    const entries = new Map(
      [older, recent, unused, unusedSibling].map(({ entry }) => [entry.workspaceKey, entry]),
    );
    const sorted = sortSidebarProjects(projects, entries, {
      workspaces: "recent",
      projects: "recent",
    });
    expect(sorted.map((project) => project.viewKey)).toEqual([
      "other-project",
      "project",
      "empty-project",
    ]);
    expect(sorted[0].workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "recent",
      "unused-sibling",
    ]);
    expect(projects[0].viewKey).toBe("empty-project");
  });

  it("keeps the existing order for equal or missing activity timestamps", () => {
    const first = makeWorkspace("first");
    const second = makeWorkspace("second");
    first.entry.lastStartedAt = new Date("2026-10-14T12:00:00Z");
    second.entry.lastStartedAt = new Date("2026-10-14T12:00:00Z");
    const entries = new Map([first, second].map(({ entry }) => [entry.workspaceKey, entry]));
    const sorted = sortSidebarProjects(
      [makeProject([second.placement, first.placement])],
      entries,
      { workspaces: "recent", projects: "recent" },
    );
    expect(sorted[0].workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "second",
      "first",
    ]);
    expect(
      sortSidebarProjects([makeProject([first.placement, second.placement])], new Map(), {
        workspaces: "recent",
        projects: "recent",
      })[0].workspaces,
    ).toEqual([first.placement, second.placement]);
  });
});

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
  groupMode?: "project" | "status" | "day";
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
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
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
  it.each(["project", "status"] as const)(
    "sorts pinned %s rows by hydrated names, not opaque ids",
    (groupMode) => {
      const first = makeWorkspace("aaa-id");
      const second = makeWorkspace("zzz-id");
      first.entry.name = "Workspace 10";
      second.entry.name = "Workspace 2";
      const projection = buildSidebarProjection({
        ...projectionInput({ groupMode }),
        sortMode: "name",
        projects: [makeProject([first.placement, second.placement])],
        pinnedKeys: {
          pinnedWorkspaceKeys: [first.entry.workspaceKey, second.entry.workspaceKey],
          pinnedAtByKey: {},
        },
        pinnedWorkspaceOrder: [first.entry.workspaceKey, second.entry.workspaceKey],
        workspaceEntriesByKey: new Map(
          [first, second].map(({ entry }) => [entry.workspaceKey, entry]),
        ),
      });
      expect(projection.pinnedGroups.pinnedChats.map((w) => w.workspaceId)).toEqual([
        "zzz-id",
        "aaa-id",
      ]);
      expect(projection.shortcutModel.shortcutTargets.map((w) => w.workspaceId)).toEqual([
        "zzz-id",
        "aaa-id",
      ]);
    },
  );

  it("restores manual status order independently of project order and status timestamps", () => {
    const first = makeWorkspace("first");
    const second = makeWorkspace("second");
    const urgent = makeWorkspace("urgent", "needs_input");
    first.entry.statusEnteredAt = new Date(30);
    second.entry.statusEnteredAt = new Date(10);
    const input = {
      ...projectionInput({ groupMode: "status" }),
      sortMode: "manual" as const,
      projects: [makeProject([first.placement, second.placement, urgent.placement])],
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      workspaceEntriesByKey: new Map(
        [first, second, urgent].map(({ entry }) => [entry.workspaceKey, entry]),
      ),
      workspaceOrderByStatus: { done: [second.entry.workspaceKey, first.entry.workspaceKey] },
    };
    const projection = buildSidebarProjection(input);
    expect(projection.workspaceGroups.map((g) => g.key)).toEqual(["needs_input", "done"]);
    expect(projection.workspaceGroups[1].rows.map((w) => w.workspaceId)).toEqual([
      "second",
      "first",
    ]);
    expect(projection.shortcutModel.shortcutTargets.map((w) => w.workspaceId)).toEqual([
      "urgent",
      "second",
      "first",
    ]);
    const collapsed = buildSidebarProjection({
      ...input,
      collapsedWorkspaceGroupKeys: new Set(["done"]),
    });
    expect(collapsed.shortcutModel.shortcutTargets.map((w) => w.workspaceId)).toEqual(["urgent"]);
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

describe("activity-day projection", () => {
  it("keeps pins separate, retains collapse, and aligns shortcuts with the visible groups", () => {
    const input = projectionInput({ groupMode: "day" });
    const result = buildSidebarProjection(input);
    expect(result.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual(["pinned"]);
    expect(result.workspaceGroups.map((group) => [group.key, workspaceIds(group.rows)])).toEqual([
      ["older", ["unpinned"]],
    ]);
    expect(
      result.shortcutModel.shortcutTargets.map((row) => `${row.serverId}:${row.workspaceId}`),
    ).toEqual(["srv:pinned", "srv:unpinned"]);
    const collapsed = buildSidebarProjection({
      ...input,
      collapsedWorkspaceGroupKeys: new Set(["older"]),
    });
    expect(
      collapsed.shortcutModel.shortcutTargets.map((row) => `${row.serverId}:${row.workspaceId}`),
    ).toEqual(["srv:pinned"]);
    expect(
      buildSidebarProjection({ ...input, workspaceEntriesByKey: new Map() }).workspaceGroups,
    ).toEqual([]);
  });
});

function workspaceIds(rows: readonly SidebarWorkspaceEntry[]): string[] {
  return rows.map((row) => row.workspaceId);
}
