import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import type { CheckoutDiffResponse } from "@server/shared/messages";

const CHECKOUT_DIFF_STALE_TIME = 30_000;

function checkoutDiffQueryKey(
  serverId: string,
  agentId: string,
  mode: "uncommitted" | "base",
  baseRef?: string
) {
  return ["checkoutDiff", serverId, agentId, mode, baseRef ?? ""] as const;
}

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  agentId: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  enabled?: boolean;
}

export type ParsedDiffFile = CheckoutDiffResponse["payload"]["files"][number];
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

export function useCheckoutDiffQuery({
  serverId,
  agentId,
  mode,
  baseRef,
  enabled = true,
}: UseCheckoutDiffQueryOptions) {
  const queryClient = useQueryClient();
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
    queryKey: checkoutDiffQueryKey(serverId, agentId, mode, baseRef),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await client.getCheckoutDiff(agentId, { mode, baseRef });
    },
    enabled: !!client && isConnected && !!agentId && enabled,
    staleTime: CHECKOUT_DIFF_STALE_TIME,
    refetchInterval: 10_000,
  });

  // Revalidate when sidebar opens with "changes" tab active
  useEffect(() => {
    if (!isOpen || explorerTab !== "changes" || !agentId) {
      return;
    }
    queryClient.invalidateQueries({
      queryKey: checkoutDiffQueryKey(serverId, agentId, mode, baseRef),
    });
  }, [isOpen, explorerTab, serverId, agentId, mode, baseRef, queryClient]);

  const refresh = useCallback(() => {
    return query.refetch();
  }, [query]);

  const payload = query.data ?? null;
  const payloadError = payload?.error ?? null;

  return {
    files: payload?.files ?? [],
    payloadError,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError || Boolean(payloadError),
    error: query.error,
    refresh,
  };
}
