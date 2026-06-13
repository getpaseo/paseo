import { useQuery } from "@tanstack/react-query";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { checkoutCommitsQueryKey } from "@/git/query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// Commits ahead of base change rarely within a single view; a modest staleTime
// avoids refetching on every remount while staying fresh enough after a commit.
const CHECKOUT_COMMITS_STALE_TIME = 30_000;

interface UseCheckoutCommitsQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export interface CheckoutCommitsQueryResult {
  commits: CheckoutCommit[];
  isLoading: boolean;
  capabilityMissing: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useCheckoutCommitsQuery({
  serverId,
  cwd,
  enabled = true,
}: UseCheckoutCommitsQueryOptions): CheckoutCommitsQueryResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(commitsList): added in v0.1.97, drop the gate when floor >= v0.1.97.
  // Single capability-detection site; downstream reads a clean `capabilityMissing` shape.
  const capabilityPresent = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.commitsList === true,
  );

  const queryEnabled =
    enabled && capabilityPresent && Boolean(cwd) && Boolean(client) && isConnected;

  const query = useQuery<{ baseRef: string | null; commits: CheckoutCommit[] }>({
    queryKey: checkoutCommitsQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      return client.listCheckoutCommits(cwd);
    },
    enabled: queryEnabled,
    staleTime: CHECKOUT_COMMITS_STALE_TIME,
  });

  return {
    commits: query.data?.commits ?? [],
    isLoading: queryEnabled && query.isLoading,
    capabilityMissing: !capabilityPresent,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
