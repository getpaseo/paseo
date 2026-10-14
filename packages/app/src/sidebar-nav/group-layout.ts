/** Share of the window height the top sidebar group may take before it scrolls. */
export const SIDEBAR_NAV_GROUP_MAX_HEIGHT_FRACTION = 1 / 3;

/**
 * One compact row. Below this the group would show nothing at all, which reads as a
 * broken sidebar rather than a tight one.
 */
export const SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT = 36;

/**
 * The tallest the top sidebar group's rows may render before they scroll inside the
 * group, so plugin contributions never push the workspace list off the sidebar.
 *
 * The contract is exactly a third of the window at every height the app runs at; the
 * floor only answers a viewport of a few pixels, which is a measurement artefact
 * rather than a layout.
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
