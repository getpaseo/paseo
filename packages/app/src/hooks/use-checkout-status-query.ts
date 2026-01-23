import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
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
  useEffect(() => {
    if (!isOpen || explorerTab !== "changes" || !agentId) {
      return;
    }
    void query.refetch();
  }, [isOpen, explorerTab, agentId, query]);

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh: query.refetch,
  };
}
