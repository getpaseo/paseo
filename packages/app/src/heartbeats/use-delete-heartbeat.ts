import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { requestDeleteHeartbeat } from "./delete-heartbeat";
import type { AgentHeartbeatRow } from "./select";

export function useDeleteHeartbeat({
  serverId,
}: {
  serverId: string;
}): (row: AgentHeartbeatRow) => void {
  const { deleteSchedule } = useScheduleMutations({ serverId });
  const toast = useToast();

  return useCallback(
    (row: AgentHeartbeatRow) => {
      void requestDeleteHeartbeat(
        { serverId: row.serverId, scheduleId: row.scheduleId, title: row.title },
        {
          confirm: confirmDialog,
          deleteHeartbeat: ({ scheduleId }) => deleteSchedule(scheduleId),
          reportError: (error) => {
            toast.error(toErrorMessage(error));
          },
        },
      );
    },
    [deleteSchedule, toast],
  );
}
