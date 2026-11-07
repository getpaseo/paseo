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
  /**
   * Points from the window's bottom edge to where a bottom bar rests, or null where
   * the system has no bottom bar guide. Zero is a measured value.
   */
  bottomClearance?: number | null;
  /** Where a top bar rests, or null until the system resolves its top bar guide. */
  topBar?: WindowLayoutRect | null;
  /** Active system occlusions (status region, camera, Live Activities), margins included. */
  occlusions?: WindowLayoutRect[];
  divisions: WindowLayoutRect[];
}

/**
 * The band above the rectangular safe area that a top bar may use because the system
 * occupies only part of it. Content outside a top-edge row still keeps out of `occlusions`.
 */
export interface TopBand {
  top: number;
  occlusions: readonly WindowLayoutRect[];
}

/** Null unless the top bar guide starts above the system's rectangular safe area. */
export function resolveTopBand(systemTop: number, layout: WindowLayout | null): TopBand | null {
  const bar = layout?.topBar;
  if (!layout || !bar || bar.y >= systemTop) return null;
  return { top: Math.max(0, bar.y), occlusions: layout.occlusions ?? [] };
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

export interface TopBandClearance {
  /** Points the row's trailing controls keep from its trailing edge. */
  trailing: number;
  /** Points the row moves down when its controls cannot fit beside the occlusions. */
  top: number;
}

export const NO_TOP_BAND_CLEARANCE: TopBandClearance = { trailing: 0, top: 0 };

/**
 * How a top-edge row keeps its controls out of the system occlusions it overlaps: trim its
 * trailing side to the leftmost occlusion, or, when `minimumWidth` no longer fits, start
 * below the occlusions. `row` is the row's frame without any clearance, in window points.
 */
export function resolveTopBandClearance(input: {
  row: WindowLayoutRect;
  occlusions: readonly WindowLayoutRect[];
  minimumWidth: number;
}): TopBandClearance {
  const { row, occlusions, minimumWidth } = input;
  const overlapping = occlusions.filter((frame) => overlaps(frame, row));
  if (overlapping.length === 0) return NO_TOP_BAND_CLEARANCE;
  const trailing = Math.ceil(row.x + row.width - Math.min(...overlapping.map((frame) => frame.x)));
  if (row.width - trailing >= minimumWidth) return { trailing, top: 0 };
  const bottom = Math.max(...overlapping.map((frame) => frame.y + frame.height));
  return { trailing: 0, top: Math.ceil(bottom - row.y) };
}

function overlaps(a: WindowLayoutRect, b: WindowLayoutRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
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
