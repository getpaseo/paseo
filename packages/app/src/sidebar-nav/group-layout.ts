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

/**
 * The most of the window a dragged group may take. The default share leaves the
 * workspace list the bulk of the sidebar; dragging past half of it would put the
 * navigation rows where the workspaces belong.
 */
export const SIDEBAR_NAV_GROUP_DRAGGED_MAX_HEIGHT_FRACTION = 1 / 2;

/** The group's own header, `sidebarFooter`, and one workspace row. */
const SIDEBAR_NAV_GROUP_HEADER_HEIGHT = 36;
const SIDEBAR_FOOTER_HEIGHT = 57;

/**
 * The sidebar chrome a dragged group has to leave behind. Half of a short window is
 * more than the sidebar can spare, and the list below would reach zero height.
 */
export const SIDEBAR_NAV_GROUP_CHROME_RESERVE =
  SIDEBAR_NAV_GROUP_HEADER_HEIGHT + SIDEBAR_FOOTER_HEIGHT + SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT;

/**
 * The height the group's rows render at: what the owner dragged it to, or the default
 * share of the window until they drag it.
 */
export function resolveSidebarNavGroupHeight(input: {
  requestedHeight: number | null;
  viewportHeight: number;
}): number {
  const defaultHeight = resolveSidebarNavGroupMaxHeight(input.viewportHeight);
  if (input.requestedHeight === null || !Number.isFinite(input.requestedHeight)) {
    return defaultHeight;
  }
  const viewportHeight = Number.isFinite(input.viewportHeight)
    ? Math.max(input.viewportHeight, 0)
    : 0;
  // The default share is the floor: dragging may never cost the list more than not
  // dragging at all, however short the window is.
  const maximum = Math.max(
    defaultHeight,
    Math.min(
      Math.round(viewportHeight * SIDEBAR_NAV_GROUP_DRAGGED_MAX_HEIGHT_FRACTION),
      viewportHeight - SIDEBAR_NAV_GROUP_CHROME_RESERVE,
    ),
  );
  return Math.min(
    maximum,
    Math.max(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT, Math.round(input.requestedHeight)),
  );
}
