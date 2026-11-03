import type { SurfaceBackdrop } from "@/styles/surface-backdrop";

/** The surface a tab rail paints: a pane header or the Explorer sidebar. */
export type WorkspaceTabRailSurface = "surface" | "sidebar";

/**
 * The fill of a tab chip, named as the surface token it paints so the chip style and everything
 * knocking out of it (the running-status ring, the trailing-action scrim) agree.
 *
 * Each rail climbs its own ladder: resting, filled (hovered, or active in an unfocused pane),
 * selected. The sidebar rail uses the sidebar hover/selected tokens rather than the plain surface
 * steps because light themes paint `surfaceSidebar` with `surface2`, so a `surface2` chip vanishes
 * on it.
 */
export function resolveWorkspaceTabChipBackdrop({
  rail,
  isActiveFocused,
  isFilled,
}: {
  rail: WorkspaceTabRailSurface;
  isActiveFocused: boolean;
  isFilled: boolean;
}): SurfaceBackdrop {
  if (rail === "sidebar") {
    if (isActiveFocused) return "surfaceSidebarSelected";
    return isFilled ? "surfaceSidebarHover" : "surfaceSidebar";
  }
  if (isActiveFocused) return "surface2";
  return isFilled ? "surface1" : "surface0";
}
