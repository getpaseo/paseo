import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { getHostClient } from "@/runtime/host-runtime";
import { getAgentSnapshot } from "@/runtime/session-data";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { requestDetachSubagent, type ResolveDetachSubagentDialogInput } from "./detach-subagent";

export { resolveDetachSubagentDialog, requestDetachSubagent } from "./detach-subagent";
export type {
  DetachSubagentDeps,
  RequestDetachSubagentInput,
  ResolveDetachSubagentDialogInput,
} from "./detach-subagent";

export interface UseDetachSubagentInput {
  serverId: string;
}

export function useDetachSubagent(input: UseDetachSubagentInput): (subagentId: string) => void {
  const { serverId } = input;
  const toast = useToast();

  return useCallback(
    (subagentId: string) => {
      void requestDetachSubagent(
        { serverId, subagentId },
        {
          getSubagent: (id): ResolveDetachSubagentDialogInput | undefined =>
            getAgentSnapshot(serverId, id) ?? undefined,
          confirm: confirmDialog,
          detachAgent: async ({ agentId }) => {
            const client = getHostClient(serverId);
            if (!client) {
              throw new Error(i18n.t("workspaceSetup.errors.hostDisconnected"));
            }
            await client.detachAgent(agentId);
          },
          openDetachedAgent: ({ serverId: targetServerId, agentId }) => {
            navigateToAgent({ serverId: targetServerId, agentId });
          },
          reportError: (error) => {
            toast.error(toErrorMessage(error));
          },
        },
      );
    },
    [serverId, toast],
  );
}
