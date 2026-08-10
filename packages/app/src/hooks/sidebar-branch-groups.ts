import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";

/**
 * A grouping of a project's workspaces by git branch. The parent/primary checkout
 * (a `local_checkout` workspace, or a worktree with no explicit branch) is always the
 * first group; remaining groups are the named branches each worktree is checked out to.
 */
export interface SidebarBranchGroup {
  /** Stable key for collapse state + drag identity: projectViewKey + branch name. */
  key: string;
  /** Branch label shown in the group header (null/empty for the parent checkout group). */
  branch: string | null;
  /** True when this is the parent/primary checkout group (special UI distinction). */
  isParent: boolean;
  workspaceKeys: string[];
}

const PARENT_BRANCH_LABEL = "__parent__";

/**
 * Group a project's workspaces by branch. Parent checkout first, then worktree
 * branches in first-seen order. Workspaces with no branch info fall into a trailing
 * "Other" group so nothing disappears from the sidebar.
 *
 * ponytail: grouping is a stable pure function keyed by branch string; nested-repo
 * grouping (a folder containing multiple repos) is handled separately by the 3a RPC.
 */
export function buildSidebarBranchGroups(input: {
  project: SidebarProjectEntry;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  placements?: readonly SidebarWorkspacePlacement[];
}): SidebarBranchGroup[] {
  const groups = new Map<string, SidebarBranchGroup>();
  const parentGroup: SidebarBranchGroup = {
    key: `${input.project.viewKey}:${PARENT_BRANCH_LABEL}`,
    branch: null,
    isParent: true,
    workspaceKeys: [],
  };
  groups.set(PARENT_BRANCH_LABEL, parentGroup);

  const placements = input.placements ?? input.project.workspaces;
  for (const placement of placements) {
    const entry = input.workspaceEntriesByKey.get(placement.workspaceKey);
    const isParentWorkspace = entry?.workspaceKind === "local_checkout";
    const branch = isParentWorkspace ? PARENT_BRANCH_LABEL : (entry?.currentBranch ?? null);

    const label = branch ?? "";
    let group = groups.get(label);
    if (!group) {
      group = {
        key: `${input.project.viewKey}:${label || "other"}`,
        branch: entry?.currentBranch ?? null,
        isParent: false,
        workspaceKeys: [],
      };
      groups.set(label, group);
    }
    group.workspaceKeys.push(placement.workspaceKey);
  }

  const ordered: SidebarBranchGroup[] = [];
  const parent = groups.get(PARENT_BRANCH_LABEL);
  if (parent && parent.workspaceKeys.length > 0) {
    ordered.push(parent);
  }
  for (const [label, group] of groups) {
    if (label === PARENT_BRANCH_LABEL || group.workspaceKeys.length === 0) {
      continue;
    }
    ordered.push(group);
  }
  return ordered;
}

/** Stable key for a branch group's collapsed state. */
export function branchGroupCollapseKey(group: SidebarBranchGroup): string {
  return group.key;
}
