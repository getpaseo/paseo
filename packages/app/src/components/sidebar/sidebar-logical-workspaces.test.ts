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
import {
  buildSidebarLogicalWorkspaceProjection,
  sidebarStatusPlacementsFromRows,
  type SidebarLogicalWorkspaceGrouping,
  type SidebarProjectLogicalWorkspaceRow,
} from "./sidebar-logical-workspaces";

const GROUPING: SidebarLogicalWorkspaceGrouping = {
  key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
  logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
  defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
};

function placement(input: {
  id: string;
  serverId?: string;
  projectViewKey?: string;
  name?: string;
}): SidebarWorkspacePlacement {
  const serverId = input.serverId ?? "host-a";
  const projectViewKey = input.projectViewKey ?? "project-a";
  return {
    workspaceKey: `${serverId}:${input.id}`,
    serverId,
    workspaceId: input.id,
    projectViewKey,
    projectName: projectViewKey,
    projectRootPath: `/projects/${projectViewKey}`,
    workspaceDirectory: `/projects/${input.id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.name ?? input.id,
  };
}

function entry(
  value: SidebarWorkspacePlacement,
  input: {
    ref?: string;
    labels?: string[];
    isDefault?: boolean;
    title?: string | null;
    status?: SidebarWorkspaceEntry["statusBucket"];
    statusEnteredAt?: string | null;
  } = {},
): SidebarWorkspaceEntry {
  const labels = [
    ...(input.labels ?? []),
    ...(input.ref ? [encodeLogicalWorkspaceRefLabel(input.ref)] : []),
    ...(input.isDefault ? [DEFAULT_WORKSPACE_PLACEMENT_LABEL] : []),
  ];
  return {
    ...value,
    workspaceDirectory: value.workspaceDirectory ?? `/projects/${value.workspaceId}`,
    workspaceDirectoryLabel: value.workspaceId,
    title: input.title ?? null,
    pinnedAt: null,
    labels,
    currentBranch: "main",
    statusBucket: input.status ?? "done",
    statusEnteredAt: input.statusEnteredAt ? new Date(input.statusEnteredAt) : null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function project(viewKey: string, workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  const hosts = [...new Set(workspaces.map((workspace) => workspace.serverId))].map((serverId) => ({
    serverId,
    projectId: `${viewKey}-${serverId}`,
    iconWorkingDir: `/projects/${viewKey}`,
    worktreeSupport: "supported" as const,
  }));
  return {
    viewKey,
    projectName: viewKey,
    projectKind: "git",
    iconWorkingDir: `/projects/${viewKey}`,
    hosts,
    workspaces,
  };
}

function fixtureServerId(physicalRef: string, index: number): string {
  return `${physicalRef.split("-")[0]}-host-${index + 1}`;
}

function logicalRows(
  rows: readonly (SidebarProjectLogicalWorkspaceRow | { kind: "physical" })[] | undefined,
): SidebarProjectLogicalWorkspaceRow[] {
  return (rows ?? []).filter(
    (row): row is SidebarProjectLogicalWorkspaceRow => row.kind === "logical",
  );
}

describe("logical workspace sidebar projection", () => {
  it("fails open to the exact native rows when the plugin contribution is absent", () => {
    const first = placement({ id: "first" });
    const second = placement({ id: "second" });
    const nativeProject = project("project-a", [first, second]);
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [nativeProject],
      workspaceEntriesByKey: new Map([
        [first.workspaceKey, entry(first, { ref: "project-a-catalog" })],
        [second.workspaceKey, entry(second, { ref: "project-a-catalog" })],
      ]),
      groupings: [],
      activeWorkspaceSelection: null,
    });

    const rows = projection.rowsByProjectViewKey.get("project-a");
    expect(rows).toEqual([
      { kind: "physical", key: first.workspaceKey, placement: first },
      { kind: "physical", key: second.workspaceKey, placement: second },
    ]);
    expect(projection.managedWorkspaceKeys).toEqual(new Set());
  });

  it("groups only inside each native projectKey projection", () => {
    const projectA = placement({ id: "project-a", projectViewKey: "project-a" });
    const projectB = placement({ id: "project-b", projectViewKey: "project-b" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [projectA]), project("project-b", [projectB])],
      workspaceEntriesByKey: new Map([
        [projectA.workspaceKey, entry(projectA, { ref: "shared-ref" })],
        [projectB.workspaceKey, entry(projectB, { ref: "shared-ref" })],
      ]),
      groupings: [GROUPING],
      activeWorkspaceSelection: null,
    });

    expect(logicalRows(projection.rowsByProjectViewKey.get("project-a"))).toHaveLength(1);
    expect(logicalRows(projection.rowsByProjectViewKey.get("project-b"))).toHaveLength(1);
    expect(
      logicalRows(projection.rowsByProjectViewKey.get("project-a"))[0]?.placements.map(
        (item) => item.workspaceKey,
      ),
    ).toEqual([projectA.workspaceKey]);
    expect(
      logicalRows(projection.rowsByProjectViewKey.get("project-b"))[0]?.placements.map(
        (item) => item.workspaceKey,
      ),
    ).toEqual([projectB.workspaceKey]);
  });

  it("carries the contributing plugin host namespace onto the logical row", () => {
    const member = placement({ id: "member", serverId: "host-a" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [member])],
      workspaceEntriesByKey: new Map([
        [member.workspaceKey, entry(member, { ref: "project-a-catalog" })],
      ]),
      groupings: [{ ...GROUPING, serverIds: ["host-a", "host-b"] }],
      activeWorkspaceSelection: null,
    });

    expect(
      logicalRows(projection.rowsByProjectViewKey.get("project-a"))[0]?.groupingServerIds,
    ).toEqual(["host-a", "host-b"]);
  });

  it("applies a host contribution only to native workspaces on that installed host", () => {
    const mac = placement({ id: "mac", serverId: "host-a" });
    const remote = placement({ id: "remote", serverId: "host-b" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [mac, remote])],
      workspaceEntriesByKey: new Map([
        [mac.workspaceKey, entry(mac, { ref: "project-a-catalog" })],
        [remote.workspaceKey, entry(remote, { ref: "project-a-catalog" })],
      ]),
      groupings: [{ ...GROUPING, serverIds: ["host-b"] }],
      activeWorkspaceSelection: null,
    });

    expect(projection.rowsByProjectViewKey.get("project-a")).toMatchObject([
      { kind: "physical", placement: { workspaceId: "mac" } },
      { kind: "logical", placements: [{ workspaceId: "remote" }] },
    ]);
  });

  it("keeps disjoint contribution namespaces active at the same time", () => {
    const mac = placement({ id: "mac", serverId: "host-a" });
    const remote = placement({ id: "remote", serverId: "host-b" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [mac, remote])],
      workspaceEntriesByKey: new Map([
        [mac.workspaceKey, entry(mac, { ref: "project-a-catalog" })],
        [remote.workspaceKey, entry(remote, { ref: "project-a-catalog" })],
      ]),
      groupings: [
        { ...GROUPING, key: "layout-a/grouping/main", serverIds: ["host-a"] },
        { ...GROUPING, key: "layout-b/grouping/main", serverIds: ["host-b"] },
      ],
      activeWorkspaceSelection: null,
    });

    expect(logicalRows(projection.rowsByProjectViewKey.get("project-a"))).toMatchObject([
      { groupingKey: "layout-a/grouping/main", placements: [{ workspaceId: "mac" }] },
      { groupingKey: "layout-b/grouping/main", placements: [{ workspaceId: "remote" }] },
    ]);
  });

  it("fails open only the native identity claimed by two grouping namespaces", () => {
    const mac = placement({ id: "mac", serverId: "host-a" });
    const remote = placement({ id: "remote", serverId: "host-b" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [mac, remote])],
      workspaceEntriesByKey: new Map([
        [mac.workspaceKey, entry(mac, { ref: "project-a-catalog" })],
        [remote.workspaceKey, entry(remote, { ref: "project-a-catalog" })],
      ]),
      groupings: [
        {
          ...GROUPING,
          key: "layout-a/grouping/main",
          serverIds: ["host-a", "host-b"],
        },
        { ...GROUPING, key: "layout-b/grouping/main", serverIds: ["host-a"] },
      ],
      activeWorkspaceSelection: null,
    });

    expect(projection.rowsByProjectViewKey.get("project-a")).toMatchObject([
      { kind: "physical", placement: { workspaceId: "mac" } },
      {
        kind: "logical",
        groupingKey: "layout-a/grouping/main",
        placements: [{ workspaceId: "remote" }],
      },
    ]);
  });

  it("chooses active, then default, then the deterministic newest remainder", () => {
    const olderDefault = placement({ id: "a-default", serverId: "host-a" });
    const newerActive = placement({ id: "b-active", serverId: "host-b" });
    const entries = new Map([
      [
        olderDefault.workspaceKey,
        entry(olderDefault, {
          ref: "project-a-catalog",
          isDefault: true,
          statusEnteredAt: "2026-08-20T10:00:00.000Z",
        }),
      ],
      [
        newerActive.workspaceKey,
        entry(newerActive, {
          ref: "project-a-catalog",
          statusEnteredAt: "2026-08-21T10:00:00.000Z",
        }),
      ],
    ]);
    const nativeProject = project("project-a", [olderDefault, newerActive]);
    const build = (activeWorkspaceSelection: { serverId: string; workspaceId: string } | null) =>
      logicalRows(
        buildSidebarLogicalWorkspaceProjection({
          projects: [nativeProject],
          workspaceEntriesByKey: entries,
          groupings: [GROUPING],
          activeWorkspaceSelection,
        }).rowsByProjectViewKey.get("project-a"),
      )[0];

    expect(
      build({ serverId: newerActive.serverId, workspaceId: newerActive.workspaceId })
        ?.targetPlacement.workspaceKey,
    ).toBe(newerActive.workspaceKey);
    expect(build(null)?.targetPlacement.workspaceKey).toBe(olderDefault.workspaceKey);

    entries.set(
      olderDefault.workspaceKey,
      entry(olderDefault, {
        ref: "project-a-catalog",
        statusEnteredAt: "2026-08-20T10:00:00.000Z",
      }),
    );
    expect(build(null)?.targetPlacement.workspaceKey).toBe(newerActive.workspaceKey);
  });

  it("deduplicates aliases by native identity while preserving distinct same-host placements", () => {
    const first = placement({ id: "project-a-catalog-host-b-history-a", serverId: "host-b" });
    const firstAlias = {
      ...first,
      workspaceKey: `${first.workspaceKey}:duplicate-alias`,
    };
    const second = placement({ id: "project-a-catalog-host-b-history-b", serverId: "host-b" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [first, firstAlias, second])],
      workspaceEntriesByKey: new Map([
        [
          first.workspaceKey,
          entry(first, {
            ref: "project-a-catalog",
            title: "Części i katalogi",
            status: "running",
          }),
        ],
        [
          firstAlias.workspaceKey,
          entry(firstAlias, {
            ref: "project-a-catalog",
            title: "Części i katalogi",
            status: "running",
          }),
        ],
        [
          second.workspaceKey,
          entry(second, {
            ref: "project-a-catalog",
            isDefault: true,
            title: "Części i katalogi",
            status: "failed",
          }),
        ],
      ]),
      groupings: [GROUPING],
      activeWorkspaceSelection: null,
    });
    const row = logicalRows(projection.rowsByProjectViewKey.get("project-a"))[0];

    expect(row?.title).toBe("Części i katalogi");
    expect(row?.displayEntry.statusBucket).toBe("failed");
    expect(row?.targetPlacement.workspaceKey).toBe(second.workspaceKey);
    expect(row?.placements.map((item) => item.workspaceKey)).toEqual([
      first.workspaceKey,
      second.workspaceKey,
    ]);
    expect(row?.placements.map((item) => item.workspaceId)).toEqual([
      "project-a-catalog-host-b-history-a",
      "project-a-catalog-host-b-history-b",
    ]);
    expect(projection.managedWorkspaceKeys).toEqual(
      new Set([first.workspaceKey, firstAlias.workspaceKey, second.workspaceKey]),
    );
    expect(projection.rowsByProjectViewKey.get("project-a")).toHaveLength(1);
  });

  it("attaches a retained-live native workspace as history without making it a placement", () => {
    const live = placement({ id: "wks_live_catalog", serverId: "host-b" });
    const retained = placement({ id: "wks_retained_history", serverId: "host-b" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [live, retained])],
      workspaceEntriesByKey: new Map([
        [
          live.workspaceKey,
          entry(live, {
            ref: "project-a-catalog",
            isDefault: true,
            title: "Części i katalogi",
            status: "done",
          }),
        ],
        [
          retained.workspaceKey,
          entry(retained, {
            title: "Części i katalogi",
            status: "running",
          }),
        ],
      ]),
      groupings: [
        {
          ...GROUPING,
          retainedHistoryBindings: [
            {
              serverId: "host-b",
              workspaceId: retained.workspaceId,
              physicalWorkspaceRef: "project-a-catalog-host-b",
              logicalWorkspaceRef: "project-a-catalog",
            },
          ],
        },
      ],
      activeWorkspaceSelection: null,
    });
    const rows = projection.rowsByProjectViewKey.get("project-a");
    const row = logicalRows(rows)[0];

    expect(rows).toHaveLength(1);
    expect(row?.placements.map((item) => item.workspaceId)).toEqual([live.workspaceId]);
    expect(row?.retainedAgentSources.map((item) => item.workspaceId)).toEqual([
      retained.workspaceId,
    ]);
    expect(row?.targetPlacement.workspaceId).toBe(live.workspaceId);
    expect(row?.statusBucket).toBe("done");
    expect(projection.managedWorkspaceKeys).toEqual(
      new Set([live.workspaceKey, retained.workspaceKey]),
    );
    expect(projection.retainedHistoryWorkspaceKeys).toEqual(new Set([retained.workspaceKey]));
    expect(sidebarStatusPlacementsFromRows(rows ?? []).map((item) => item.workspaceId)).toEqual([
      live.workspaceId,
    ]);
  });

  it("fails open for a retained-history binding without a matching live logical workspace", () => {
    const retained = placement({ id: "retained-only", serverId: "host-b" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [retained])],
      workspaceEntriesByKey: new Map([[retained.workspaceKey, entry(retained)]]),
      groupings: [
        {
          ...GROUPING,
          retainedHistoryBindings: [
            {
              serverId: "host-b",
              workspaceId: retained.workspaceId,
              physicalWorkspaceRef: "project-a-catalog-host-b",
              logicalWorkspaceRef: "project-a-catalog",
            },
          ],
        },
      ],
      activeWorkspaceSelection: null,
    });

    expect(projection.rowsByProjectViewKey.get("project-a")).toEqual([
      { kind: "physical", key: retained.workspaceKey, placement: retained },
    ]);
    expect(projection.managedWorkspaceKeys).toEqual(new Set());
    expect(projection.retainedHistoryWorkspaceKeys).toEqual(new Set());
  });

  it("keeps malformed, conflicting, and not-yet-hydrated placements native", () => {
    const conflict = placement({ id: "conflict" });
    const malformed = placement({ id: "malformed" });
    const missing = placement({ id: "missing" });
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [project("project-a", [conflict, malformed, missing])],
      workspaceEntriesByKey: new Map([
        [
          conflict.workspaceKey,
          entry(conflict, {
            labels: [
              encodeLogicalWorkspaceRefLabel("project-a-catalog"),
              encodeLogicalWorkspaceRefLabel("project-a-diagnostics"),
            ],
          }),
        ],
        [
          malformed.workspaceKey,
          entry(malformed, {
            labels: ["paseo:reserved:v1:logical-workspace-ref=bad/ref"],
          }),
        ],
      ]),
      groupings: [GROUPING],
      activeWorkspaceSelection: null,
    });

    expect(projection.rowsByProjectViewKey.get("project-a")).toEqual([
      { kind: "physical", key: conflict.workspaceKey, placement: conflict },
      { kind: "physical", key: malformed.workspaceKey, placement: malformed },
      { kind: "physical", key: missing.workspaceKey, placement: missing },
    ]);
    expect(projection.managedWorkspaceKeys.size).toBe(0);
  });

  it("projects a 31 logical / 45 physical inventory without loss", () => {
    const logicalFixture: Array<readonly [string, readonly string[]]> = [];
    for (let logicalIndex = 0; logicalIndex < 31; logicalIndex += 1) {
      const logicalRef = `project-${Math.floor(logicalIndex / 10) + 1}-workspace-${logicalIndex + 1}`;
      let physicalCount = 1;
      if (logicalIndex === 0) {
        physicalCount = 3;
      } else if (logicalIndex <= 12) {
        physicalCount = 2;
      }
      const physicalRefs = [logicalRef];
      for (let placementIndex = 1; placementIndex < physicalCount; placementIndex += 1) {
        physicalRefs.push(`${logicalRef}-host-${placementIndex + 1}`);
      }
      logicalFixture.push([logicalRef, physicalRefs]);
    }
    const projectsByViewKey = new Map<string, SidebarWorkspacePlacement[]>();
    const entries = new Map<string, SidebarWorkspaceEntry>();
    for (const [logicalRef, physicalRefs] of logicalFixture) {
      const viewKey = logicalRef.split("-")[0] ?? "unknown";
      const projectPlacements = projectsByViewKey.get(viewKey) ?? [];
      physicalRefs.forEach((physicalRef, index) => {
        const value = placement({
          id: physicalRef,
          serverId: fixtureServerId(physicalRef, index),
          projectViewKey: viewKey,
        });
        projectPlacements.push(value);
        entries.set(value.workspaceKey, entry(value, { ref: logicalRef, isDefault: index === 0 }));
      });
      projectsByViewKey.set(viewKey, projectPlacements);
    }
    const projection = buildSidebarLogicalWorkspaceProjection({
      projects: [...projectsByViewKey].map(([viewKey, workspaces]) => project(viewKey, workspaces)),
      workspaceEntriesByKey: entries,
      groupings: [GROUPING],
      activeWorkspaceSelection: null,
    });
    const projectedLogicalRows = [...projection.rowsByProjectViewKey.values()].flatMap(logicalRows);
    const projectedPhysicalKeys: string[] = [];
    for (const row of projectedLogicalRows) {
      for (const item of row.placements) {
        projectedPhysicalKeys.push(item.workspaceKey);
      }
    }

    expect(logicalFixture).toHaveLength(31);
    expect([...entries]).toHaveLength(45);
    expect(projectedLogicalRows).toHaveLength(31);
    expect(new Set(projectedPhysicalKeys).size).toBe(45);
    expect(new Set(projectedPhysicalKeys)).toEqual(new Set(entries.keys()));
    expect(projection.managedWorkspaceKeys).toEqual(new Set(entries.keys()));
  });
});
