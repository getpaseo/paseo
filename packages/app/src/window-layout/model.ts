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
