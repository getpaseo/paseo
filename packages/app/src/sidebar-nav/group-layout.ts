/** Share of the window height the top sidebar group may take before it scrolls. */
export const SIDEBAR_NAV_GROUP_MAX_HEIGHT_FRACTION = 1 / 3;

/** Three compact rows, so the cap never hides the group behind its own header. */
export const SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT = 96;

/**
 * The tallest the top sidebar group's rows may render before they scroll inside the
 * group, so plugin contributions never push the workspace list off the sidebar.
 */
export function resolveSidebarNavGroupMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT;
  }
  return Math.max(
    SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT,
    Math.round(viewportHeight * SIDEBAR_NAV_GROUP_MAX_HEIGHT_FRACTION),
  );
}
