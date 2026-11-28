import { useMemo } from "react";
import type { CheckoutWorktree } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";

/** An existing worktree, as the Worktree picker lists it. */
export interface ExistingWorktree {
  path: string;
  /** The branch it has checked out, or its directory name when HEAD is detached. */
  name: string;
  createdAt: Date | null;
}

interface WorktreeListClient {
  listCheckoutWorktrees(cwd: string): Promise<CheckoutWorktree[]>;
}

const NO_WORKTREES: readonly CheckoutWorktree[] = [];

/** Every git worktree of the project at `cwd`, whoever created it. Empty until it loads. */
export function useProjectWorktrees(input: {
  client: WorktreeListClient | null;
  serverId: string;
  cwd: string | null;
  enabled: boolean;
}): readonly CheckoutWorktree[] {
  const { client, serverId, cwd, enabled } = input;
  const query = useFetchQuery({
    dataShape: "list",
    queryKey: ["checkout-worktrees", serverId, cwd],
    queryFn: async () => {
      if (!client || !cwd) throw new Error("Choose a project");
      return client.listCheckoutWorktrees(cwd);
    },
    enabled: enabled && client !== null && cwd !== null,
    staleTimeMs: 15_000,
  });
  return query.data ?? NO_WORKTREES;
}

function directoryNameOf(path: string): string {
  return path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? path;
}

/**
 * The worktrees the Worktree picker offers, newest first. The project directory is left out: it
 * is the Project directory choice.
 */
export function useExistingWorktrees(
  worktrees: readonly CheckoutWorktree[],
): readonly ExistingWorktree[] {
  return useMemo(
    () =>
      worktrees
        .filter((worktree) => !worktree.containsCwd)
        .map((worktree) => {
          const createdAtMs = Date.parse(worktree.createdAt);
          return {
            path: worktree.path,
            name: worktree.branchName ?? directoryNameOf(worktree.path),
            createdAt: Number.isNaN(createdAtMs) ? null : new Date(createdAtMs),
          };
        })
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)),
    [worktrees],
  );
}
