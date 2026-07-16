import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { checkoutCommitFileDiffQueryKey } from "@/git/query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// A commit's file diff is immutable for a given sha+path, so it can stay cached
// for the lifetime of the view without refetching.
const COMMIT_FILE_DIFF_STALE_TIME = 5 * 60_000;

interface UseCommitFileDiffOptions {
  serverId: string;
  cwd: string;
  sha: string;
  path: string;
  enabled?: boolean;
}

export interface CommitFileDiffResult {
  file: ParsedDiffFile | null;
  isLoading: boolean;
  error: Error | null;
}

export function useCommitFileDiff({
  serverId,
  cwd,
  sha,
  path,
  enabled = true,
}: UseCommitFileDiffOptions): CommitFileDiffResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(commitsList): added in v0.1.110, remove gate after 2027-01-16.
  // The commits section is already capability-gated; this keeps the hook safe if
  // ever called standalone without the capability present.
  const capabilityPresent = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.commitsList === true,
  );

  const queryEnabled =
    enabled &&
    capabilityPresent &&
    Boolean(cwd) &&
    Boolean(sha) &&
    Boolean(path) &&
    Boolean(client) &&
    isConnected;

  const query = useFetchQuery<{ file: ParsedDiffFile | null }>({
    queryKey: checkoutCommitFileDiffQueryKey(serverId, cwd, sha, path),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      return client.getCommitFileDiff(cwd, sha, path);
    },
    enabled: queryEnabled,
    staleTimeMs: COMMIT_FILE_DIFF_STALE_TIME,
    dataShape: "value",
  });

  return {
    file: query.data?.file ?? null,
    isLoading: queryEnabled && query.isLoading,
    error: query.error,
  };
}
