/** Shared geometry for menu rows and controls that align with them. */
import { density } from "@/styles/density";
import type { Theme } from "@/styles/theme";

/** A menu row is a tight row: touch-sized wherever controls are (see `resolveControlSizing`). */
export const MENU_ITEM_HEIGHT = density.tightRowHeight;

/**
 * How far a menu row's label sits from the surface's edge: the row's margin, padding and border
 * (see `item` in `menu-item.tsx`). Content that shares a menu surface with rows starts here.
 */
export function menuLabelInset(theme: Theme): number {
  return theme.spacing[1] + theme.spacing[2] + theme.borderWidth[1];
}
