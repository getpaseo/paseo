import { density } from "@/styles/density";
import { SPACING } from "@/styles/theme";
import {
  resolveContentBandPlacement,
  type ContentBandInsets,
} from "@/components/headers/content-band-geometry.shared";
import type { BottomBarGeometry } from "@/components/headers/bottom-bar-geometry.shared";

export const SIDEBAR_FOOTER_GROUP_GAP = SPACING[6];
export const SIDEBAR_FOOTER_HORIZONTAL_PADDING = SPACING[2];
export const SIDEBAR_FOOTER_ROW_PADDING = SPACING[1.5];
export const SIDEBAR_FOOTER_MIN_BUTTON_WIDTH = density.iconButton.md;

const SIDEBAR_FOOTER_BUTTON_COUNT = 5;
export const SIDEBAR_FOOTER_MIN_CONTENT_WIDTH =
  SIDEBAR_FOOTER_BUTTON_COUNT * SIDEBAR_FOOTER_MIN_BUTTON_WIDTH + SIDEBAR_FOOTER_GROUP_GAP;

export function resolveSidebarFooterBarLayout(input: {
  geometry: BottomBarGeometry | null;
  safeAreaBottom: number;
}): {
  edgeInsets: ContentBandInsets | undefined;
  bottomPadding: number;
  available: boolean;
  requiredMinimumWidth: number | undefined;
} {
  const { geometry } = input;
  const placement = geometry?.horizontal
    ? resolveContentBandPlacement({
        width: geometry.bounds.width,
        height: geometry.bar.height,
        ...geometry.horizontal,
        minimumInsets: {
          left: SIDEBAR_FOOTER_HORIZONTAL_PADDING,
          right: SIDEBAR_FOOTER_HORIZONTAL_PADDING,
        },
        minimumContentWidth: SIDEBAR_FOOTER_MIN_CONTENT_WIDTH,
        direction: "up",
      })
    : null;
  const edgeInsets = placement?.kind === "placed" ? placement.insets : undefined;
  let requiredMinimumWidth: number | undefined;
  if (placement?.kind === "placed") {
    requiredMinimumWidth =
      SIDEBAR_FOOTER_MIN_CONTENT_WIDTH + placement.insets.left + placement.insets.right;
  } else if (placement?.kind === "unavailable" && placement.availableWidth > 0 && geometry) {
    requiredMinimumWidth =
      geometry.bounds.width + placement.requiredWidth - placement.availableWidth;
  }
  return {
    edgeInsets,
    bottomPadding: geometry
      ? Math.max(0, geometry.bounds.height - geometry.bar.y - geometry.bar.height) -
        (placement?.kind === "placed" ? placement.offsetY : 0)
      : input.safeAreaBottom,
    available: placement?.kind !== "unavailable",
    requiredMinimumWidth,
  };
}

export function resolveSidebarFooterKeyboardSpacing(input: {
  keyboardHeight: number;
  layoutShift: number;
  restingBottom: number;
}): number {
  "worklet";
  // Ignore accessory-only reports, but follow full keyboard motion from its first frame.
  return input.layoutShift > 0
    ? Math.max(0, Math.abs(input.keyboardHeight) - input.restingBottom)
    : 0;
}

export function resolveSidebarFooterLayout(input: {
  width: number;
  buttonSize: number;
  edgeInsets: ContentBandInsets;
}): {
  buttonWidth: number;
  paddingLeft: number;
  paddingRight: number;
  minimumWidth: number;
} {
  const paddingLeft = Math.max(SIDEBAR_FOOTER_HORIZONTAL_PADDING, input.edgeInsets.left);
  const paddingRight = Math.max(SIDEBAR_FOOTER_HORIZONTAL_PADDING, input.edgeInsets.right);
  const availableButtonWidth =
    (input.width - paddingLeft - paddingRight - SIDEBAR_FOOTER_GROUP_GAP) /
    SIDEBAR_FOOTER_BUTTON_COUNT;
  const buttonWidth = Math.max(
    SIDEBAR_FOOTER_MIN_BUTTON_WIDTH,
    Math.min(input.buttonSize, availableButtonWidth),
  );

  return {
    buttonWidth,
    paddingLeft,
    paddingRight,
    minimumWidth:
      SIDEBAR_FOOTER_BUTTON_COUNT * SIDEBAR_FOOTER_MIN_BUTTON_WIDTH +
      SIDEBAR_FOOTER_GROUP_GAP +
      paddingLeft +
      paddingRight,
  };
}
