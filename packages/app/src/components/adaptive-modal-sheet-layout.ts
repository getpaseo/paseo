export interface CompactSheetSafeAreaPaddingInput {
  isCompact: boolean;
  hasFooter: boolean;
  baseContentPadding: number;
  baseFooterPadding: number;
  safeAreaBottom: number;
}

export interface CompactSheetSafeAreaPadding {
  contentPaddingBottom?: number;
  footerPaddingBottom?: number;
}

export function getCompactSheetSafeAreaPadding({
  isCompact,
  hasFooter,
  baseContentPadding,
  baseFooterPadding,
  safeAreaBottom,
}: CompactSheetSafeAreaPaddingInput): CompactSheetSafeAreaPadding {
  if (!isCompact || safeAreaBottom <= 0) {
    return {};
  }

  if (hasFooter) {
    return { footerPaddingBottom: baseFooterPadding + safeAreaBottom };
  }

  return { contentPaddingBottom: baseContentPadding + safeAreaBottom };
}
