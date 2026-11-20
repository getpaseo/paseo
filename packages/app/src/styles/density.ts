import {
  bySizing,
  iconSizeFor,
  TOOLBAR_CONTROL_HEIGHT,
  TOUCH_TARGET,
  type IconSize,
} from "@/components/ui/control-geometry";
import { isCompactBreakpoint } from "@/constants/layout";
import type { Theme } from "@/styles/theme";

/**
 * Density sizes for surfaces that opt into touch sizing: rows and icons take their touch sizes
 * where controls do (see `resolveControlSizing`) and their pointer sizes elsewhere. Plain theme
 * tokens stay pointer-sized everywhere, so a surface migrates by swapping its sizes for these.
 *
 * Style values are Unistyles breakpoint values, resolved inside `StyleSheet.create`. Icon sizes
 * are props, so icons take them through `DensityIcon` or a `densityIconProps` mapping.
 */

export type DensityIconSize = IconSize;

export const density = {
  /** A list row such as a sidebar entry. */
  rowHeight: bySizing({ touch: TOUCH_TARGET, pointer: 36 }),
  /** A row in a tight group, such as the sidebar's navigation rows. Touch-sized it is a full row. */
  tightRowHeight: bySizing({ touch: TOUCH_TARGET, pointer: 28 }),
  /** A square icon-only button that sits in a row or toolbar. */
  iconButton: TOOLBAR_CONTROL_HEIGHT,
  /**
   * The space between two blocks of rich text, such as Markdown paragraphs, code and images.
   * Reading rhythm, not a touch target, so it follows the layout alone.
   */
  blockGap: { xs: 12, md: 16 },
};

/** Resolves a density value for a prop, which Unistyles cannot resolve on its own. */
export function resolveDensity<T>(rt: { breakpoint?: string }, value: { xs: T; md: T }): T {
  return isCompactBreakpoint(rt.breakpoint) ? value.xs : value.md;
}

/** The width or height of a slot that holds an icon of `size`. */
export function densityIconBox(size: DensityIconSize) {
  return bySizing(iconSizeFor(size));
}

export function densityIconSize(rt: { breakpoint?: string }, size: DensityIconSize): number {
  return resolveDensity(rt, densityIconBox(size));
}

/** Extends a `withUnistyles` icon mapping so the icon also takes its density size. */
export function densityIconProps<P extends object>(
  size: DensityIconSize,
  mapping: (theme: Theme) => P,
) {
  return (theme: Theme, rt: { breakpoint?: string }) => ({
    ...mapping(theme),
    size: densityIconSize(rt, size),
  });
}
