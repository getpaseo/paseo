import { describe, expect, test } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY } from "@/stores/sidebar-view-store";
import { filterWorkspacesByLabels, pinnedProjectWorkspaceGroups } from "./sidebar-labels";

function workspace(
  workspaceId: string,
  labels: string[],
  pinnedAt: string | null = null,
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey: "project",
    projectName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    pinnedAt,
    labels,
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

describe("sidebar label filtering", () => {
  const workspaces = [
    workspace("one", ["Backend", "Urgent"], "2026-01-01"),
    workspace("two", ["Backend"]),
    workspace("three", []),
  ];

  function filtered(labels: string[]) {
    return filterWorkspacesByLabels({ workspaces, labels }).map((entry) => entry.workspaceId);
  }

  test("includes a workspace carrying any selected label", () => {
    expect(filtered([])).toEqual(["one", "two", "three"]);
    expect(filtered(["backend"])).toEqual(["one", "two"]);
    expect(filtered(["backend", "urgent"])).toEqual(["one", "two"]);
  });

  test("models Unlabelled as a row in the same list", () => {
    expect(filtered([SIDEBAR_UNLABELLED_LABEL_KEY])).toEqual(["three"]);
    expect(filtered(["backend", SIDEBAR_UNLABELLED_LABEL_KEY])).toEqual(["one", "two", "three"]);
  });

  test("reads whitespace-only label names as no label rather than as the Unlabelled key", () => {
    expect(
      filterWorkspacesByLabels({
        workspaces: [workspace("blank", ["   "])],
        labels: [SIDEBAR_UNLABELLED_LABEL_KEY],
      }).map((entry) => entry.workspaceId),
    ).toEqual(["blank"]);
  });
});

describe("pinned project workspace groups", () => {
  test("keeps pinned workspaces and retains empty project headers", () => {
    const projects = [
      project({ viewKey: "p1", projectName: "Project 1", workspaceIds: ["first", "second"] }),
      project({ viewKey: "p2", projectName: "Project 2", workspaceIds: [] }),
    ];
    const first = workspace("first", [], "2026-01-01T00:00:00Z");
    const second = workspace("second", []);
    const groups = pinnedProjectWorkspaceGroups(
      projects,
      new Map([
        [first.workspaceKey, first],
        [second.workspaceKey, second],
      ]),
    );

    expect(groups.map((group) => group.key)).toEqual(["pinned-project:p1", "pinned-project:p2"]);
    expect(groups[0]?.leading).toEqual({ kind: "project", projectViewKey: "p1" });
    expect(groups[0]?.label).toBe("Project 1");
    expect(groups[0]?.rows.map((entry) => entry.workspaceId)).toEqual(["first", "second"]);
    expect(groups[1]?.rows).toEqual([]);
  });
});

interface ProjectFixtureInput {
  viewKey: string;
  projectName: string;
  workspaceIds: string[];
}

function project({ viewKey, projectName, workspaceIds }: ProjectFixtureInput): SidebarProjectEntry {
  const workspaces: SidebarWorkspacePlacement[] = workspaceIds.map((workspaceId) => ({
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey: viewKey,
    projectName,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
  }));
  return {
    viewKey,
    projectName,
    projectKind: "git",
    iconWorkingDir: "",
    hosts: [],
    workspaces,
  };
}
