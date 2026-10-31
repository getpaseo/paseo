export function nativeHistoryStartGeometry(input: {
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
  topOverlayInset: number;
  bottomPadding: number;
}) {
  const contentHeight = input.contentHeight - 32 - input.topOverlayInset - input.bottomPadding;
  return {
    distanceFromHistoryStart: contentHeight - input.viewportHeight - input.offsetY,
    isUnderfilled: contentHeight < input.viewportHeight,
  };
}
