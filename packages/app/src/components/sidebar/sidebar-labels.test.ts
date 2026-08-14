import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  SIDEBAR_UNLABELLED_LABEL_KEY,
  type SidebarLabelMatch,
  type SidebarLabelState,
} from "@/stores/sidebar-view-store";
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

  function filtered(labels: Record<string, SidebarLabelState>, match: SidebarLabelMatch = "any") {
    return filterWorkspacesByLabels({ workspaces, labels, match }).map(
      (entry) => entry.workspaceId,
    );
  }

  test("composes include-any, include-all, and exclusions", () => {
    expect(filtered({})).toEqual(["one", "two", "three"]);
    expect(filtered({ backend: "include", urgent: "include" })).toEqual(["one", "two"]);
    expect(filtered({ backend: "include", urgent: "include" }, "all")).toEqual(["one"]);
    expect(filtered({ backend: "include", urgent: "exclude" })).toEqual(["two"]);
    expect(filtered({ urgent: "exclude" })).toEqual(["two", "three"]);
  });

  test("treats a lone include the same under either match mode", () => {
    expect(filtered({ urgent: "include" }, "all")).toEqual(filtered({ urgent: "include" }));
  });

  test("models Unlabelled as a row in the same map", () => {
    expect(filtered({ [SIDEBAR_UNLABELLED_LABEL_KEY]: "include" })).toEqual(["three"]);
    expect(filtered({ [SIDEBAR_UNLABELLED_LABEL_KEY]: "exclude" })).toEqual(["one", "two"]);
    expect(filtered({ backend: "include", [SIDEBAR_UNLABELLED_LABEL_KEY]: "include" })).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(
      filtered({ backend: "include", [SIDEBAR_UNLABELLED_LABEL_KEY]: "include" }, "all"),
    ).toEqual([]);
  });

  test("reads whitespace-only label names as no label rather than as the Unlabelled key", () => {
    expect(
      filterWorkspacesByLabels({
        workspaces: [workspace("blank", ["   "])],
        labels: { [SIDEBAR_UNLABELLED_LABEL_KEY]: "include" },
        match: "any",
      }).map((entry) => entry.workspaceId),
    ).toEqual(["blank"]);
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
