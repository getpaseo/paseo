import { resolveDeleteScheduleDialog } from "@/schedules/delete-schedule";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface DeleteHeartbeatDeps {
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  deleteHeartbeat: (input: { serverId: string; scheduleId: string }) => Promise<void>;
  reportError: (error: unknown) => void;
}

export interface RequestDeleteHeartbeatInput {
  serverId: string;
  scheduleId: string;
  title: string;
}

/**
 * Confirm, then delete through the shared schedule mutation, which removes the
 * row optimistically and restores it when the daemon rejects the write. A
 * rejected delete is reported to the user rather than thrown at the caller.
 */
export async function requestDeleteHeartbeat(
  input: RequestDeleteHeartbeatInput,
  deps: DeleteHeartbeatDeps,
): Promise<void> {
  const confirmed = await deps.confirm(
    resolveDeleteScheduleDialog({ productName: "Heartbeat", title: input.title }),
  );
  if (!confirmed) {
    return;
  }
  try {
    await deps.deleteHeartbeat({ serverId: input.serverId, scheduleId: input.scheduleId });
  } catch (error) {
    deps.reportError(error);
  }
}
