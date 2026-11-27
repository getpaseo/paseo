import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import { useToast } from "@/contexts/toast-api-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { pluginDisplayName, pluginListQueryKey } from "@/plugins/plugin-list";
import { confirmDialog } from "@/utils/confirm-dialog";
import { pluginErrorText } from "./error-text";
import { dismissFailedOperation } from "./operations";

export type PluginAction = "enable" | "disable" | "reload" | "remove";

/**
 * Turning a plugin on or off, reloading and removing it. Each action writes its result into the
 * plugin list, so every row and page showing the plugin agrees. Toggling says nothing; the switch
 * already shows the result.
 */
export function usePluginActions(serverId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const [pending, setPending] = useState<{ pluginId: string; action: PluginAction } | null>(null);

  const replace = useCallback(
    (plugin: PluginListItem) =>
      queryClient.setQueryData<PluginListItem[]>(pluginListQueryKey(serverId), (plugins) =>
        plugins?.map((candidate) => (candidate.id === plugin.id ? plugin : candidate)),
      ),
    [queryClient, serverId],
  );

  const run = useCallback(
    /** Resolves true once the action is done; false when it was cancelled or failed. */
    async (action: PluginAction, plugin: PluginListItem): Promise<boolean> => {
      if (!client) return false;
      const name = pluginDisplayName(plugin);
      if (action === "remove") {
        const confirmed = await confirmDialog({
          title: t("settings.plugins.removeConfirmTitle", { name }),
          // A plugin installed from a source has its download deleted; a local folder is kept.
          message: plugin.installation
            ? t("settings.plugins.removeConfirmMessage")
            : t("settings.plugins.removeConfirmLocalMessage"),
          confirmLabel: t("settings.plugins.actions.remove"),
          destructive: true,
        });
        if (!confirmed) return false;
      }
      setPending({ pluginId: plugin.id, action });
      try {
        if (action === "remove") {
          await client.removePlugin(plugin.id);
          // A failed update belonged to this installation, not to a later one with the same ID.
          dismissFailedOperation(serverId, plugin.id);
          queryClient.setQueryData<PluginListItem[]>(pluginListQueryKey(serverId), (plugins) =>
            plugins?.filter((candidate) => candidate.id !== plugin.id),
          );
          toast.show(t("settings.plugins.feedback.remove", { name }), { variant: "success" });
        } else {
          replace(await client[`${action}Plugin`](plugin.id));
          if (action === "reload")
            toast.show(t("settings.plugins.feedback.reload", { name }), { variant: "success" });
        }
        return true;
      } catch (error) {
        toast.error(pluginErrorText(error));
        return false;
      } finally {
        setPending(null);
      }
    },
    [client, queryClient, replace, serverId, t, toast],
  );

  return useMemo(() => ({ run, pending }), [pending, run]);
}
