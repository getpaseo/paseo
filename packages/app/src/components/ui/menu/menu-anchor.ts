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
 * Only the vertical placements flip. A left/right submenu that doesn't fit is handled by the
 * caller choosing its side up front, because flipping it mid-open would move the surface out
 * from under the pointer that is travelling toward it.
 */
function flipPlacement(input: {
  placement: Placement;
  triggerRect: Rect;
  contentHeight: number;
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
    contentHeight: contentSize.height,
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
