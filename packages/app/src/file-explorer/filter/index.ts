import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FILE_FILTER_QUERY_KEY } from "./internal/results";
import { useFileFilterStore } from "./internal/store";

export { FileFilterField } from "./internal/field";
export { FileFilterResults } from "./internal/results";
export type { FileFilterMatch } from "./internal/model";

/** The query narrowing a workspace's Files list; empty while the tree shows. */
export function useFileFilterQuery(stateKey: string | null): string {
  return useFileFilterStore((state) =>
    stateKey ? (state.queryByStateKey[stateKey] ?? "").trim() : "",
  );
}

/** Back to the tree: whatever needs a tree row on screen calls this. */
export function clearFileFilter(stateKey: string): void {
  useFileFilterStore.getState().setQuery(stateKey, "");
}

/** Searches again after something changed the workspace's files. */
export function useRefreshFileFilterResults(serverId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: [FILE_FILTER_QUERY_KEY, serverId] }),
    [queryClient, serverId],
  );
}
