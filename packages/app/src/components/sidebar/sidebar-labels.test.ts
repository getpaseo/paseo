import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  hasActiveSidebarLabelFilter,
  SIDEBAR_UNLABELLED_LABEL_KEY,
} from "@/stores/sidebar-view-store";
import { filterWorkspacesByLabels, resolveActiveLabelFilter } from "./sidebar-labels";

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

  test("keeps a label only a host still connecting defines and applies it once that host loads", () => {
    const filter = { labels: ["x", "y"] };
    const hostB = [workspace("b-shared", ["Y"]), workspace("b-plain", [])];
    const hostA = [workspace("a-only", ["X"])];

    const firstHost = resolveActiveLabelFilter({
      filter,
      catalogLabelNames: ["Y"],
      workspaces: hostB,
    });
    expect(firstHost).toEqual({ labels: ["y"] });
    expect(filter).toEqual({ labels: ["x", "y"] });

    const bothHosts = resolveActiveLabelFilter({
      filter,
      catalogLabelNames: ["Y", "X"],
      workspaces: [...hostB, ...hostA],
    });
    expect(bothHosts).toEqual({ labels: ["x", "y"] });
    expect(
      filterWorkspacesByLabels({ workspaces: [...hostB, ...hostA], ...bothHosts }).map(
        (entry) => entry.workspaceId,
      ),
    ).toEqual(["b-shared", "a-only"]);
  });

  test("goes inert instead of matching nothing when nothing in view knows a saved label", () => {
    const resolved = resolveActiveLabelFilter({
      filter: { labels: ["gone"] },
      catalogLabelNames: ["Backend", "Urgent"],
      workspaces,
    });
    expect(hasActiveSidebarLabelFilter(resolved)).toBe(false);
    expect(
      filterWorkspacesByLabels({ workspaces, ...resolved }).map((entry) => entry.workspaceId),
    ).toEqual(["one", "two", "three"]);
    expect(
      resolveActiveLabelFilter({
        filter: { labels: ["gone"] },
        catalogLabelNames: [],
        workspaces: [],
      }),
    ).toEqual({ labels: [] });
  });

  test("applies a label a workspace carries before any catalog has loaded", () => {
    expect(
      resolveActiveLabelFilter({
        filter: { labels: ["urgent"] },
        catalogLabelNames: [],
        workspaces,
      }),
    ).toEqual({ labels: ["urgent"] });
  });

  test("keeps Unlabelled and a defined label that no workspace carries", () => {
    expect(
      resolveActiveLabelFilter({
        filter: { labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "empty", "gone"] },
        catalogLabelNames: ["Empty"],
        workspaces: [],
      }),
    ).toEqual({ labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "empty"] });
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
