import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import type { CheckoutStatusResponse } from "@server/shared/messages";
import {
  checkoutStatusRevalidationKey,
  nextCheckoutStatusRefetchDecision,
} from "./checkout-status-revalidation";

export const CHECKOUT_STATUS_STALE_TIME = 15_000;

export function checkoutStatusQueryKey(serverId: string, cwd: string) {
  return ["checkoutStatus", serverId, cwd] as const;
}

interface UseCheckoutStatusQueryOptions {
  serverId: string;
  agentId: string;
  cwd: string;
}

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];

function fetchCheckoutStatus(
  client: { getCheckoutStatus: (agentId: string) => Promise<CheckoutStatusPayload> },
  agentId: string
): Promise<CheckoutStatusPayload> {
  return client.getCheckoutStatus(agentId);
}

export function useCheckoutStatusQuery({ serverId, agentId, cwd }: UseCheckoutStatusQueryOptions) {
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const isOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;

  const query = useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await fetchCheckoutStatus(client, agentId);
    },
    enabled: !!client && isConnected && !!agentId && !!cwd,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnMount: "always",
  });

  // Revalidate when sidebar is open with "changes" tab active.
  const revalidationKey = useMemo(
    () => checkoutStatusRevalidationKey({ serverId, agentId, isOpen, explorerTab }),
    [serverId, agentId, isOpen, explorerTab]
  );
  const lastRevalidationKey = useRef<string | null>(null);
  useEffect(() => {
    const decision = nextCheckoutStatusRefetchDecision(lastRevalidationKey.current, revalidationKey);
    lastRevalidationKey.current = decision.nextSeenKey;
    if (!decision.shouldRefetch) return;
    void query.refetch();
  }, [revalidationKey, query.refetch]);

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh: query.refetch,
  };
}

/**
 * Subscribe to checkout status updates from the React Query cache without
 * initiating a fetch. Useful for list rows where a parent component prefetches
 * only the visible agents.
 */
export function useCheckoutStatusCacheOnly({ serverId, agentId, cwd }: UseCheckoutStatusQueryOptions) {
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );

  return useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await fetchCheckoutStatus(client, agentId);
    },
    enabled: false,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
  });
}
