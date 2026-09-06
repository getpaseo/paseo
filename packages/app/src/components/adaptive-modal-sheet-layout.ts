export interface CompactSheetSafeAreaPaddingInput {
  isCompact: boolean;
  isKeyboardVisible: boolean;
  hasFooter: boolean;
  safeAreaBottom: number;
}

export interface CompactSheetSafeAreaPadding {
  contentPaddingBottom?: number;
  footerPaddingBottom?: number;
}

interface BottomSheetVisibleContentHeightInput {
  containerHeight: number;
  contentPosition: number;
  handleHeight: number;
  keyboardHeight: number;
  isKeyboardVisible: boolean;
}

export function getBottomSheetVisibleContentHeight({
  containerHeight,
  contentPosition,
  handleHeight,
  keyboardHeight,
  isKeyboardVisible,
}: BottomSheetVisibleContentHeightInput): number {
  "worklet";
  return Math.max(
    0,
    containerHeight - contentPosition - handleHeight - (isKeyboardVisible ? keyboardHeight : 0),
  );
}

export function getCompactSheetSafeAreaPadding({
  isCompact,
  isKeyboardVisible,
  hasFooter,
  safeAreaBottom,
}: CompactSheetSafeAreaPaddingInput): CompactSheetSafeAreaPadding {
  if (!isCompact || isKeyboardVisible || safeAreaBottom <= 0) {
    return {};
  }

  if (hasFooter) {
    return { footerPaddingBottom: safeAreaBottom };
  }

  return { contentPaddingBottom: safeAreaBottom };
}
