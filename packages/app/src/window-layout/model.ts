export interface WindowLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLayout {
  bounds: WindowLayoutRect;
  verticalBarEdge: "none" | "leading" | "trailing";
  verticalBar: WindowLayoutRect | null;
  /** The status bar's frame in window coordinates, or null where the system reports none. */
  statusBar?: WindowLayoutRect | null;
  /** "disabled" while the app has turned the vertical bar off; absent on older builds. */
  verticalBarBehavior?: "automatic" | "disabled";
  /**
   * Points from the window's bottom edge to where a bottom bar rests, or null where
   * the system has no bottom bar guide. Zero is a measured value.
   */
  bottomClearance?: number | null;
  /** Where a top bar rests, or null until the system resolves its top bar guide. */
  topBar?: WindowLayoutRect | null;
  /**
   * Regions system elements draw over (status region, camera, Live Activities), in window
   * coordinates with margins included. Absent on older builds.
   */
  occlusions?: WindowLayoutRect[];
  divisions: WindowLayoutRect[];
}

/**
 * The band above the rectangular safe area that a top bar may use because the system
 * occupies only its trailing end, like window controls on a desktop title bar.
 */
export interface TopBand {
  /** Where the top bar starts, in window points. */
  top: number;
  /**
   * The system region past the bar's trailing end, measured from the band's top, or null
   * when the bar reaches the window's trailing edge.
   */
  trailingObstruction: { width: number; height: number } | null;
}

/** Null unless the top bar guide starts above the system's rectangular safe area. */
export function resolveTopBand(systemTop: number, layout: WindowLayout | null): TopBand | null {
  const bar = layout?.topBar;
  if (!layout || !bar || bar.y >= systemTop) return null;
  const top = Math.max(0, bar.y);
  const barEnd = bar.x + bar.width;
  const width = Math.ceil(layout.bounds.width - barEnd);
  if (width <= 0) return { top, trailingObstruction: null };
  const beside = (layout.occlusions ?? []).filter(
    (frame) => frame.x + frame.width > barEnd && frame.y < bar.y + bar.height,
  );
  const bottom = Math.max(bar.y + bar.height, ...beside.map((frame) => frame.y + frame.height));
  return { top, trailingObstruction: { width, height: Math.ceil(bottom - top) } };
}

/**
 * The window's measured bars replace the rectangular safe area: the bottom bar's clearance,
 * and the top bar's start when it sits above the system top.
 */
export function resolveSafeAreaInsets<Insets extends { top: number; bottom: number }>(
  systemInsets: Insets,
  layout: WindowLayout | null,
): Insets {
  const clearance = layout?.bottomClearance;
  const bottom = typeof clearance === "number" ? clearance : systemInsets.bottom;
  const top = resolveTopBand(systemInsets.top, layout)?.top ?? systemInsets.top;
  return top === systemInsets.top && bottom === systemInsets.bottom
    ? systemInsets
    : { ...systemInsets, top, bottom };
}

/** Gap between a header beside the status bar and the status bar's leading edge. */
const STATUS_BAR_GAP = 8;

/**
 * With the vertical bar off, a status bar drawn as a pill at the top right leaves the rest of the
 * top row free: the header moves into it, ending before the pill. A full-width status bar, or none,
 * keeps the header below the top inset.
 */
export function resolveHeaderBesideStatusBar(
  layout: WindowLayout | null,
  rowHeight: number,
): { top: number; right: number } | null {
  if (!layout || layout.verticalBarBehavior !== "disabled") return null;
  const bar = resolveTopRightPill(layout);
  if (!bar) return null;
  const width = layout.bounds.width;
  return {
    top: Math.max(0, bar.y + (bar.height - rowHeight) / 2),
    right: Math.max(0, width - bar.x) + STATUS_BAR_GAP,
  };
}

/** Below this much of the window's height, an element counts as part of the top row. */
const TOP_ROW_LIMIT = 120;

function isTopRightPill(frame: WindowLayoutRect, width: number): boolean {
  return (
    frame.width > 0 && frame.width < width * 0.6 && frame.x >= width / 2 && frame.y < TOP_ROW_LIMIT
  );
}

/**
 * The status pill at the top right: the occluded region UIKit reports there, else a status bar
 * frame that is itself a pill. iOS can report the status bar as a full-width strip.
 */
function resolveTopRightPill(layout: WindowLayout): WindowLayoutRect | null {
  const width = layout.bounds.width;
  const pills = (layout.occlusions ?? []).filter((frame) => isTopRightPill(frame, width));
  if (pills.length > 0) {
    const x = Math.min(...pills.map((frame) => frame.x));
    const y = Math.min(...pills.map((frame) => frame.y));
    const maxY = Math.max(...pills.map((frame) => frame.y + frame.height));
    return { x, y, width: width - x, height: maxY - y };
  }
  const bar = layout.statusBar;
  return bar && isTopRightPill(bar, width) ? bar : null;
}

export interface DesktopDivisionLayout {
  sidebarWidth: number;
  gap: number;
  contentWidth: number;
}

export function resolveWorkspaceActionPlacement(
  layout: WindowLayout | null,
): "header" | "vertical-bar" {
  return layout?.verticalBarEdge === "trailing" && layout.verticalBar !== null
    ? "vertical-bar"
    : "header";
}

export function resolveWorkspaceBarActions(
  headerVariant: "compact" | "full",
): readonly ("tab-count" | "overflow" | "explorer")[] {
  return headerVariant === "compact"
    ? ["tab-count", "overflow", "explorer"]
    : ["overflow", "explorer"];
}

/** One book-like partition owns allocation; horizontal folds retain the normal flow. */
export function resolveDesktopDivisionLayout(input: {
  geometry: WindowLayout | null;
  windowWidth: number;
  windowHeight: number;
  leftInset: number;
  rightInset: number;
}): DesktopDivisionLayout | null {
  const { geometry, windowWidth, windowHeight, leftInset, rightInset } = input;
  if (
    !geometry ||
    Math.abs(geometry.bounds.width - windowWidth) > 0.5 ||
    Math.abs(geometry.bounds.height - windowHeight) > 0.5
  )
    return null;
  const divisions = geometry.divisions.filter(
    (frame) =>
      frame.width > 0 &&
      frame.height > frame.width &&
      frame.y < windowHeight &&
      frame.y + frame.height > 0,
  );
  if (divisions.length !== 1) return null;
  const division = divisions[0];
  const sidebarWidth = division.x - leftInset;
  const contentWidth = windowWidth - rightInset - division.x - division.width;
  if (sidebarWidth <= 0 || contentWidth <= 0) return null;
  return { sidebarWidth, gap: division.width, contentWidth };
}
