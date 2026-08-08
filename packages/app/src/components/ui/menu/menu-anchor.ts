import type { View } from "react-native";

/**
 * Where a floating menu surface goes relative to the thing that opened it.
 *
 * This was two byte-identical copies, one in `dropdown-menu.tsx` and one in `context-menu.tsx`.
 * Submenus need a third caller, so it lives here now and the menus import it.
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
 * Side placements flip on the same terms. A submenu opens to the right by default, which is
 * fine until its parent is anchored near the right edge — then there is nowhere to put it and
 * edge clamping drags it back over the row that opened it. Flipping to the left is the only
 * placement that fits.
 *
 * This is decided once, from the trigger rect and the measured content, and those do not change
 * while a flyout is open. The hazard the caller-picks-a-side rule guarded against was re-deciding
 * mid-hover and moving the surface out from under a pointer travelling toward it; a stable
 * decision taken before the surface is placed cannot do that.
 */
function flipPlacement(input: {
  placement: Placement;
  triggerRect: Rect;
  contentSize: Size;
  displayArea: Rect;
}): Placement {
  const { placement, triggerRect, contentSize, displayArea } = input;
  const spaceTop = triggerRect.y - displayArea.y;
  const spaceBottom = displayArea.y + displayArea.height - (triggerRect.y + triggerRect.height);
  const spaceLeft = triggerRect.x - displayArea.x;
  const spaceRight = displayArea.x + displayArea.width - (triggerRect.x + triggerRect.width);

  if (placement === "bottom" && spaceBottom < contentSize.height && spaceTop > spaceBottom) {
    return "top";
  }
  if (placement === "top" && spaceTop < contentSize.height && spaceBottom > spaceTop) {
    return "bottom";
  }
  if (placement === "right" && spaceRight < contentSize.width && spaceLeft > spaceRight) {
    return "left";
  }
  if (placement === "left" && spaceLeft < contentSize.width && spaceRight > spaceLeft) {
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

export function computePosition({
  triggerRect,
  contentSize,
  displayArea,
  placement,
  alignment,
  offset,
}: {
  triggerRect: Rect;
  contentSize: Size;
  displayArea: Rect;
  placement: Placement;
  alignment: Alignment;
  offset: number;
}): { x: number; y: number; actualPlacement: Placement } {
  const actualPlacement = flipPlacement({
    placement,
    triggerRect,
    contentSize,
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

export function getTransformOrigin(placement: Placement, alignment: Alignment): string {
  let vertical: string;
  if (placement === "bottom") vertical = "top";
  else if (placement === "top") vertical = "bottom";
  else vertical = "center";

  let horizontal: string;
  if (alignment === "start") horizontal = "left";
  else if (alignment === "end") horizontal = "right";
  else horizontal = "center";

  // React Native parses transform-origin positionally (x then y), unlike CSS
  // which accepts keyword pairs in either order.
  return `${horizontal} ${vertical}`;
}
