export function nativeHistoryStartGeometry(input: {
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
  topOverlayInset: number;
}) {
  const contentHeight = input.contentHeight - 32 - input.topOverlayInset;
  return {
    distanceFromHistoryStart: Math.max(0, input.offsetY - input.topOverlayInset - 32),
    isUnderfilled: contentHeight < input.viewportHeight,
  };
}
