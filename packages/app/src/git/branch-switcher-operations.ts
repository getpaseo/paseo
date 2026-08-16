import type { WorkspaceGitClient } from "./workspace-git";

// Binds the branch switcher's git operations to a single workspace directory, so a
// workspace id can never be passed where a cwd is expected. `cwd` is set once here;
// callers choose the operation, never the directory.
export function createBranchSwitcherOperations(workspaceGit: WorkspaceGitClient) {
  return {
    getBranchSuggestions: (limit: number) => workspaceGit.getBranchSuggestions({ limit }),
    listPaseoStashes: () => workspaceGit.stashList({ paseoOnly: true }),
    saveStash: (branch: string | undefined) => workspaceGit.stashSave({ branch }),
    popStash: (stashIndex: number) => workspaceGit.stashPop(stashIndex),
    switchBranch: (branch: string) => workspaceGit.switchBranch(branch),
  };
}

export type BranchSwitcherOperations = ReturnType<typeof createBranchSwitcherOperations>;
