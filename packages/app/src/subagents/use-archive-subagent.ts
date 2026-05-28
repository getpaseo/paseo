import { useCallback } from "react";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { requestArchiveSubagent, type ResolveArchiveSubagentDialogInput } from "./archive-subagent";

export { resolveArchiveSubagentDialog, requestArchiveSubagent } from "./archive-subagent";
export type {
  ArchiveSubagentDeps,
  RequestArchiveSubagentInput,
  ResolveArchiveSubagentDialogInput,
} from "./archive-subagent";

export interface UseArchiveSubagentInput {
  serverId: string;
}

export function useArchiveSubagent(input: UseArchiveSubagentInput): (subagentId: string) => void {
  const { archiveAgent } = useArchiveAgent();
  const { serverId } = input;

  return useCallback(
    (subagentId: string) => {
      void requestArchiveSubagent(
        { serverId, subagentId },
        {
          getSubagent: (id): ResolveArchiveSubagentDialogInput | undefined =>
            useSessionStore.getState().sessions[serverId]?.agents?.get(id),
          confirm: confirmDialog,
          archiveAgent,
        },
      );
    },
    [archiveAgent, serverId],
  );
}
