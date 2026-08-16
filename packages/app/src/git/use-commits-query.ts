import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { checkoutCommitsQueryKey } from "@/git/query-keys";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useRequiredWorkspaceGit } from "@/git/workspace-git";

// Commits ahead of base change rarely while the section is open; this keeps a
// collapse/re-expand cycle warm without leaving the fetch result stale for long.
const CHECKOUT_COMMITS_STALE_TIME = 30_000;

interface UseCheckoutCommitsQueryOptions {
  serverId: string;
  enabled?: boolean;
}

export interface CheckoutCommitsData {
  baseRef: string | null;
  commits: ClassifiedCheckoutCommit[];
}

export interface ClassifiedCheckoutCommit extends CheckoutCommit {
  isOnBase: boolean;
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
  enabled = true,
}: UseCheckoutCommitsQueryOptions): CheckoutCommitsQueryResult {
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabledByCaller = enabled && retainedPanelActive;
  const workspaceGit = useRequiredWorkspaceGit();
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(commitsList): added in v0.1.110, remove after 2027-01-16.
  // COMPAT(commitBaseClassification): added in v0.2.0, remove after 2027-01-23.
  // Single capability-detection site; downstream reads a clean load-state union.
  const capabilityPresent = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.features?.commitsList === true &&
      state.sessions[serverId]?.serverInfo?.features?.commitBaseClassification === true,
  );

  const canFetch = Boolean(workspaceGit) && isConnected;
  const queryEnabled = queryEnabledByCaller && capabilityPresent && canFetch;

  const query = useFetchQuery<CheckoutCommitsData>({
    queryKey: checkoutCommitsQueryKey(serverId, workspaceGit),
    queryFn: async () => {
      if (!workspaceGit) {
        throw new Error("Host disconnected");
      }
      const data = await workspaceGit.listCommits();
      const commits = data.commits.map((commit) => {
        invariant(commit.isOnBase !== undefined, "Host omitted commit base classification");
        return { ...commit, isOnBase: commit.isOnBase };
      });
      return { baseRef: data.baseRef, commits };
    },
    enabled: queryEnabled,
    staleTimeMs: CHECKOUT_COMMITS_STALE_TIME,
    dataShape: "list",
  });

  return resolveCheckoutCommitsQueryResult({
    enabled: queryEnabledByCaller,
    capabilityPresent,
    canFetch,
    data: query.data,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
  });
}
