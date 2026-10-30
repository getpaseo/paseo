import type { StyleProp, ViewStyle } from "react-native";

export interface ContentBandRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContentBandInsets {
  left: number;
  right: number;
}

export interface ContentBandGeometry {
  bounds: ContentBandRect;
  placementBounds: ContentBandRect;
  margins: ContentBandInsets;
  exclusions: readonly ContentBandRect[];
}

export interface ContentBandGeometryProbeProps {
  style: StyleProp<ViewStyle>;
  onGeometryChange: (geometry: ContentBandGeometry) => void;
}

interface ContentBandInterval {
  left: number;
  right: number;
}

export type ContentBandPlacement =
  | { kind: "placed"; insets: ContentBandInsets; offsetY: number; availableWidth: number }
  | { kind: "unavailable"; availableWidth: number; requiredWidth: number };

interface ContentBandPlacementInput {
  width: number;
  height: number;
  placementBounds: ContentBandRect;
  margins: ContentBandInsets;
  minimumInsets: ContentBandInsets;
  minimumContentWidth: number;
  exclusions: readonly ContentBandRect[];
  direction: "up" | "down";
}

function availableInterval(input: ContentBandPlacementInput, offsetY: number): ContentBandInterval {
  const left = Math.max(input.minimumInsets.left, input.margins.left);
  const right = Math.max(
    left,
    input.width - Math.max(input.minimumInsets.right, input.margins.right),
  );
  const blocked = input.exclusions
    .filter(
      (frame) =>
        frame.width > 0 &&
        frame.height > 0 &&
        frame.y < offsetY + input.height &&
        frame.y + frame.height > offsetY &&
        frame.x < right &&
        frame.x + frame.width > left,
    )
    .sort((a, b) => a.x - b.x);
  let cursor = left;
  let best = { left, right: left };
  for (const frame of blocked) {
    const start = Math.max(left, frame.x);
    if (start - cursor > best.right - best.left) best = { left: cursor, right: start };
    cursor = Math.max(cursor, Math.min(right, frame.x + frame.width));
  }
  if (right - cursor > best.right - best.left) best = { left: cursor, right };
  return best;
}

export function resolveContentBandPlacement(
  input: ContentBandPlacementInput,
): ContentBandPlacement {
  const { placementBounds, height, direction } = input;
  const minY = placementBounds.y;
  const maxY = placementBounds.y + placementBounds.height - height;
  const candidates = [Math.max(minY, Math.min(0, maxY))];
  for (const frame of input.exclusions) {
    candidates.push(direction === "down" ? frame.y + frame.height : frame.y - height);
  }
  candidates.sort((a, b) => (direction === "down" ? a - b : b - a));
  let availableWidth = 0;
  for (const offsetY of candidates) {
    if (offsetY < minY || offsetY > maxY) continue;
    if (direction === "down" ? offsetY < 0 : offsetY > 0) continue;
    const interval = availableInterval(input, offsetY);
    const width = interval.right - interval.left;
    availableWidth = Math.max(availableWidth, width);
    if (width < input.minimumContentWidth) continue;
    return {
      kind: "placed",
      insets: { left: interval.left, right: Math.max(0, input.width - interval.right) },
      offsetY,
      availableWidth: width,
    };
  }
  return { kind: "unavailable", availableWidth, requiredWidth: input.minimumContentWidth };
}

export function resolveLeadingCornerControlInset(input: {
  leadingCornerInset: number;
  requiresLeadingCornerSlot: boolean;
  leadingOffset: number;
  rowHeight: number;
  horizontalPadding: number;
  leftInset: number;
}): number {
  const cornerSlot = input.requiresLeadingCornerSlot ? input.rowHeight : 0;
  return Math.max(
    0,
    Math.max(input.leadingCornerInset, cornerSlot) -
      input.leadingOffset -
      input.leftInset -
      input.horizontalPadding,
  );
}
