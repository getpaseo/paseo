import type { ScheduleProductName } from "@/utils/schedule-format";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface ResolveDeleteScheduleDialogInput {
  productName: ScheduleProductName;
  title: string;
}

/**
 * Deleting a schedule is one decision, so it reads the same wherever it is
 * offered — the Schedules list and the agent heartbeat track both ask this.
 */
export function resolveDeleteScheduleDialog(
  input: ResolveDeleteScheduleDialogInput,
): ConfirmDialogInput {
  const productName = input.productName.toLowerCase();
  return {
    title: `Delete ${productName}`,
    message: `Delete "${input.title}"? This cannot be undone.`,
    confirmLabel: "Delete",
    destructive: true,
  };
}
