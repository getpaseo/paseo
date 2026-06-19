import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
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

  return useCallback(
    (subagentId: string) => {
      void requestDetachSubagent(
        { serverId, subagentId },
        {
          getSubagent: (id): ResolveDetachSubagentDialogInput | undefined =>
            useSessionStore.getState().sessions[serverId]?.agents?.get(id),
          confirm: confirmDialog,
          detachAgent: async ({ serverId: targetServerId, agentId }) => {
            const client = useSessionStore.getState().sessions[targetServerId]?.client;
            if (!client) {
              throw new Error("Host is not connected");
            }
            await client.detachAgent(agentId);
          },
        },
      );
    },
    [serverId],
  );
}
