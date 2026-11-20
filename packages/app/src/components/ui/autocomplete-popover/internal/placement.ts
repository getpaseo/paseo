import type { ReactNode } from "react";
import type { View } from "react-native";
import type { AnimatedRef, DerivedValue } from "react-native-reanimated";
import { SPACING } from "@/styles/theme";

const OFFSET_FROM_ANCHOR = SPACING[3];

/** The anchor's resting rect, relative to the portal host the popover renders in. */
export interface AnchorAtRest {
  x: number;
  y: number;
  width: number;
  height: number;
  hostHeight: number;
}

export interface PopoverFrameProps {
  anchorRef: AnimatedRef<View>;
  /** Taken asynchronously; the frame follows the anchor's live size between measurements. */
  anchorAtRest: AnchorAtRest;
  reservedLift: DerivedValue<number>;
  topInset: number;
  children: ReactNode;
}

/** Places the popover above an anchor whose top edge is `anchorTop` within the host. */
export function placeAboveAnchor(input: {
  anchorTop: number;
  hostHeight: number;
  reservedLift: number;
  topInset: number;
}): { bottom: number; maxHeight: number } {
  "worklet";
  return {
    bottom: input.hostHeight - input.anchorTop + OFFSET_FROM_ANCHOR,
    maxHeight: Math.max(
      0,
      input.anchorTop - input.reservedLift - input.topInset - OFFSET_FROM_ANCHOR * 2,
    ),
  };
}
