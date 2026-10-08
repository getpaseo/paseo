import { slugify } from "@getpaseo/protocol/branch-slug";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { PickerItem } from "../new-workspace-picker-item";

export interface ExistingWorktree {
  worktreePath: string;
  branchName?: string | null;
  head?: string | null;
}

/** Owns explicit branch intent and editable names independently of async picker data. */
export function openWorktreeForm(initialBranch: string) {
  const listeners = new Set<() => void>();
  let state = {
    mode: "branch-off" as "branch-off" | "checkout",
    branchName: initialBranch,
    checkoutBranch: "",
    worktreeName: slugify(initialBranch),
    nameEdited: false,
    existing: null as ExistingWorktree | null,
    scope: "",
  };
  function publish(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    if (!state.nameEdited) {
      state.worktreeName = slugify(
        state.mode === "branch-off" ? state.branchName : state.checkoutBranch,
      );
    }
    listeners.forEach((listener) => listener());
  }
  return {
    getState: () => state,
    // An older host must not silently discard choices made on a capable host.
    requiresCapability: () =>
      state.existing !== null ||
      state.mode === "checkout" ||
      state.nameEdited ||
      state.branchName !== initialBranch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => listeners.clear(),
    applyScope(scope: string) {
      if (scope === state.scope) return;
      // Checkout intent belongs to its repository. Keep typed names, but recompute defaults.
      publish({ scope, existing: null, mode: "branch-off", checkoutBranch: "" });
    },
    applyRef(item: PickerItem | null) {
      const checkoutBranch =
        item?.kind === "branch"
          ? item.refName.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "")
          : (item?.item.headRefName ?? "");
      if (checkoutBranch !== state.checkoutBranch) publish({ checkoutBranch });
    },
    setMode: (mode: typeof state.mode) => publish({ mode }),
    setBranchName: (branchName: string) => publish({ branchName }),
    setWorktreeName: (worktreeName: string) => publish({ worktreeName, nameEdited: true }),
    selectExisting: (existing: ExistingWorktree | null) => publish({ existing }),
  };
}

export type WorktreeFormModel = ReturnType<typeof openWorktreeForm>;

/** Validates exact names and branch occupancy before submission; the host repeats Git checks. */
export function worktreeFormError(
  state: ReturnType<WorktreeFormModel["getState"]>,
  worktrees: readonly ExistingWorktree[],
): string | null {
  if (state.mode === "branch-off" && !state.branchName.trim()) return "Enter a new branch name.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.worktreeName) || state.worktreeName.length > 50) {
    return "Worktree name must use lowercase letters, numbers and single hyphens (max 50 characters).";
  }
  if (state.mode === "checkout") {
    if (!state.checkoutBranch) return "Choose an existing branch.";
    const occupied = worktrees.find((entry) => entry.branchName === state.checkoutBranch);
    if (occupied)
      return `Branch already checked out at ${occupied.worktreePath}. Select its existing worktree instead.`;
  }
  return null;
}

/** Produces the existing workspace transport without creating a worktree for adoption. */
export function worktreeFormSource(
  state: ReturnType<WorktreeFormModel["getState"]>,
  input: { cwd: string; projectId: string; refName?: string },
): CreateWorkspaceRequestOptions["source"] {
  if (state.existing)
    return { kind: "directory", path: state.existing.worktreePath, projectId: input.projectId };
  return {
    kind: "worktree",
    cwd: input.cwd,
    projectId: input.projectId,
    exactNames: true,
    worktreeSlug: state.worktreeName,
    action: state.mode,
    refName: state.mode === "checkout" ? state.checkoutBranch : input.refName,
    ...(state.mode === "branch-off" ? { branchName: state.branchName.trim() } : {}),
  };
}
