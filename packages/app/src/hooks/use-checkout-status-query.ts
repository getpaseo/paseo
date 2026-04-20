import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { CheckoutStatusResponse } from "@server/shared/messages";

export const CHECKOUT_STATUS_STALE_TIME = 15_000;

export function checkoutStatusQueryKey(serverId: string, cwd: string) {
  return ["checkoutStatus", serverId, cwd] as const;
}

interface UseCheckoutStatusQueryOptions {
  serverId: string;
  cwd: string;
}

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];

interface CheckoutStatusClient {
  getCheckoutStatus: (cwd: string) => Promise<CheckoutStatusPayload>;
}

function fetchCheckoutStatus(
  client: CheckoutStatusClient,
  cwd: string,
): Promise<CheckoutStatusPayload> {
  return client.getCheckoutStatus(cwd);
}

async function peekOrFetchSnapshot({
  queryClient,
  client,
  serverId,
  cwd,
}: {
  queryClient: QueryClient;
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  const queryKey = checkoutStatusQueryKey(serverId, cwd);
  const cached = queryClient.getQueryData<CheckoutStatusPayload>(queryKey);
  if (cached) {
    return cached;
  }

  const snapshot = await fetchCheckoutStatus(client, cwd);
  queryClient.setQueryData(queryKey, snapshot);
  return snapshot;
}

export function useCheckoutStatusQuery({ serverId, cwd }: UseCheckoutStatusQueryOptions) {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  useEffect(() => {
    if (!client || !isConnected || !cwd) {
      return;
    }

    return client.on("checkout_status_update", (message) => {
      if (message.payload.cwd !== cwd) {
        return;
      }
      queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), message.payload);
    });
  }, [client, isConnected, cwd, queryClient, serverId]);

  const query = useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await peekOrFetchSnapshot({ queryClient, client, serverId, cwd });
    },
    enabled: !!client && isConnected && !!cwd,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}

/**
 * Subscribe to checkout status updates from the React Query cache without
 * initiating a fetch. Useful for list rows where a parent component prefetches
 * only the visible agents.
 */
export function useCheckoutStatusCacheOnly({ serverId, cwd }: UseCheckoutStatusQueryOptions) {
  const client = useHostRuntimeClient(serverId);

  return useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await fetchCheckoutStatus(client, cwd);
    },
    enabled: false,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
  });
}
