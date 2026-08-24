import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
  encodeLogicalWorkspaceRefLabel,
} from "@getpaseo/protocol/workspace-labels";
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

  it("keeps managed physical pins inside one logical project row without mutating pin data", () => {
    const input = projectionInput();
    const refLabel = encodeLogicalWorkspaceRefLabel("project-a-catalog");
    const pinnedEntry = input.workspaceEntriesByKey.get("srv:pinned");
    const unpinnedEntry = input.workspaceEntriesByKey.get("srv:unpinned");
    if (!pinnedEntry || !unpinnedEntry) throw new Error("fixture entries missing");
    const workspaceEntriesByKey = new Map([
      [
        pinnedEntry.workspaceKey,
        { ...pinnedEntry, labels: [refLabel, DEFAULT_WORKSPACE_PLACEMENT_LABEL] },
      ],
      [unpinnedEntry.workspaceKey, { ...unpinnedEntry, labels: [refLabel] }],
    ]);

    const projection = buildSidebarProjection({
      ...input,
      workspaceEntriesByKey,
      logicalWorkspaceGroupings: [
        {
          key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
          logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
          defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
        },
      ],
      activeWorkspaceSelection: null,
    });

    expect(projection.pinnedGroups.pinnedChats).toEqual([]);
    expect(projection.pinnedGroups.unpinnedProjects[0]?.workspaces).toHaveLength(2);
    expect(projection.projectWorkspaceRowsByViewKey.get("project")).toMatchObject([
      {
        kind: "logical",
        logicalWorkspaceRef: "project-a-catalog",
        placements: [
          { workspaceKey: "srv:pinned", workspaceId: "pinned" },
          { workspaceKey: "srv:unpinned", workspaceId: "unpinned" },
        ],
        targetPlacement: { workspaceKey: "srv:pinned", workspaceId: "pinned" },
      },
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
    ]);
    expect(input.pinnedKeys.pinnedWorkspaceKeys).toEqual(["srv:pinned"]);
    expect(pinnedEntry.pinnedAt).toBeUndefined();
  });

  it("hides a bound retained agent source from pinned and Status rows", () => {
    const input = projectionInput({ groupMode: "status" });
    const retainedEntry = input.workspaceEntriesByKey.get("srv:pinned");
    const liveEntry = input.workspaceEntriesByKey.get("srv:unpinned");
    if (!retainedEntry || !liveEntry) throw new Error("fixture entries missing");
    const refLabel = encodeLogicalWorkspaceRefLabel("project-a-catalog");

    const projection = buildSidebarProjection({
      ...input,
      workspaceEntriesByKey: new Map([
        [retainedEntry.workspaceKey, retainedEntry],
        [liveEntry.workspaceKey, { ...liveEntry, labels: [refLabel] }],
      ]),
      logicalWorkspaceGroupings: [
        {
          key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
          logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
          defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
          retainedHistoryBindings: [
            {
              serverId: "srv",
              workspaceId: retainedEntry.workspaceId,
              physicalWorkspaceRef: "project-a-catalog-host-b",
              logicalWorkspaceRef: "project-a-catalog",
            },
          ],
        },
      ],
    });

    expect(projection.pinnedGroups.pinnedChats).toEqual([]);
    expect(
      projection.workspaceGroups.flatMap((group) => group.rows).map((row) => row.workspaceId),
    ).toEqual([liveEntry.workspaceId]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: liveEntry.serverId, workspaceId: liveEntry.workspaceId },
    ]);
  });

  it("reattaches retained history after a user-label filter keeps only the live placement", () => {
    const input = projectionInput();
    const retainedEntry = input.workspaceEntriesByKey.get("srv:pinned");
    const liveEntry = input.workspaceEntriesByKey.get("srv:unpinned");
    if (!retainedEntry || !liveEntry) throw new Error("fixture entries missing");
    const refLabel = encodeLogicalWorkspaceRefLabel("project-a-catalog");
    const managedLiveEntry = { ...liveEntry, labels: [refLabel] };
    const inventoryEntries = new Map([
      [retainedEntry.workspaceKey, retainedEntry],
      [managedLiveEntry.workspaceKey, managedLiveEntry],
    ]);
    const logicalWorkspaceGroupings = [
      {
        key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
        logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
        defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
        retainedHistoryBindings: [
          {
            serverId: "srv",
            workspaceId: retainedEntry.workspaceId,
            physicalWorkspaceRef: "project-a-catalog-host-b",
            logicalWorkspaceRef: "project-a-catalog",
          },
        ],
      },
    ];

    const projection = buildSidebarProjection({
      ...input,
      projects: [makeProject([managedLiveEntry])],
      workspaceEntriesByKey: new Map([[managedLiveEntry.workspaceKey, managedLiveEntry]]),
      inventoryProjects: input.projects,
      inventoryWorkspaceEntriesByKey: inventoryEntries,
      logicalWorkspaceGroupings,
      activeWorkspaceSelection: null,
    });

    expect(projection.projectWorkspaceRowsByViewKey.get("project")).toMatchObject([
      {
        kind: "logical",
        logicalWorkspaceRef: "project-a-catalog",
        placements: [{ workspaceId: liveEntry.workspaceId }],
        retainedAgentSources: [{ workspaceId: retainedEntry.workspaceId }],
      },
    ]);
    expect(projection.pinnedGroups.pinnedChats).toEqual([]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: liveEntry.serverId, workspaceId: liveEntry.workspaceId },
    ]);
  });

  it("does not let a retained-only label match reappear in Pinned, Status, or shortcuts", () => {
    const input = projectionInput({ groupMode: "status" });
    const retainedEntry = input.workspaceEntriesByKey.get("srv:pinned");
    const liveEntry = input.workspaceEntriesByKey.get("srv:unpinned");
    if (!retainedEntry || !liveEntry) throw new Error("fixture entries missing");
    const refLabel = encodeLogicalWorkspaceRefLabel("project-a-catalog");
    const managedLiveEntry = { ...liveEntry, labels: [refLabel] };
    const inventoryEntries = new Map([
      [retainedEntry.workspaceKey, retainedEntry],
      [managedLiveEntry.workspaceKey, managedLiveEntry],
    ]);

    const projection = buildSidebarProjection({
      ...input,
      projects: [makeProject([retainedEntry])],
      workspaceEntriesByKey: new Map([[retainedEntry.workspaceKey, retainedEntry]]),
      inventoryProjects: input.projects,
      inventoryWorkspaceEntriesByKey: inventoryEntries,
      logicalWorkspaceGroupings: [
        {
          key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
          logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
          defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
          retainedHistoryBindings: [
            {
              serverId: "srv",
              workspaceId: retainedEntry.workspaceId,
              physicalWorkspaceRef: "project-a-catalog-host-b",
              logicalWorkspaceRef: "project-a-catalog",
            },
          ],
        },
      ],
    });

    expect(projection.visibleProjects).toEqual([]);
    expect(projection.pinnedGroups.pinnedChats).toEqual([]);
    expect(projection.workspaceGroups).toEqual([]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([]);
  });
});
