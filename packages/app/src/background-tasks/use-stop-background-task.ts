import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

export interface StopBackgroundTaskRequest {
  taskId: string;
  label: string;
}

/**
 * Stops one background task after a confirmation. A stopped shell cannot be resumed, and the
 * button sits next to rows the user may only have meant to read.
 *
 * The row disappears when the provider reports the shrunken set, not when this resolves, so the
 * panel never shows a task as gone while it is still running.
 */
export function useStopBackgroundTask(input: {
  serverId: string;
  agentId: string;
}): (request: StopBackgroundTaskRequest) => void {
  const { serverId, agentId } = input;
  const toast = useToast();

  return useCallback(
    (request: StopBackgroundTaskRequest) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: i18n.t("backgroundTasks.stopConfirmTitle"),
          message: i18n.t("backgroundTasks.stopConfirmMessage", { label: request.label }),
          confirmLabel: i18n.t("backgroundTasks.stopConfirmLabel"),
          cancelLabel: i18n.t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        try {
          const client = useSessionStore.getState().sessions[serverId]?.client;
          if (!client) {
            throw new Error(i18n.t("workspaceSetup.errors.hostDisconnected"));
          }
          await client.stopAgentBackgroundTask(agentId, request.taskId);
        } catch (error) {
          toast.error(toErrorMessage(error));
        }
      })();
    },
    [agentId, serverId, toast],
  );
}
