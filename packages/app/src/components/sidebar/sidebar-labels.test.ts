import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  filterWorkspacesByLabels,
  groupWorkspacesByLabel,
  labelWorkspaceGroups,
} from "./sidebar-labels";

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

function workspaceIds(group: { rows: SidebarWorkspaceEntry[] }): string[] {
  return group.rows.map((entry) => entry.workspaceId);
}

describe("sidebar label filtering and grouping", () => {
  const workspaces = [
    workspace("one", ["Backend", "Urgent"], "2026-01-01"),
    workspace("two", ["Backend"]),
    workspace("three", []),
  ];

  test("composes include-any, include-all, exclusions, and unlabelled semantics", () => {
    expect(
      filterWorkspacesByLabels({
        workspaces,
        include: ["backend", "urgent"],
        exclude: [],
        match: "any",
        includeUnlabelled: false,
        excludeUnlabelled: false,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["one", "two"]);
    expect(
      filterWorkspacesByLabels({
        workspaces,
        include: ["backend", "urgent"],
        exclude: [],
        match: "all",
        includeUnlabelled: false,
        excludeUnlabelled: false,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["one"]);
    expect(
      filterWorkspacesByLabels({
        workspaces,
        include: ["backend"],
        exclude: ["urgent"],
        match: "any",
        includeUnlabelled: false,
        excludeUnlabelled: false,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["two"]);
    expect(
      filterWorkspacesByLabels({
        workspaces,
        include: [],
        exclude: ["urgent"],
        match: "any",
        includeUnlabelled: false,
        excludeUnlabelled: false,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["two", "three"]);
  });

  test("models Unlabelled explicitly for include, exclude, and host composition", () => {
    expect(
      filterWorkspacesByLabels({
        workspaces,
        include: [],
        exclude: [],
        match: "any",
        includeUnlabelled: true,
        excludeUnlabelled: false,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["three"]);
    expect(
      filterWorkspacesByLabels({
        workspaces,
        include: [],
        exclude: [],
        match: "any",
        includeUnlabelled: false,
        excludeUnlabelled: true,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["one", "two"]);

    const hostFiltered = [
      ...workspaces,
      { ...workspace("other-unlabelled", []), serverId: "other-host" },
    ].filter((entry) => entry.serverId === "other-host");
    expect(
      filterWorkspacesByLabels({
        workspaces: hostFiltered,
        include: ["backend"],
        exclude: [],
        match: "any",
        includeUnlabelled: true,
        excludeUnlabelled: false,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["other-unlabelled"]);
  });

  test("deduplicates cross-host spelling variants before applying match-all", () => {
    expect(
      filterWorkspacesByLabels({
        workspaces,
        include: ["URGENT", " urgent "],
        exclude: [],
        match: "all",
        includeUnlabelled: false,
        excludeUnlabelled: false,
      }).map((entry) => entry.workspaceId),
    ).toEqual(["one"]);
  });

  test("duplicates multi-labelled workspaces and places Unlabelled last", () => {
    expect(
      groupWorkspacesByLabel(workspaces, "Unlabelled").map((group) => ({
        label: group.label,
        rows: workspaceIds(group),
      })),
    ).toEqual([
      { label: "Backend", rows: ["one", "two"] },
      { label: "Urgent", rows: ["one"] },
      { label: "Unlabelled", rows: ["three"] },
    ]);
  });

  test("keeps the synthetic unlabelled group outside real label identity", () => {
    const groups = labelWorkspaceGroups(
      groupWorkspacesByLabel(
        [
          { ...workspaces[0], labels: ["Unlabelled"] },
          { ...workspaces[2], labels: [] },
        ],
        "Unlabelled",
      ),
    );

    expect(groups.map(({ key, rows }) => ({ key, rows: workspaceIds({ rows }) }))).toEqual([
      { key: "label:unlabelled", rows: ["one"] },
      { key: "synthetic:unlabelled", rows: ["three"] },
    ]);
  });
});
