import type { View, ViewStyle } from "react-native";

/**
 * Where a floating surface goes relative to the thing that opened it. Menus, hover cards, and
 * tooltips place themselves with it.
 */

export type Placement = "top" | "bottom" | "left" | "right";
export type Alignment = "start" | "center" | "end";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Gap kept between the surface and the edge of the display area. */
const EDGE_PADDING = 8;

export function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

/**
 * A surface asked to open below the trigger flips above it when it doesn't fit below *and*
 * there is more room above. Both conditions matter: flipping into a side that is equally
 * cramped just moves the clipping, so a surface taller than the whole viewport stays put.
 *
 * Horizontal flipping is opt-in for hover cards. Submenus choose their direction up front so
 * they do not move out from under the pointer travelling toward them.
 */
function flipPlacement(input: {
  placement: Placement;
  triggerRect: Rect;
  contentHeight: number;
  contentWidth: number;
  flipHorizontal: boolean;
  displayArea: Rect;
}): Placement {
  const { placement, triggerRect, contentHeight, displayArea } = input;
  const spaceTop = triggerRect.y - displayArea.y;
  const spaceBottom = displayArea.y + displayArea.height - (triggerRect.y + triggerRect.height);

  if (placement === "bottom" && spaceBottom < contentHeight && spaceTop > spaceBottom) {
    return "top";
  }
  if (placement === "top" && spaceTop < contentHeight && spaceBottom > spaceTop) {
    return "bottom";
  }
  if (input.flipHorizontal) {
    const spaceLeft = triggerRect.x - displayArea.x;
    const spaceRight = displayArea.x + displayArea.width - (triggerRect.x + triggerRect.width);
    if (placement === "right" && spaceRight < input.contentWidth && spaceLeft > spaceRight)
      return "left";
    if (placement === "left" && spaceLeft < input.contentWidth && spaceRight > spaceLeft)
      return "right";
  }
  return placement;
}

/** Where the surface's top-left corner lands, before it is pulled back inside the display area. */
function anchorToPlacement(input: {
  placement: Placement;
  triggerRect: Rect;
  contentSize: Size;
  alignment: Alignment;
  offset: number;
}): { x: number; y: number } {
  const { placement, triggerRect, contentSize, alignment, offset } = input;

  if (placement === "left") {
    return { x: triggerRect.x - contentSize.width - offset, y: triggerRect.y };
  }
  if (placement === "right") {
    return { x: triggerRect.x + triggerRect.width + offset, y: triggerRect.y };
  }

  const y =
    placement === "bottom"
      ? triggerRect.y + triggerRect.height + offset
      : triggerRect.y - contentSize.height - offset;

  // Vertical placements align horizontally against the trigger; side placements sit flush
  // with its top edge and ignore alignment entirely.
  if (alignment === "start") {
    return { x: triggerRect.x, y };
  }
  if (alignment === "end") {
    return { x: triggerRect.x + triggerRect.width - contentSize.width, y };
  }
  return { x: triggerRect.x + (triggerRect.width - contentSize.width) / 2, y };
}

function clampToDisplayArea(input: {
  x: number;
  y: number;
  contentSize: Size;
  displayArea: Rect;
}): { x: number; y: number } {
  const { x, y, contentSize, displayArea } = input;
  return {
    x: Math.max(
      displayArea.x + EDGE_PADDING,
      Math.min(displayArea.x + displayArea.width - contentSize.width - EDGE_PADDING, x),
    ),
    y: Math.max(
      displayArea.y + EDGE_PADDING,
      Math.min(displayArea.y + displayArea.height - contentSize.height - EDGE_PADDING, y),
    ),
  };
}

export interface SurfaceWidth {
  width?: number;
  minWidth?: number;
  maxWidth?: number;
}

/**
 * Caps a surface's requested width to the display. Position clamping can move a surface but not
 * shrink it, so a menu wider than a narrow screen would otherwise hang off the far edge.
 */
