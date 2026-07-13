import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry, SidebarWorkspaceEntry } from "./sidebar-workspaces-view-model";
import {
  orderSidebarProjects,
  organizeSidebarWorkspaces,
  selectUngroupedSidebarProjects,
} from "./sidebar-workspace-organization";

const COLLECTION_LABELS = { none: "No label", unknown: "Unknown label" };

function workspace(input: {
  id: string;
  name: string;
  projectKey?: string;
  serverId?: string;
  status?: SidebarWorkspaceEntry["statusBucket"];
  createdAt?: string;
  activityAt?: string;
  pinned?: boolean;
  collectionId?: string | null;
}): SidebarWorkspaceEntry {
  const serverId = input.serverId ?? "host-a";
  const projectKey = input.projectKey ?? "project-a";
  return {
    workspaceKey: `${serverId}:${input.id}`,
    serverId,
    workspaceId: input.id,
    projectKey,
    projectName: projectKey,
    projectRootPath: `/${projectKey}`,
    workspaceDirectory: `/${projectKey}/${input.id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.name,
    title: null,
    currentBranch: input.name,
    statusBucket: input.status ?? "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    createdAt: input.createdAt ? new Date(input.createdAt) : null,
    activityAt: input.activityAt ? new Date(input.activityAt) : null,
    pinnedAt: input.pinned ? new Date("2026-07-01T00:00:00.000Z") : null,
    collectionId: input.collectionId ?? null,
  };
}

function project(projectKey: string, rows: readonly SidebarWorkspaceEntry[]): SidebarProjectEntry {
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: `/${projectKey}`,
    hosts: [{ serverId: "host-a", iconWorkingDir: `/${projectKey}`, canCreateWorktree: true }],
    workspaces: rows.map((row) => row),
  };
}

function organize(input: {
  rows: SidebarWorkspaceEntry[];
  hidden?: string[];
  hiddenProjects?: string[];
  sortMode?: "custom" | "alphabetical" | "created" | "recency";
  visibilityFilter?: "visible" | "hidden" | "all";
  statusFilters?: SidebarWorkspaceEntry["statusBucket"][];
  projectFilters?: string[];
  lastActivityFilter?: "all" | "today" | "seven_days" | "thirty_days";
}) {
  const projectsByKey = new Map<string, SidebarWorkspaceEntry[]>();
  for (const row of input.rows) {
    projectsByKey.set(row.projectKey, [...(projectsByKey.get(row.projectKey) ?? []), row]);
  }
  return organizeSidebarWorkspaces({
    projects: Array.from(projectsByKey, ([projectKey, rows]) => project(projectKey, rows)),
    entriesByKey: new Map(input.rows.map((row) => [row.workspaceKey, row])),
    hiddenWorkspaceKeys: new Set(input.hidden ?? []),
    hiddenProjectKeys: new Set(input.hiddenProjects ?? []),
    collections: [
      {
        serverId: "host-a",
        collections: [
          {
            id: "collection-a",
            name: "Frontend",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            updatedAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        ],
      },
    ],
    collectionLabels: COLLECTION_LABELS,
    preferences: {
      sortMode: input.sortMode ?? "custom",
      visibilityFilter: input.visibilityFilter ?? "visible",
      lastActivityFilter: input.lastActivityFilter ?? "all",
      statusFilters: input.statusFilters ?? [],
      projectFilters: input.projectFilters ?? [],
    },
    now: new Date("2026-07-13T12:00:00.000Z"),
  });
}

function collectionSummary(group: { label: string; rows: readonly SidebarWorkspaceEntry[] }): {
  label: string;
  ids: string[];
} {
  return { label: group.label, ids: group.rows.map(workspaceId) };
}

function workspaceId(row: SidebarWorkspaceEntry): string {
  return row.workspaceId;
}

describe("organizeSidebarWorkspaces", () => {
  it("keeps pinned and empty projects recoverable beside flat ungrouped workspace rows", () => {
    const pinnedWithWorkspace = project("project-pinned", [
      workspace({ id: "pinned", name: "Pinned", projectKey: "project-pinned" }),
    ]);
    const regularWithWorkspace = project("project-regular", [
      workspace({ id: "regular", name: "Regular", projectKey: "project-regular" }),
    ]);
    const emptyProject = project("project-empty", []);

    const result = selectUngroupedSidebarProjects({
      pinnedProjects: [pinnedWithWorkspace],
      projects: [regularWithWorkspace, emptyProject],
    });

    expect(result.pinnedProjects.map((entry) => entry.projectKey)).toEqual(["project-pinned"]);
    expect(result.projects.map((entry) => entry.projectKey)).toEqual(["project-empty"]);
  });

  it("pins and alphabetizes projects independently from workspace pinning", () => {
    const alpha = workspace({ id: "alpha", name: "Workspace A", projectKey: "project-a" });
    const zulu = workspace({ id: "zulu", name: "Workspace Z", projectKey: "project-z" });
    const entriesByKey = new Map([
      [alpha.workspaceKey, alpha],
      [zulu.workspaceKey, zulu],
    ]);

    const result = orderSidebarProjects({
      projects: [project("project-z", [zulu]), project("project-a", [alpha])],
      entriesByKey,
      pinnedProjectKeys: new Set(["project-z"]),
      sortMode: "alphabetical",
    });

    expect(result.pinnedProjects.map((entry) => entry.projectKey)).toEqual(["project-z"]);
    expect(result.projects.map((entry) => entry.projectKey)).toEqual(["project-a"]);
  });

  it("sorts projects by child workspace creation and activity timestamps", () => {
    const oldActive = workspace({
      id: "old-active",
      name: "Old active",
      projectKey: "project-old",
      createdAt: "2026-07-01T00:00:00.000Z",
      activityAt: "2026-07-12T00:00:00.000Z",
    });
    const newIdle = workspace({
      id: "new-idle",
      name: "New idle",
      projectKey: "project-new",
      createdAt: "2026-07-10T00:00:00.000Z",
      activityAt: "2026-07-02T00:00:00.000Z",
    });
    const projects = [project("project-old", [oldActive]), project("project-new", [newIdle])];
    const entriesByKey = new Map([
      [oldActive.workspaceKey, oldActive],
      [newIdle.workspaceKey, newIdle],
    ]);

    expect(
      orderSidebarProjects({ projects, entriesByKey, sortMode: "created" }).projects.map(
        (entry) => entry.projectKey,
      ),
    ).toEqual(["project-new", "project-old"]);
    expect(
      orderSidebarProjects({ projects, entriesByKey, sortMode: "recency" }).projects.map(
        (entry) => entry.projectKey,
      ),
    ).toEqual(["project-old", "project-new"]);
  });

  it("keeps custom order while lifting pinned workspaces without duplicates", () => {
    const rows = [
      workspace({ id: "one", name: "One" }),
      workspace({ id: "two", name: "Two", pinned: true }),
      workspace({ id: "three", name: "Three" }),
    ];

    const result = organize({ rows });

    expect(result.pinnedRows.map((row) => row.workspaceId)).toEqual(["two"]);
    expect(result.regularRows.map((row) => row.workspaceId)).toEqual(["one", "three"]);
    expect(result.projects[0]?.workspaces.map((row) => row.workspaceId)).toEqual(["one", "three"]);
  });

  it("lets hidden state win over pinning and keeps the workspace recoverable in All mode", () => {
    const pinned = workspace({ id: "pinned", name: "Pinned", pinned: true });

    const result = organize({
      rows: [pinned],
      hidden: [pinned.workspaceKey],
      visibilityFilter: "all",
    });

    expect(result.pinnedRows).toEqual([]);
    expect(result.regularRows).toEqual([]);
    expect(result.hiddenRows.map((row) => row.workspaceId)).toEqual(["pinned"]);
  });

  it("sorts alphabetically and uses stable workspace identity as a tie breaker", () => {
    const result = organize({
      rows: [
        workspace({ id: "b", name: "alpha" }),
        workspace({ id: "c", name: "Zulu" }),
        workspace({ id: "a", name: "Alpha" }),
      ],
      sortMode: "alphabetical",
    });

    expect(result.regularRows.map((row) => row.workspaceId)).toEqual(["a", "b", "c"]);
  });

  it("sorts created time and recency independently", () => {
    const oldActive = workspace({
      id: "old-active",
      name: "Old active",
      createdAt: "2026-07-01T00:00:00.000Z",
      activityAt: "2026-07-12T00:00:00.000Z",
    });
    const newIdle = workspace({
      id: "new-idle",
      name: "New idle",
      createdAt: "2026-07-10T00:00:00.000Z",
      activityAt: "2026-07-02T00:00:00.000Z",
    });

    expect(
      organize({ rows: [oldActive, newIdle], sortMode: "created" }).regularRows.map(
        (row) => row.workspaceId,
      ),
    ).toEqual(["new-idle", "old-active"]);
    expect(
      organize({ rows: [oldActive, newIdle], sortMode: "recency" }).regularRows.map(
        (row) => row.workspaceId,
      ),
    ).toEqual(["old-active", "new-idle"]);
  });

  it("applies status, project, and last-activity filters before pinning", () => {
    const matching = workspace({
      id: "matching",
      name: "Matching",
      projectKey: "project-a",
      status: "running",
      pinned: true,
      activityAt: "2026-07-12T00:00:00.000Z",
    });
    const stale = workspace({
      id: "stale",
      name: "Stale",
      projectKey: "project-a",
      status: "running",
      pinned: true,
      activityAt: "2026-06-01T00:00:00.000Z",
    });
    const wrongStatus = workspace({
      id: "done",
      name: "Done",
      projectKey: "project-a",
      status: "done",
      activityAt: "2026-07-12T00:00:00.000Z",
    });

    const result = organize({
      rows: [matching, stale, wrongStatus],
      statusFilters: ["running"],
      projectFilters: ["project-a"],
      lastActivityFilter: "seven_days",
    });

    expect(result.pinnedRows.map((row) => row.workspaceId)).toEqual(["matching"]);
    expect(result.regularRows).toEqual([]);
  });

  it("does not leak empty or pinned project shells through the project filter", () => {
    const selectedWorkspace = workspace({
      id: "selected",
      name: "Selected",
      projectKey: "project-selected",
    });
    const filteredWorkspace = workspace({
      id: "filtered",
      name: "Filtered",
      projectKey: "project-filtered",
      pinned: true,
    });

    const result = organizeSidebarWorkspaces({
      projects: [
        project("project-selected", [selectedWorkspace]),
        project("project-filtered", [filteredWorkspace]),
        project("project-empty", []),
      ],
      entriesByKey: new Map([
        [selectedWorkspace.workspaceKey, selectedWorkspace],
        [filteredWorkspace.workspaceKey, filteredWorkspace],
      ]),
      pinnedProjectKeys: new Set(["project-filtered"]),
      hiddenWorkspaceKeys: new Set(),
      collections: [],
      collectionLabels: COLLECTION_LABELS,
      preferences: {
        sortMode: "alphabetical",
        visibilityFilter: "visible",
        lastActivityFilter: "all",
        statusFilters: [],
        projectFilters: ["project-selected"],
      },
    });

    expect(result.projects.map((entry) => entry.projectKey)).toEqual(["project-selected"]);
    expect(result.pinnedProjects).toEqual([]);
  });

  it("builds flat collection groups and leaves unassigned workspaces recoverable", () => {
    const result = organize({
      rows: [
        workspace({ id: "frontend", name: "Web", collectionId: "collection-a" }),
        workspace({ id: "loose", name: "Loose" }),
      ],
    });

    expect(result.collectionGroups.map(collectionSummary)).toEqual([
      { label: "Frontend", ids: ["frontend"] },
      { label: "No label", ids: ["loose"] },
    ]);
  });

  it("keeps an empty persisted collection visible for management", () => {
    const result = organize({ rows: [] });

    expect(result.collectionGroups).toEqual([
      expect.objectContaining({
        key: "host-a:collection-a",
        serverId: "host-a",
        collectionId: "collection-a",
        label: "Frontend",
        rows: [],
      }),
    ]);
  });

  it("shows only the recoverable hidden section in Hidden visibility mode", () => {
    const visible = workspace({ id: "visible", name: "Visible" });
    const hidden = workspace({ id: "hidden", name: "Hidden" });

    const result = organize({
      rows: [visible, hidden],
      hidden: [hidden.workspaceKey],
      visibilityFilter: "hidden",
    });

    expect(result.pinnedRows).toEqual([]);
    expect(result.regularRows).toEqual([]);
    expect(result.hiddenRows.map((row) => row.workspaceId)).toEqual(["hidden"]);
    expect(result.projects).toEqual([]);
    expect(result.collectionGroups).toEqual([]);
  });

  it("distinguishes Visible from All visibility", () => {
    const visible = workspace({ id: "visible", name: "Visible" });
    const hidden = workspace({ id: "hidden", name: "Hidden" });
    const base = { rows: [visible, hidden], hidden: [hidden.workspaceKey] };

    const visibleOnly = organize({ ...base, visibilityFilter: "visible" });
    const all = organize({ ...base, visibilityFilter: "all" });

    expect(visibleOnly.regularRows.map((row) => row.workspaceId)).toEqual(["visible"]);
    expect(visibleOnly.hiddenRows).toEqual([]);
    expect(all.regularRows.map((row) => row.workspaceId)).toEqual(["visible"]);
    expect(all.hiddenRows.map((row) => row.workspaceId)).toEqual(["hidden"]);
  });

  it("keeps the project shell when its only workspace is pinned", () => {
    const pinned = workspace({
      id: "pinned",
      name: "Pinned",
      projectKey: "project-a",
      pinned: true,
    });

    const result = organize({ rows: [pinned] });

    expect(result.projects.map((entry) => entry.projectKey)).toEqual(["project-a"]);
    expect(result.projects[0]?.workspaces).toEqual([]);
  });

  it("keeps the project shell in All when its only workspace is hidden", () => {
    const hidden = workspace({ id: "hidden", name: "Hidden", projectKey: "project-a" });

    const result = organize({
      rows: [hidden],
      hidden: [hidden.workspaceKey],
      visibilityFilter: "all",
    });

    expect(result.projects.map((entry) => entry.projectKey)).toEqual(["project-a"]);
    expect(result.projects[0]?.workspaces).toEqual([]);
    expect(result.hiddenRows.map((entry) => entry.workspaceId)).toEqual(["hidden"]);
  });

  it("does not retain originally empty projects under workspace filters", () => {
    const running = workspace({
      id: "running",
      name: "Running",
      projectKey: "project-running",
      status: "running",
      activityAt: "2026-07-13T08:00:00.000Z",
    });
    const projects = [project("project-empty", []), project("project-running", [running])];
    const base = {
      projects,
      entriesByKey: new Map([[running.workspaceKey, running]]),
      hiddenWorkspaceKeys: new Set<string>(),
      collections: [],
      collectionLabels: COLLECTION_LABELS,
      preferences: {
        sortMode: "custom" as const,
        visibilityFilter: "visible" as const,
        projectFilters: [],
      },
      now: new Date("2026-07-13T12:00:00.000Z"),
    };

    const statusResult = organizeSidebarWorkspaces({
      ...base,
      preferences: {
        ...base.preferences,
        statusFilters: ["running"],
        lastActivityFilter: "all",
      },
    });
    const activityResult = organizeSidebarWorkspaces({
      ...base,
      preferences: {
        ...base.preferences,
        statusFilters: [],
        lastActivityFilter: "today",
      },
    });

    expect(statusResult.projects.map((entry) => entry.projectKey)).toEqual(["project-running"]);
    expect(activityResult.projects.map((entry) => entry.projectKey)).toEqual(["project-running"]);
  });

  it("sorts a project using pinned child activity", () => {
    const oldRegular = workspace({
      id: "old",
      name: "Old",
      projectKey: "project-a",
      activityAt: "2026-07-01T08:00:00.000Z",
    });
    const recentPinned = workspace({
      id: "recent-pinned",
      name: "Recent pinned",
      projectKey: "project-a",
      activityAt: "2026-07-13T08:00:00.000Z",
      pinned: true,
    });
    const middle = workspace({
      id: "middle",
      name: "Middle",
      projectKey: "project-b",
      activityAt: "2026-07-10T08:00:00.000Z",
    });

    const result = organize({ rows: [oldRegular, recentPinned, middle], sortMode: "recency" });

    expect(result.projects.map((entry) => entry.projectKey)).toEqual(["project-a", "project-b"]);
  });

  it("keeps hidden projects separate and recoverable in All and Hidden", () => {
    const hiddenProjectWorkspace = workspace({
      id: "hidden-project-workspace",
      name: "Hidden project workspace",
      projectKey: "project-hidden",
      pinned: true,
    });
    const visibleWorkspace = workspace({
      id: "visible",
      name: "Visible",
      projectKey: "project-visible",
    });
    const base = {
      rows: [hiddenProjectWorkspace, visibleWorkspace],
      hiddenProjects: ["project-hidden"],
    };

    const all = organize({ ...base, visibilityFilter: "all" });
    const hidden = organize({ ...base, visibilityFilter: "hidden" });

    expect(all.projects.map((entry) => entry.projectKey)).toEqual(["project-visible"]);
    expect(all.pinnedRows).toEqual([]);
    expect(all.hiddenProjects.map((entry) => entry.projectKey)).toEqual(["project-hidden"]);
    expect(hidden.projects).toEqual([]);
    expect(hidden.hiddenProjects.map((entry) => entry.projectKey)).toEqual(["project-hidden"]);
  });
});
