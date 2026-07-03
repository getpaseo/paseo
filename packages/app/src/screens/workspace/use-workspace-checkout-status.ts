import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import { fetchCheckoutStatus } from "@/git/checkout-status-cache";
import { canCreateWorkspaceTerminal } from "@/screens/workspace/terminals/state";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

interface UseWorkspaceCheckoutStatusInput {
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  isRouteFocused: boolean;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceDirectory: string | null;
}

export function useWorkspaceCheckoutStatus(input: UseWorkspaceCheckoutStatusInput) {
  const { t } = useTranslation();
  const isCheckoutQueryEnabled = useMemo(
    () =>
      canCreateWorkspaceTerminal({
        isRouteFocused: input.isRouteFocused,
        client: input.client,
        isConnected: input.isConnected,
        workspaceDirectory: input.workspaceDirectory,
      }),
    [input.client, input.isConnected, input.isRouteFocused, input.workspaceDirectory],
  );
  const checkoutQuery = useQuery({
    queryKey: checkoutStatusQueryKey(
      input.normalizedServerId,
      input.workspaceDirectory ?? `missing-workspace-directory:${input.normalizedWorkspaceId}`,
    ),
    enabled: isCheckoutQueryEnabled,
    queryFn: async () => {
      if (!input.client || !input.workspaceDirectory) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return await fetchCheckoutStatus({
        client: input.client,
        serverId: input.normalizedServerId,
        cwd: input.workspaceDirectory,
      });
    },
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const isCheckoutStatusLoading = useMemo(
    () => isCheckoutQueryEnabled && checkoutQuery.data === undefined && !checkoutQuery.isError,
    [checkoutQuery.data, checkoutQuery.isError, isCheckoutQueryEnabled],
  );

  return { checkoutQuery, isCheckoutStatusLoading };
}
