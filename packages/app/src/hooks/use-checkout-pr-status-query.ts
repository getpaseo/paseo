import { useQuery } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { CheckoutPrStatusResponse } from "@server/shared/messages";

const CHECKOUT_PR_STATUS_STALE_TIME = 20_000;
const WORKSPACE_PR_HINT_REFETCH_INTERVAL = 60_000;

function checkoutPrStatusQueryKey(serverId: string, cwd: string) {
  return ["checkoutPrStatus", serverId, cwd] as const;
}

interface UseCheckoutPrStatusQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export type CheckoutPrStatusPayload = CheckoutPrStatusResponse["payload"];
export interface PrHint {
  url: string;
  number: number;
  state: "open" | "merged" | "closed";
}

function parsePullRequestNumber(url: string): number | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }

    const number = Number.parseInt(match[1], 10);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function selectWorkspacePrHint(payload: CheckoutPrStatusPayload): PrHint | null {
  const status = payload.status;
  if (!status?.url) {
    return null;
  }

  const number = parsePullRequestNumber(status.url);
  if (number === null) {
    return null;
  }

  return {
    url: status.url,
    number,
    state:
      status.isMerged || status.state === "merged"
        ? "merged"
        : status.state === "open"
          ? "open"
          : "closed",
  };
}

export function useCheckoutPrStatusQuery({
  serverId,
  cwd,
  enabled = true,
}: UseCheckoutPrStatusQueryOptions) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: checkoutPrStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await client.checkoutPrStatus(cwd);
    },
    enabled: !!client && isConnected && !!cwd && enabled,
    staleTime: CHECKOUT_PR_STATUS_STALE_TIME,
    refetchInterval: 15_000,
  });

  return {
    status: query.data?.status ?? null,
    githubFeaturesEnabled: query.data?.githubFeaturesEnabled ?? true,
    payloadError: query.data?.error ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh: query.refetch,
  };
}

export function useWorkspacePrHint({
  serverId,
  cwd,
  enabled = true,
}: UseCheckoutPrStatusQueryOptions): PrHint | null {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery<CheckoutPrStatusPayload, Error, PrHint | null>({
    queryKey: checkoutPrStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await client.checkoutPrStatus(cwd);
    },
    enabled: !!client && isConnected && !!cwd && enabled,
    staleTime: CHECKOUT_PR_STATUS_STALE_TIME,
    refetchInterval: WORKSPACE_PR_HINT_REFETCH_INTERVAL,
    select: selectWorkspacePrHint,
  });

  return query.data ?? null;
}
