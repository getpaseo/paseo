import { useQuery } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
import type { CheckoutPrStatusResponse } from "@server/shared/messages";

const CHECKOUT_PR_STATUS_STALE_TIME = 20_000;

function checkoutPrStatusQueryKey(serverId: string, agentId: string) {
  return ["checkoutPrStatus", serverId, agentId] as const;
}

interface UseCheckoutPrStatusQueryOptions {
  serverId: string;
  agentId: string;
  enabled?: boolean;
}

export type CheckoutPrStatusPayload = CheckoutPrStatusResponse["payload"];

export function useCheckoutPrStatusQuery({
  serverId,
  agentId,
  enabled = true,
}: UseCheckoutPrStatusQueryOptions) {
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );

  const query = useQuery({
    queryKey: checkoutPrStatusQueryKey(serverId, agentId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await client.checkoutPrStatus(agentId);
    },
    enabled: !!client && isConnected && !!agentId && enabled,
    staleTime: CHECKOUT_PR_STATUS_STALE_TIME,
    refetchInterval: 15_000,
  });

  return {
    status: query.data?.status ?? null,
    payloadError: query.data?.error ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh: query.refetch,
  };
}
