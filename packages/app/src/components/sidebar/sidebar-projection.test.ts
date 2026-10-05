import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection, type SidebarProjectionInput } from "./sidebar-projection";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  isSidebarHostProjectOrder,
  sidebarHostGroupKey,
  sidebarHostProjectKey,
  type SidebarHostGroup,
} from "./sidebar-host-groups";
import { buildSidebarProjectRowModel } from "@/utils/sidebar-project-row-model";

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

function projectionInput(options?: { groupMode?: SidebarGroupMode; pinnedCollapsed?: boolean }) {
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
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: SidebarGroupMode) {
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

function sharedHostInput(): SidebarProjectionInput {
  const local = makeWorkspace("local");
  const remote = makeWorkspace("remote", "running", [], "project", "other");
  const project = makeProject([local.placement, remote.placement]);
  project.hosts.push({
    serverId: "other",
    projectId: "remote-project",
    iconWorkingDir: "/remote/project",
    worktreeSupport: "supported",
  });
  return {
    ...projectionInput({ groupMode: "host-project" }),
    projects: [project],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [local.entry.workspaceKey, local.entry],
      [remote.entry.workspaceKey, remote.entry],
    ]),
  };
}

function summarizeHostProject(project: SidebarProjectEntry) {
  return {
    viewKey: project.viewKey,
    hosts: project.hosts.map((placement) => placement.projectId),
    path: project.iconWorkingDir,
    workspaces: project.workspaces.map((workspace) => workspace.workspaceKey),
  };
}

function summarizeHostGroup(host: SidebarHostGroup) {
  return { serverId: host.serverId, projects: host.projects.map(summarizeHostProject) };
}

function projectWorkspaceKeys(project: SidebarProjectEntry) {
  return project.workspaces.map((workspace) => workspace.workspaceKey);
}

function hostWorkspaceKeys(host: SidebarHostGroup) {
  return host.projects.map(projectWorkspaceKeys);
}

function hostCreationActions(host: SidebarHostGroup) {
  return host.projects.map(
    (project) => buildSidebarProjectRowModel({ project, collapsed: false }).trailingAction,
  );
}

describe("isSidebarHostProjectOrder", () => {
  it("accepts a complete project reorder within one host", () => {
    const [host] = buildSidebarProjection(twoProjectInput("host-project")).hostGroups;
    if (!host) throw new Error("Expected a host with two projects");
    expect(isSidebarHostProjectOrder(host, host.projects.toReversed())).toBe(true);
  });

  it("rejects a project from another host even when its canonical project key matches", () => {
    const [primary, secondary] = buildSidebarProjection(sharedHostInput()).hostGroups;
    if (!primary || !secondary) throw new Error("Expected both hosts");
    expect(primary.projects[0]?.viewKey).toEqual(secondary.projects[0]?.viewKey);
    expect(isSidebarHostProjectOrder(primary, secondary.projects)).toBe(false);
    expect(isSidebarHostProjectOrder(secondary, primary.projects)).toBe(false);
  });

  it("rejects a project reorder with missing or duplicate projects", () => {
    const [host] = buildSidebarProjection(twoProjectInput("host-project")).hostGroups;
    const first = host?.projects[0];
    if (!host || !first) throw new Error("Expected a host with two projects");
    expect(isSidebarHostProjectOrder(host, [first])).toBe(false);
    expect(isSidebarHostProjectOrder(host, [first, first])).toBe(false);
  });
});

describe("buildSidebarProjection", () => {
  it("shows a shared project separately on each host, with only that host's workspaces and actions", () => {
    const projection = buildSidebarProjection(sharedHostInput());
    expect(projection.hostGroups.map(summarizeHostGroup)).toEqual([
      {
        serverId: "srv",
        projects: [
          {
            viewKey: "project",
            hosts: ["project"],
            path: "/repo/project",
            workspaces: ["srv:local"],
          },
        ],
      },
      {
        serverId: "other",
        projects: [
          {
            viewKey: "project",
            hosts: ["remote-project"],
            path: "/remote/project",
            workspaces: ["other:remote"],
          },
        ],
      },
    ]);
    expect(projection.hostGroups[0]?.projects[0]?.sectionKey).not.toEqual(
      projection.hostGroups[1]?.projects[0]?.sectionKey,
    );
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "local" },
      { serverId: "other", workspaceId: "remote" },
    ]);
  });

  it("collapses a host or its project without hiding the equivalent project on another host", () => {
    const projectCollapsed = buildSidebarProjection({
      ...sharedHostInput(),
      collapsedProjectKeys: new Set([sidebarHostProjectKey("srv", "project")]),
    });
    expect(projectCollapsed.shortcutModel.shortcutTargets).toEqual([
      { serverId: "other", workspaceId: "remote" },
    ]);

    const hostCollapsed = buildSidebarProjection({
      ...sharedHostInput(),
      collapsedWorkspaceGroupKeys: new Set([sidebarHostGroupKey("other")]),
    });
    expect(hostCollapsed.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "local" },
    ]);
  });

  it("keeps globally pinned workspaces and a host's empty project with its own creation action", () => {
    const projection = buildSidebarProjection({
      ...sharedHostInput(),
      pinnedKeys: {
        pinnedWorkspaceKeys: ["srv:local"],
        pinnedAtByKey: { "srv:local": "2026-09-28T12:00:00.000Z" },
      },
    });
    expect(projection.pinnedGroups.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "srv:local",
    ]);
    expect(projection.hostGroups.map(hostWorkspaceKeys)).toEqual([[[]], [["other:remote"]]]);
    expect(projection.hostGroups.map(hostCreationActions)).toEqual([
      [
        {
          kind: "new_workspace",
          target: expect.objectContaining({ serverId: "srv", projectId: "project" }),
        },
      ],
      [
        {
          kind: "new_workspace",
          target: expect.objectContaining({ serverId: "other", projectId: "remote-project" }),
        },
      ],
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "local" },
      { serverId: "other", workspaceId: "remote" },
    ]);
  });

  it("uses saved host, project and workspace order for the rows and their shortcuts", () => {
    const input = sharedHostInput();
    const extra = makeWorkspace("extra", "done", [], "extra-project");
    const second = makeWorkspace("second");
    input.projects[0]?.workspaces.push(second.placement);
    input.projects.push(makeProject([extra.placement], "extra-project"));
    const projection = buildSidebarProjection({
      ...input,
      hostOrder: ["other", "srv"],
      projectOrder: [
        sidebarHostProjectKey("srv", "extra-project"),
        sidebarHostProjectKey("srv", "project"),
      ],
      workspaceOrderByProject: {
        [sidebarHostProjectKey("srv", "project")]: ["srv:second", "srv:local"],
      },
    });
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "other", workspaceId: "remote" },
      { serverId: "srv", workspaceId: "extra" },
      { serverId: "srv", workspaceId: "second" },
      { serverId: "srv", workspaceId: "local" },
    ]);
    const iconHostByViewKey = new Map(
      projection.projectIconTargets.map((target) => [target.projectViewKey, target.serverId]),
    );
    expect(
      projection.hostGroups
        .flatMap((host) => host.projects)
        .map((project) => iconHostByViewKey.get(project.sectionKey)),
    ).toEqual(["other", "srv", "srv"]);
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
