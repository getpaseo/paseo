import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { usePanelStore } from "@/stores/panel-store";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
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
  cwd: string;
}

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];

function fetchCheckoutStatus(
  client: { getCheckoutStatus: (cwd: string) => Promise<CheckoutStatusPayload> },
  cwd: string
): Promise<CheckoutStatusPayload> {
  return client.getCheckoutStatus(cwd);
}

export function useCheckoutStatusQuery({ serverId, cwd }: UseCheckoutStatusQueryOptions) {
  const { client, isConnected } = useHostRuntimeSession(serverId);
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const isOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;
  const shouldPoll = isOpen && explorerTab === "changes";

  const query = useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await fetchCheckoutStatus(client, cwd);
    },
    enabled: !!client && isConnected && !!cwd,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
    refetchInterval: (query) => {
      if (!shouldPoll) return false;
      const data = query.state.data as CheckoutStatusPayload | undefined;
      return data?.isGit ? 10_000 : false;
    },
    refetchIntervalInBackground: shouldPoll,
    refetchOnMount: "always",
  });

  // Revalidate when sidebar is open with "changes" tab active.
  const revalidationKey = useMemo(
    () => checkoutStatusRevalidationKey({ serverId, cwd, isOpen, explorerTab }),
    [serverId, cwd, isOpen, explorerTab]
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
export function useCheckoutStatusCacheOnly({ serverId, cwd }: UseCheckoutStatusQueryOptions) {
  const { client } = useHostRuntimeSession(serverId);

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
