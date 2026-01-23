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
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const isOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;

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
