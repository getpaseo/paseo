import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { selectExistingWorktrees, type ExistingWorktree } from "./isolation";

interface WorktreeListClient {
  getPaseoWorktreeList(input: { cwd: string; scope: "repo" }): Promise<{
    worktrees: { worktreePath: string; branchName?: string | null; isMainWorktree?: boolean }[];
  }>;
}

/**
 * The repository's worktrees, offered as workspace placements. Listed for the
 * whole repository rather than Paseo's own worktree root, so one cut by hand
 * shows up next to the ones Paseo made.
 */
export function useExistingWorktrees(input: {
  serverId: string;
  sourceDirectory: string | null;
  client: WorktreeListClient | null;
  clientReady: boolean;
  // Held to the picker being open: a list fetched earlier can name a directory
  // that has since been archived or deleted.
  pickerOpen: boolean;
  // COMPAT(worktreeListRepoScope): added in v0.6.2, drop the gate when floor >= v0.6.2.
  supported: boolean;
}): ExistingWorktree[] {
  const { serverId, sourceDirectory, client, clientReady, pickerOpen, supported } = input;
  const enabled = pickerOpen && supported && clientReady && client !== null;
  const query = useFetchQuery({
    queryKey: ["repo-worktrees", serverId, sourceDirectory],
    dataShape: "list",
    queryFn: async () => {
      if (!client || !sourceDirectory) {
        throw new Error("Choose a project");
      }
      return client.getPaseoWorktreeList({ cwd: sourceDirectory, scope: "repo" });
    },
    enabled: enabled && sourceDirectory !== null,
    staleTimeMs: 15_000,
  });

  return useMemo(
    () => selectExistingWorktrees({ worktrees: query.data?.worktrees ?? [], sourceDirectory }),
    [query.data?.worktrees, sourceDirectory],
  );
}
