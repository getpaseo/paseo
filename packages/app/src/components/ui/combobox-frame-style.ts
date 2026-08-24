import type { StyleProp, ViewStyle } from "react-native";

export interface DesktopFrameStyleInput {
  desktopMinWidth: number | undefined;
  desktopLockWidth: boolean;
  referenceWidth: number | null;
  desktopFixedHeight: number | undefined;
  desktopPositionStyle: StyleProp<ViewStyle>;
  shouldHideDesktopContent: boolean;
  availableHeight: number | undefined;
}

export function buildDesktopFrameStyle(input: DesktopFrameStyleInput): StyleProp<ViewStyle> {
  const {
    desktopMinWidth,
    desktopLockWidth,
    referenceWidth,
    desktopFixedHeight,
    desktopPositionStyle,
    shouldHideDesktopContent,
    availableHeight,
  } = input;
  const fixedHeightStyle =
    desktopFixedHeight != null
      ? { minHeight: desktopFixedHeight, maxHeight: desktopFixedHeight }
      : null;
  const hiddenStyle = shouldHideDesktopContent ? { opacity: 0 } : null;
  const availableHeightStyle =
    typeof availableHeight === "number"
      ? { maxHeight: Math.min(availableHeight, desktopFixedHeight ?? 400) }
      : null;
  const floor = Math.max(desktopMinWidth ?? 0, referenceWidth ?? 200);
  const widthStyle = desktopLockWidth
    ? { width: floor, minWidth: floor, maxWidth: floor }
    : { minWidth: floor, maxWidth: Math.max(400, floor) };
  return [
    {
      position: "absolute" as const,
      ...widthStyle,
    },
    fixedHeightStyle,
    desktopPositionStyle,
    hiddenStyle,
    availableHeightStyle,
  ];
}
