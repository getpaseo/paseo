import { isCompactBreakpoint } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/**
 * Density sizes for surfaces that opt into touch sizing: rows and icons grow on compact
 * layouts and keep their desktop sizes from the `md` breakpoint up. Plain theme tokens stay
 * desktop-sized everywhere, so a surface migrates by swapping its sizes for these.
 *
 * Style values are Unistyles breakpoint values, resolved inside `StyleSheet.create`. Icon sizes
 * are props, so icons take them through `DensityIcon` or a `densityIconProps` mapping.
 */

export type DensityIconSize = keyof typeof ICON_SIZE;

const COMPACT_ICON_SIZE: Record<DensityIconSize, number> = { xs: 14, sm: 18, md: 20, lg: 24 };

// Compact layouts end where `md` begins; see `isCompactBreakpoint`.
function byLayout<T>(compact: T, desktop: T) {
  return { xs: compact, md: desktop };
}

export const density = {
  /** A list row such as a sidebar entry. */
  rowHeight: byLayout(44, 36),
  /** A row in a tight group, such as the sidebar's navigation rows. */
  tightRowHeight: byLayout(36, 28),
  /** A square icon-only button that sits in a row or toolbar. */
  iconButton: byLayout(44, 28),
};

/** The width or height of a slot that holds an icon of `size`. */
export function densityIconBox(size: DensityIconSize) {
  return byLayout(COMPACT_ICON_SIZE[size], ICON_SIZE[size]);
}

export function densityIconSize(rt: { breakpoint?: string }, size: DensityIconSize): number {
  return isCompactBreakpoint(rt.breakpoint) ? COMPACT_ICON_SIZE[size] : ICON_SIZE[size];
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
