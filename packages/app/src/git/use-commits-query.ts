import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { checkoutCommitsQueryKey } from "@/git/query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// Commits ahead of base change rarely while the section is open; this keeps a
// collapse/re-expand cycle warm without leaving the fetch result stale for long.
const CHECKOUT_COMMITS_STALE_TIME = 30_000;

interface UseCheckoutCommitsQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export interface CheckoutCommitsData {
  baseRef: string | null;
  commits: CheckoutCommit[];
}

export type CheckoutCommitsQueryResult =
  | { status: "unsupported" }
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "loaded"; data: CheckoutCommitsData };

interface ResolveCheckoutCommitsQueryResultInput {
  enabled: boolean;
  capabilityPresent: boolean;
  canFetch: boolean;
  data: CheckoutCommitsData | undefined;
  isPlaceholderData: boolean;
  error: Error | null;
}

export function resolveCheckoutCommitsQueryResult({
  enabled,
  capabilityPresent,
  canFetch,
  data,
  isPlaceholderData,
  error,
}: ResolveCheckoutCommitsQueryResultInput): CheckoutCommitsQueryResult {
  if (!capabilityPresent) {
    return { status: "unsupported" };
  }
  if (data && !isPlaceholderData) {
    return { status: "loaded", data };
  }
  if (!enabled) {
    return { status: "idle" };
  }
  if (!canFetch) {
    return { status: "connecting" };
  }
  if (error) {
    return { status: "error", error };
  }
  return { status: "loading" };
}

export function useCheckoutCommitsQuery({
  serverId,
  cwd,
  enabled = true,
}: UseCheckoutCommitsQueryOptions): CheckoutCommitsQueryResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(commitsList): added in v0.1.110, remove gate after 2027-01-16.
  // Single capability-detection site; downstream reads a clean load-state union.
  const capabilityPresent = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.commitsList === true,
  );

  const canFetch = Boolean(cwd) && Boolean(client) && isConnected;
  const queryEnabled = enabled && capabilityPresent && canFetch;

  const query = useFetchQuery<CheckoutCommitsData>({
    queryKey: checkoutCommitsQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      return client.listCheckoutCommits(cwd);
    },
    enabled: queryEnabled,
    staleTimeMs: CHECKOUT_COMMITS_STALE_TIME,
    dataShape: "list",
  });

  return resolveCheckoutCommitsQueryResult({
    enabled,
    capabilityPresent,
    canFetch,
    data: query.data,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
  });
}
