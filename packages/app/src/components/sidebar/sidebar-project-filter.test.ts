import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { filterWorkspacesByProjects, resolveHiddenProjectKeys } from "./sidebar-project-filter";

function workspace(workspaceId: string, projectViewKey: string): SidebarWorkspaceEntry {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey,
    projectName: projectViewKey,
    projectRootPath: `/repo/${projectViewKey}`,
    workspaceDirectory: `/repo/${projectViewKey}/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    pinnedAt: null,
    labels: [],
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

describe("resolveHiddenProjectKeys", () => {
  test("reads an empty stored filter as every project", () => {
    expect(resolveHiddenProjectKeys([], new Set(["alpha", "beta"]))).toEqual([]);
  });

  test("keeps only the keys that still name a project it can see", () => {
    expect(resolveHiddenProjectKeys(["alpha", "gone"], new Set(["alpha", "beta"]))).toEqual([
      "alpha",
    ]);
    expect(resolveHiddenProjectKeys(["alpha", "beta"], new Set(["alpha", "beta"]))).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("resolves hidden keys again when the host returns without changing stored preferences", () => {
    const stored = ["alpha"];
    expect(resolveHiddenProjectKeys(stored, new Set())).toEqual([]);
    expect(resolveHiddenProjectKeys(stored, new Set(["alpha", "beta"]))).toEqual(["alpha"]);
    expect(stored).toEqual(["alpha"]);
    expect(resolveHiddenProjectKeys(["alpha"], new Set(["beta"]))).toEqual([]);
    expect(resolveHiddenProjectKeys(["alpha"], new Set())).toEqual([]);
  });
});

describe("filterWorkspacesByProjects", () => {
  const workspaces = [
    workspace("one", "alpha"),
    workspace("two", "alpha"),
    workspace("three", "beta"),
  ];

  function filtered(hiddenProjectKeys: string[]) {
    return filterWorkspacesByProjects({ workspaces, hiddenProjectKeys }).map(
      (entry) => entry.workspaceId,
    );
  }

  test("keeps every workspace by default", () => {
    expect(filtered([])).toEqual(["one", "two", "three"]);
  });

  test("excludes only hidden projects", () => {
    expect(filtered(["alpha"])).toEqual(["three"]);
    expect(filtered(["beta"])).toEqual(["one", "two"]);
    expect(filtered(["alpha", "beta"])).toEqual([]);
  });

  test("shows new projects even with stale hidden keys", () => {
    expect(filtered(["gamma"])).toEqual(["one", "two", "three"]);
  });
});
