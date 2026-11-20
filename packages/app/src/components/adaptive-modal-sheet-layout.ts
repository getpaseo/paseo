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
