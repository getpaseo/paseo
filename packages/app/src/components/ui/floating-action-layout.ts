import { SPACING } from "@/styles/theme";

export const FLOATING_ACTION_BUTTON_SIZE = 56;
export const FLOATING_ACTION_BUTTON_INSET = SPACING[4];
export const FLOATING_ACTION_BUTTON_CLEARANCE =
  FLOATING_ACTION_BUTTON_SIZE + FLOATING_ACTION_BUTTON_INSET;

/** Reserve the stacked actions and the safe-area inset once for their scrolling surface. */
export function floatingActionsClearance(
  actionClearances: readonly number[],
  bottomInset: number,
): number {
  const clearance = actionClearances.reduce((total, action) => total + action, 0);
  return clearance > 0 ? clearance + bottomInset : 0;
}
