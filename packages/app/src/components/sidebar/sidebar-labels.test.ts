import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY } from "@/stores/sidebar-view-store";
import { filterWorkspacesByLabels, labelWorkspaceGroups } from "./sidebar-labels";

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

describe("sidebar label grouping", () => {
  const definitions = [
    { name: "Urgent", color: "red" as const },
    { name: "Backend", color: "teal" as const },
  ];

  function groups(workspaces: SidebarWorkspaceEntry[]) {
    return labelWorkspaceGroups({ workspaces, definitions, unlabelledLabel: "Unlabelled" });
  }

  test("files a workspace under its first label only", () => {
    const result = groups([workspace("one", ["Backend", "Urgent"])]);

    expect(result.map((group) => group.label)).toEqual(["Backend"]);
    expect(result.map((group) => group.rows.length)).toEqual([1]);
  });

  test("orders groups by the catalog, unknown labels after it, Unlabelled last", () => {
    const result = groups([
      workspace("none", []),
      workspace("stray", ["Zeta"]),
      workspace("backend", ["Backend"]),
      workspace("urgent", ["Urgent"]),
    ]);

    expect(result.map((group) => group.label)).toEqual(["Urgent", "Backend", "Zeta", "Unlabelled"]);
  });

  test("carries the catalog color, and none for a label it cannot resolve", () => {
    const result = groups([workspace("urgent", ["urgent"]), workspace("stray", ["Zeta"])]);

    expect(result.map((group) => [group.label, group.leading])).toEqual([
      // The catalog spells the name; the workspace only carries the key it matches on.
      ["Urgent", { kind: "label", color: "red" }],
      ["Zeta", { kind: "label", color: null }],
    ]);
  });

  test("keys label groups apart from the status buckets they share a collapsed set with", () => {
    const result = groups([workspace("backend", ["Backend"]), workspace("none", [])]);

    expect(result.map((group) => group.key)).toEqual(["label:backend", "no-label"]);
  });

  test("reads a whitespace-only label as no label", () => {
    expect(groups([workspace("blank", ["   "])]).map((group) => group.label)).toEqual([
      "Unlabelled",
    ]);
  });
});
