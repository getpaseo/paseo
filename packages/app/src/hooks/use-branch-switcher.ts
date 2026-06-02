import { useState, useCallback, useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { ToastApi } from "@/components/toast-host";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { confirmDialog } from "@/utils/confirm-dialog";

interface UseBranchSwitcherInput {
  client: DaemonClient | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  currentBranchName: string | null;
  isGitCheckout: boolean;
  isConnected: boolean;
  toast: ToastApi;
  queryClient: QueryClient;
}

interface UseBranchSwitcherResult {
  branchOptions: ComboboxOption[];
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  handleBranchSelect: (branchId: string) => void;
  invalidateStashAndCheckout: () => Promise<void>;
}

export function useBranchSwitcher({
  client,
  normalizedServerId,
  normalizedWorkspaceId,
  currentBranchName,
  isGitCheckout,
  isConnected,
  toast,
  queryClient,
}: UseBranchSwitcherInput): UseBranchSwitcherResult {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const branchSuggestionsQuery = useQuery({
    queryKey: ["branchSuggestions", normalizedServerId, normalizedWorkspaceId],
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.getBranchSuggestions({
        cwd: normalizedWorkspaceId,
        limit: 200,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.branches ?? [];
    },
    enabled: isOpen && isGitCheckout && Boolean(client) && isConnected,
    retry: false,
    staleTime: 15_000,
  });

  const branchOptions = useMemo<ComboboxOption[]>(() => {
    const branches = branchSuggestionsQuery.data ?? [];
    return branches.map((name) => ({ id: name, label: name }));
  }, [branchSuggestionsQuery.data]);

  const stashListQueryKey = useMemo(
    () => ["stashList", normalizedServerId, normalizedWorkspaceId] as const,
    [normalizedServerId, normalizedWorkspaceId],
  );

  const invalidateStashAndCheckout = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: stashListQueryKey }),
      invalidateCheckoutGitQueriesForClient(queryClient, {
        serverId: normalizedServerId,
        cwd: normalizedWorkspaceId,
      }),
    ]);
  }, [queryClient, stashListQueryKey, normalizedServerId, normalizedWorkspaceId]);

  const maybeRestoreStashForBranch = useCallback(
    async (branchId: string) => {
      if (!client) return;
      try {
        const stashPayload = await client.stashList(normalizedWorkspaceId, { paseoOnly: true });
        const targetStash = stashPayload.entries.find((e) => e.branch === branchId);
        if (!targetStash) return;
        const shouldRestore = await confirmDialog({
          title: t("branchSwitcher.restoreStashTitle"),
          message: t("branchSwitcher.restoreStashMessage"),
          confirmLabel: t("branchSwitcher.restore"),
          cancelLabel: t("branchSwitcher.later"),
        });
        if (!shouldRestore) return;
        const popPayload = await client.stashPop(normalizedWorkspaceId, targetStash.index);
        if (popPayload.error) {
          toast.error(popPayload.error.message);
        } else {
          toast.show(t("branchSwitcher.stashRestored"));
        }
        await invalidateStashAndCheckout();
      } catch {
        // Non-critical — user can still restore on next branch switch
      }
    },
    [client, invalidateStashAndCheckout, normalizedWorkspaceId, toast, t],
  );

  const stashAndSwitch = useCallback(
    async (branchId: string) => {
      if (!client) return;
      const shouldStash = await confirmDialog({
        title: t("branchSwitcher.uncommittedTitle"),
        message: t("branchSwitcher.uncommittedMessage"),
        confirmLabel: t("branchSwitcher.stashAndSwitch"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!shouldStash) return;

      try {
        const stashPayload = await client.stashSave(normalizedWorkspaceId, {
          branch: currentBranchName ?? undefined,
        });
        if (stashPayload.error) {
          toast.error(stashPayload.error.message);
          return;
        }
        await invalidateStashAndCheckout();
        const switchPayload = await client.checkoutSwitchBranch(normalizedWorkspaceId, branchId);
        if (switchPayload.error) {
          toast.error(switchPayload.error.message);
          return;
        }
        await invalidateStashAndCheckout();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("branchSwitcher.failedToStash"));
      }
    },
    [client, currentBranchName, invalidateStashAndCheckout, normalizedWorkspaceId, toast, t],
  );

  const handleBranchSelect = useCallback(
    (branchId: string) => {
      if (branchId === currentBranchName) return;

      void (async () => {
        if (!client) return;
        try {
          const payload = await client.checkoutSwitchBranch(normalizedWorkspaceId, branchId);
          if (payload.error) {
            // If the error is about uncommitted changes, offer the stash dialog
            if (payload.error.message.toLowerCase().includes("uncommitted")) {
              await stashAndSwitch(branchId);
              return;
            }
            toast.error(payload.error.message);
            return;
          }
          // Success — refresh and check for stashes on the target branch
          await invalidateStashAndCheckout();
          await maybeRestoreStashForBranch(branchId);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t("branchSwitcher.failedToSwitch"));
        }
      })();
    },
    [
      client,
      currentBranchName,
      invalidateStashAndCheckout,
      maybeRestoreStashForBranch,
      normalizedWorkspaceId,
      stashAndSwitch,
      t,
      toast,
    ],
  );

  return { branchOptions, isOpen, setIsOpen, handleBranchSelect, invalidateStashAndCheckout };
}
