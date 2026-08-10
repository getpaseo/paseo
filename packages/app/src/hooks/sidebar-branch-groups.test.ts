import { describe, expect, it } from "vitest";
import { buildSidebarBranchGroups } from "./sidebar-branch-groups";
import type { SidebarProjectEntry, SidebarWorkspaceEntry } from "./sidebar-workspaces-view-model";

function ws(
  overrides: Partial<SidebarWorkspaceEntry> & { workspaceKey: string },
): SidebarWorkspaceEntry {
  return {
    serverId: "srv",
    workspaceId: overrides.workspaceKey.split(":")[1] ?? "ws",
    projectViewKey: "proj",
    projectName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "main",
    title: null,
    currentBranch: null,
    provider: null,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    ...overrides,
  };
}

const project: SidebarProjectEntry = {
  viewKey: "proj",
  projectName: "Project",
  projectKind: "git",
  iconWorkingDir: "/repo",
  hosts: [],
  workspaces: [
    {
      workspaceKey: "srv:parent",
      serverId: "srv",
      workspaceId: "parent",
      projectViewKey: "proj",
      projectName: "Project",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
    },
    {
      workspaceKey: "srv:wt-feat",
      serverId: "srv",
      workspaceId: "wt-feat",
      projectViewKey: "proj",
      projectName: "Project",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "feature/x",
    },
    {
      workspaceKey: "srv:wt-fix",
      serverId: "srv",
      workspaceId: "wt-fix",
      projectViewKey: "proj",
      projectName: "Project",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "fix/y",
    },
  ],
};

const entries = new Map<string, SidebarWorkspaceEntry>([
  [
    "srv:parent",
    ws({ workspaceKey: "srv:parent", workspaceKind: "local_checkout", currentBranch: "main" }),
  ],
  [
    "srv:wt-feat",
    ws({ workspaceKey: "srv:wt-feat", workspaceKind: "worktree", currentBranch: "feature/x" }),
  ],
  [
    "srv:wt-fix",
    ws({ workspaceKey: "srv:wt-fix", workspaceKind: "worktree", currentBranch: "fix/y" }),
  ],
]);

describe("buildSidebarBranchGroups", () => {
  it("puts the parent checkout first with isParent", () => {
    const groups = buildSidebarBranchGroups({ project, workspaceEntriesByKey: entries });
    expect(groups[0]).toMatchObject({
      isParent: true,
      branch: null,
      workspaceKeys: ["srv:parent"],
    });
  });

  it("groups worktrees by branch in first-seen order", () => {
    const groups = buildSidebarBranchGroups({ project, workspaceEntriesByKey: entries });
    expect(groups.slice(1).map((g) => g.branch)).toEqual(["feature/x", "fix/y"]);
    expect(groups[1]?.workspaceKeys).toEqual(["srv:wt-feat"]);
    expect(groups[2]?.workspaceKeys).toEqual(["srv:wt-fix"]);
  });

  it("merges multiple worktrees on the same branch into one group", () => {
    const twoOnBranch = new Map(entries);
    twoOnBranch.set(
      "srv:wt-feat2",
      ws({
        workspaceKey: "srv:wt-feat2",
        workspaceKind: "worktree",
        currentBranch: "feature/x",
      }),
    );
    const projWithTwo = {
      ...project,
      workspaces: [
        ...project.workspaces,
        {
          workspaceKey: "srv:wt-feat2",
          serverId: "srv",
          workspaceId: "wt-feat2",
          projectViewKey: "proj",
          projectName: "Project",
          projectKind: "git",
          workspaceKind: "worktree",
          name: "feature/x",
        } as const,
      ],
    };
    const groups = buildSidebarBranchGroups({
      project: projWithTwo,
      workspaceEntriesByKey: twoOnBranch,
    });
    expect(groups[1]?.workspaceKeys).toEqual(["srv:wt-feat", "srv:wt-feat2"]);
  });

  it("keeps workspaces with no branch in a trailing group", () => {
    const noBranch = new Map(entries);
    noBranch.set("srv:orphan", ws({ workspaceKey: "srv:orphan", currentBranch: null }));
    const projWithOrphan = {
      ...project,
      workspaces: [
        ...project.workspaces,
        {
          workspaceKey: "srv:orphan",
          serverId: "srv",
          workspaceId: "orphan",
          projectViewKey: "proj",
          projectName: "Project",
          projectKind: "git",
          workspaceKind: "worktree",
          name: "other",
        } as const,
      ],
    };
    const groups = buildSidebarBranchGroups({
      project: projWithOrphan,
      workspaceEntriesByKey: noBranch,
    });
    const last = groups[groups.length - 1];
    expect(last?.branch).toBeNull();
    expect(last?.workspaceKeys).toEqual(["srv:orphan"]);
  });
});
