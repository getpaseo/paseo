import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import { fetchCheckoutStatus } from "@/git/checkout-status-cache";
import { canCreateWorkspaceTerminal } from "@/screens/workspace/terminals/state";
import type { WorkspaceGitClient } from "@/git/workspace-git";

interface UseWorkspaceCheckoutStatusInput {
  workspaceGit: WorkspaceGitClient | null;
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
        client: input.workspaceGit,
        isConnected: input.isConnected,
        workspaceDirectory: input.workspaceDirectory,
      }),
    [input.isConnected, input.isRouteFocused, input.workspaceDirectory, input.workspaceGit],
  );
  const checkoutQuery = useQuery({
    queryKey: input.workspaceGit
      ? checkoutStatusQueryKey(input.normalizedServerId, input.workspaceGit)
      : (["checkoutStatus", input.normalizedServerId, "unbound"] as const),
    enabled: isCheckoutQueryEnabled,
    queryFn: async () => {
      if (!input.workspaceGit) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return await fetchCheckoutStatus({
        client: input.workspaceGit,
        serverId: input.normalizedServerId,
        target: input.workspaceGit,
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
