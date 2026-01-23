import { useQuery } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
import type { CheckoutStatusResponse } from "@server/shared/messages";

const CHECKOUT_STATUS_STALE_TIME = 15_000;

function checkoutStatusQueryKey(serverId: string, agentId: string) {
  return ["checkoutStatus", serverId, agentId] as const;
}

interface UseCheckoutStatusQueryOptions {
  serverId: string;
  agentId: string;
}

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];

export function useCheckoutStatusQuery({ serverId, agentId }: UseCheckoutStatusQueryOptions) {
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );

  const query = useQuery({
    queryKey: checkoutStatusQueryKey(serverId, agentId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await client.getCheckoutStatus(agentId);
    },
    enabled: !!client && isConnected && !!agentId,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
    refetchInterval: 10_000,
  });

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh: query.refetch,
  };
}