export function fitSurfaceWidth(requested: SurfaceWidth, displayWidth: number): SurfaceWidth {
  const available = Math.max(displayWidth - EDGE_PADDING * 2, 0);
  const cap = (value: number | undefined) =>
    typeof value === "number" ? Math.min(value, available) : undefined;
  return {
    width: cap(requested.width),
    minWidth: cap(requested.minWidth),
    maxWidth: cap(requested.maxWidth) ?? available,
  };
}

export function computePosition({
  triggerRect,
  contentSize,
  displayArea,
  placement,
  alignment,
  offset,
  flipHorizontal = false,
}: {
  triggerRect: Rect;
  contentSize: Size;
  displayArea: Rect;
  placement: Placement;
  alignment: Alignment;
  offset: number;
  /** Hover cards can choose either side; submenu direction is owned by the menu. */
  flipHorizontal?: boolean;
}): { x: number; y: number; actualPlacement: Placement } {
  const actualPlacement = flipPlacement({
    placement,
    triggerRect,
    contentHeight: contentSize.height,
    contentWidth: contentSize.width,
    flipHorizontal,
    displayArea,
  });
  const anchored = anchorToPlacement({
    placement: actualPlacement,
    triggerRect,
    contentSize,
    alignment,
    offset,
  });
  return { ...clampToDisplayArea({ ...anchored, contentSize, displayArea }), actualPlacement };
}

/** Where a placed surface sits: its left edge, and the edge that holds it vertically. */
export type SurfacePosition = { left: number; top: number } | { left: number; bottomEdge: number };

/**
 * A surface above its trigger is held by its bottom edge, the edge that faces the trigger. When
 * its content grows after it paints, it extends upward, away from the trigger. Held by its top,
 * it would paint over the trigger until the next placement lands, a frame later on native.
 */
export function holdSurfaceEdge(
  placed: { x: number; y: number; actualPlacement: Placement },
  contentHeight: number,
): SurfacePosition {
  if (placed.actualPlacement === "top") {
    return { left: placed.x, bottomEdge: placed.y + contentHeight };
  }
  return { left: placed.x, top: placed.y };
}

/**
 * Styles for a surface and the holder it sits in. Both fill the display area's width, so the
 * surface lays out exactly as it would without the holder. Render the holder with the
 * `pointerEvents="box-none"` prop so presses outside the surface reach what is behind it;
 * react-native-web drops `box-none` given as an inline style. A bottom-held surface sits on the
 * bottom of a holder that ends at its bottom edge, so layout keeps that edge in place however
 * the content changes. Until it is placed, the surface waits off-screen to be measured.
 */
export function surfaceFrameStyles(position: SurfacePosition | null): {
  holder: ViewStyle;
  surface: ViewStyle;
} {
  const fill: ViewStyle = { position: "absolute", top: 0, left: 0, right: 0 };
  if (!position) {
    return {
      holder: { ...fill, bottom: 0 },
      surface: { position: "absolute", top: -9999, left: -9999 },
    };
  }
  if ("top" in position) {
    return {
      holder: { ...fill, bottom: 0 },
      surface: { position: "absolute", top: position.top, left: position.left },
    };
  }
  return {
    holder: { ...fill, height: position.bottomEdge },
    surface: { position: "absolute", bottom: 0, left: position.left },
  };
}

export function getTransformOrigin(
  placement: Placement,
  alignment: Alignment,
): [number | string, number | string, number] {
  let vertical: number | string;
  if (placement === "bottom") vertical = 0;
  else if (placement === "top") vertical = "100%";
  else vertical = "50%";

  let horizontal: number | string;
  if (alignment === "start") horizontal = 0;
  else if (alignment === "end") horizontal = "100%";
  else horizontal = "50%";

  // Native theme updates can bypass RN's JS string preprocessing. Supply the native
  // array shape directly; Reanimated's web style builder also accepts this form.
  return [horizontal, vertical, 0];
}
