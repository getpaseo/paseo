import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";

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

describe("resolveActiveProjectFilters", () => {
  test("reads an empty stored filter as every project", () => {
    expect(resolveActiveProjectFilters([], new Set(["alpha", "beta"]))).toEqual([]);
  });

  test("keeps only the keys that still name a project it can see", () => {
    expect(resolveActiveProjectFilters(["alpha", "gone"], new Set(["alpha", "beta"]))).toEqual([
      "alpha",
    ]);
    expect(resolveActiveProjectFilters(["alpha", "beta"], new Set(["alpha", "beta"]))).toEqual([
      "alpha",
      "beta",
    ]);
  });

  // Nothing deletes the stored keys, so a filter naming only projects on a host that has not
  // connected yet must go inert rather than blank the sidebar. It comes back with the host.
  test("goes inert instead of matching nothing", () => {
    expect(resolveActiveProjectFilters(["alpha"], new Set(["beta"]))).toEqual([]);
    expect(resolveActiveProjectFilters(["alpha"], new Set())).toEqual([]);
  });
});

describe("filterWorkspacesByProjects", () => {
  const workspaces = [
    workspace("one", "alpha"),
    workspace("two", "alpha"),
    workspace("three", "beta"),
  ];

  function filtered(projectFilters: string[]) {
    return filterWorkspacesByProjects({ workspaces, projectFilters }).map(
      (entry) => entry.workspaceId,
    );
  }

  test("keeps every workspace when nothing is pinned", () => {
    expect(filtered([])).toEqual(["one", "two", "three"]);
  });

  test("keeps the workspaces of the pinned projects", () => {
    expect(filtered(["alpha"])).toEqual(["one", "two"]);
    expect(filtered(["beta"])).toEqual(["three"]);
    expect(filtered(["alpha", "beta"])).toEqual(["one", "two", "three"]);
  });

  test("keeps nothing for a project with no workspaces", () => {
    expect(filtered(["gamma"])).toEqual([]);
  });
});
